import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AgentSession, type AgentEvent, type ChatMessage, type ConsentCard, type ConsentField, type ToolPolicy } from "exfer-agent";
import { useT, type Lang, type MsgKey } from "../lib/i18n";
import { hostDeps, inTauri, confirmConsent } from "../lib/agentHost";
import { AgentSettings } from "../components/agent/AgentSettings";
import { McpManager } from "../components/agent/McpManager";
import { Markdown, CopyChip } from "../components/agent/Markdown";
import { Conversations } from "../components/agent/Conversations";
import { loadConfig, toProviderConfig, hasApiKey } from "../lib/agentConfig";
import { formatExfer } from "../lib/rpc";
import { humanizeError } from "../lib/errors";
import {
  ensureActive,
  listConversations,
  createConversation,
  setActive as setActiveConv,
  saveMessages,
  renameConversation,
  deleteConversation,
  type Conversation,
  type ConvMessage,
} from "../lib/conversationStore";

// In-wallet AI agent chat (desktop). Lives in the desktop app (its own look);
// the shared headless loop comes from `exfer-agent`. Drives AgentSession.send()
// and reduces the AgentEvent stream into a wallet-styled conversation. Every
// money-moving tool pauses on the confirmation card before it runs.

interface ToolCard {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  summary?: string;
  gated: boolean;
}
// A read-only research sub-agent's nested transcript. We replay the forwarded
// child AgentEvents into the same text/tool block shape so it renders like a
// miniature turn, indented under the parent.
interface SubAgent {
  id: string;
  task: string;
  done: boolean;
  blocks: Block[];
}
type Block = { kind: "text"; text: string } | { kind: "tool"; card: ToolCard } | { kind: "subagent"; sub: SubAgent };
interface Turn {
  role: "user" | "assistant";
  text?: string; // user turns
  thinking?: string;
  blocks: Block[]; // assistant turns, ordered text/tool/subagent
}
interface PendingConsent {
  card: ConsentCard;
  resolve: (ok: boolean) => void;
  prevFocus: Element | null;
}

const Spinner = () => (
  <svg className="h-3.5 w-3.5 animate-spin text-cyan-300" viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
    <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2Z" />
  </svg>
);

// App SVG check / x — replaces the raw ✓/✕ glyphs so the status mark renders
// crisply at any zoom and matches the rest of the wallet's iconography.
const CheckIcon = () => (
  <svg className="h-3.5 w-3.5 text-emerald-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
    <path d="m5 13 4 4L19 7" />
  </svg>
);
const XIcon = () => (
  <svg className="h-3.5 w-3.5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
// A small chevron that rotates with a <details open> via the group-open utility.
const Caret = () => (
  <svg className="h-3 w-3 shrink-0 text-neutral-500 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

/** Format a swap quote (stashed from exfer_swap_get_quote) into consent fields. */
function swapFields(q: Record<string, unknown>): ConsentField[] {
  const dir = String(q.direction ?? "");
  const pretty = dir === "bnb_to_exfer" ? "BNB → EXFER" : dir === "exfer_to_bnb" ? "EXFER → BNB" : dir;
  const payUnit = dir === "bnb_to_exfer" ? "BNB" : "EXFER";
  const getUnit = dir === "bnb_to_exfer" ? "EXFER" : "BNB";
  return [
    { label: "Direction", labelKey: "direction", value: pretty },
    { label: "You pay", labelKey: "you_pay", value: `${q.amount_in} ${payUnit}` },
    { label: "You receive", labelKey: "you_receive", value: `≈ ${q.amount_out} ${getUnit}` },
    { label: "Fee", labelKey: "fee", value: q.fee_bps != null ? `${Number(q.fee_bps) / 100}%` : "" },
  ];
}

type Tr = ReturnType<typeof useT>["t"];

// Friendly, localized label for a tool, so the card header reads like an action,
// not a slug. Known tools go through agent.toolLabel.*; anything new falls back
// to the de-prefixed, spaced name.
function toolLabel(name: string, t: Tr): string {
  const key = `agent.toolLabel.${name}` as MsgKey;
  const label = t(key);
  // t() returns the key's EN fallback or "" on a miss; treat an unchanged key as a miss.
  if (label && label !== key) return label;
  return name.replace(/^exfer_/, "").replace(/_/g, " ");
}

// Tools whose result is summarized into a dedicated humanized one-liner. For
// these the raw JSON adds nothing the user needs, so we suppress the Details
// disclosure; default/unknown tools (and errors) still expose it.
const SUMMARIZED_TOOLS = new Set([
  "exfer_get_balance",
  "exfer_list_addresses",
  "exfer_generate_address",
  "exfer_simulate_transfer",
  "exfer_transfer",
  "exfer_swap_get_quote",
  "exfer_swap_execute",
  "exfer_payment_uri_encode",
  "exfer_network_status",
  "exfer_network_hashrate",
  "exfer_get_block",
  "exfer_get_transaction",
  "exfer_earn_pool_stats",
]);

/** Compact a hashrate in H/s to a human string (kH/s, MH/s, …). */
function fmtHashrate(hs: number): string {
  if (!Number.isFinite(hs) || hs <= 0) return `${hs} H/s`;
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
  let v = hs;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)} ${units[i]}`;
}

/** Shorten a long hash for inline display. */
function shortHash(h: unknown): string {
  const s = String(h ?? "");
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
}

/** A human one-liner for a tool result; the raw JSON stays behind a disclosure
 *  (when shown). Localized via agent.tool.* keys. */
function humanizeTool(name: string, summary: string, t: Tr): string {
  try {
    const r = JSON.parse(summary) as Record<string, unknown>;
    switch (name) {
      case "exfer_get_balance":
        return t("agent.tool.balance", { value: formatExfer(Number(r.balance)) });
      case "exfer_list_addresses": {
        const n = Array.isArray(r) ? r.length : Array.isArray((r as { addresses?: unknown[] }).addresses) ? (r as { addresses: unknown[] }).addresses.length : 1;
        return t("agent.tool.addressCount", { n });
      }
      case "exfer_generate_address":
        return r.address ? t("agent.tool.newAddress", { address: `${String(r.address).slice(0, 10)}…${String(r.address).slice(-6)}` }) : t("agent.tool.addressCreated");
      case "exfer_simulate_transfer":
        return t("agent.tool.previewFee", { fee: formatExfer(Number(r.fee ?? 0)) });
      case "exfer_transfer":
        return t("agent.tool.submittedFee", { fee: formatExfer(Number(r.fee ?? 0)), tx: `${String(r.tx_id ?? "").slice(0, 12)}…` });
      case "exfer_swap_get_quote":
        return r.fee_bps != null
          ? t("agent.tool.quoteFee", { in: String(r.amount_in), out: String(r.amount_out), fee: `${Number(r.fee_bps) / 100}%` })
          : t("agent.tool.quote", { in: String(r.amount_in), out: String(r.amount_out) });
      case "exfer_swap_execute":
        return t("agent.tool.swapStarted", { id: String(r.swap_id ?? ""), state: String(r.state ?? "") });
      case "exfer_payment_uri_encode":
        return String(r.uri ?? summary);
      case "exfer_network_status":
        return t("agent.tool.networkStatus", {
          network: String(r.network ?? "exfer"),
          height: String(r.tip_height ?? r.height ?? "?"),
          peers: String(r.peer_count ?? r.peers ?? 0),
          mempool: String(r.mempool_size ?? 0),
        });
      case "exfer_network_hashrate":
        return t("agent.tool.networkHashrate", {
          hashrate: fmtHashrate(Number(r.est_hashrate_hs ?? 0)),
          difficulty: String(r.difficulty ?? "?"),
        });
      case "exfer_get_block": {
        const txs = Array.isArray(r.transactions) ? r.transactions.length : Number(r.tx_count ?? r.num_transactions ?? 0);
        return t("agent.tool.block", { height: String(r.height ?? "?"), txs: String(txs), id: shortHash(r.block_id ?? r.id ?? r.hash) });
      }
      case "exfer_get_transaction": {
        const ins = Array.isArray(r.inputs) ? r.inputs.length : Number(r.input_count ?? 0);
        const outs = Array.isArray(r.outputs) ? r.outputs.length : Number(r.output_count ?? 0);
        return t("agent.tool.transaction", { id: shortHash(r.tx_id ?? r.id ?? r.txid), inputs: String(ins), outputs: String(outs) });
      }
      case "exfer_earn_pool_stats": {
        // The MCP tool returns a curated dict (EXFER units already), not the raw pool API.
        return t("agent.tool.poolStats", {
          accrued: Number(r.accrued_exfer ?? 0).toFixed(4),
          threshold: Number(r.payout_threshold_exfer ?? 0).toFixed(4),
          remaining: Number(r.remaining_to_payout_exfer ?? 0).toFixed(4),
          hashrate: fmtHashrate(Number(r.hashrate_hs ?? 0)),
          status: r.online === false ? t("agent.tool.poolOffline") : t("agent.tool.poolOnline"),
        });
      }
      default:
        return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
    }
  } catch {
    return summary;
  }
}

/** Fold a forwarded child AgentEvent into a sub-agent's block list (pure: returns
 *  a fresh array). The child is read-only, so we only need text + tool blocks;
 *  it can never spawn its own sub-agent, so those variants are ignored. */
function applyChildEvent(blocks: Block[], ev: AgentEvent): Block[] {
  const next = blocks.slice();
  switch (ev.type) {
    case "text_delta": {
      const i = next.length - 1;
      const tail = next[i];
      if (tail?.kind === "text") next[i] = { kind: "text", text: tail.text + ev.text };
      else next.push({ kind: "text", text: ev.text });
      return next;
    }
    case "tool_call_started":
      next.push({ kind: "tool", card: { id: ev.id, name: ev.name, args: ev.args, status: "running", gated: ev.consentClass !== "auto" } });
      return next;
    case "tool_result": {
      const i = next.findIndex((b) => b.kind === "tool" && b.card.id === ev.id);
      if (i >= 0) {
        const b = next[i] as { kind: "tool"; card: ToolCard };
        next[i] = { kind: "tool", card: { ...b.card, status: ev.ok ? "ok" : "error", summary: ev.summary } };
      }
      return next;
    }
    default:
      return next; // thinking/consent/turn_done/nested-subagent: not surfaced in the nested view
  }
}

// Turns persist to the conversation store as opaque ConvMessage blocks; the
// store round-trips them unchanged, so these are just structural casts.
const toConvMessages = (turns: Turn[]): ConvMessage[] => turns.map((tn) => ({ role: tn.role, text: tn.text, thinking: tn.thinking, blocks: tn.blocks }));
const fromConvMessages = (msgs: ConvMessage[]): Turn[] => msgs.map((m) => ({ role: m.role, text: m.text, thinking: m.thinking, blocks: (m.blocks as Block[]) ?? [] }));
// Seed the LLM session from a persisted transcript so a switched-to conversation
// keeps its context. Only the plain text of each turn is replayed (tool results
// re-derive on demand; the core re-summarizes from text history).
const toInitialMessages = (turns: Turn[]): ChatMessage[] =>
  turns
    .map((tn): ChatMessage => {
      if (tn.role === "user") return { role: "user", content: tn.text ?? "" };
      const content = tn.blocks.filter((b): b is { kind: "text"; text: string } => b.kind === "text").map((b) => b.text).join("");
      return { role: "assistant", content };
    })
    .filter((m) => m.content.trim() !== "");

export function Agent({ lang }: { lang: Lang }) {
  const { t } = useT();
  // Active conversation drives the seed; the list backs the switcher popover.
  const [active, setActiveState] = useState<Conversation>(() => ensureActive());
  const [convList, setConvList] = useState<Conversation[]>(() => listConversations().conversations);
  const [turns, setTurns] = useState<Turn[]>(() => fromConvMessages(active.messages));
  const [showConvs, setShowConvs] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<PendingConsent | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [cfgVersion, setCfgVersion] = useState(0);
  const [policy, setPolicy] = useState<ToolPolicy | undefined>(undefined);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastQuoteRef = useRef<Record<string, unknown> | null>(null);
  const lastUserText = useRef<string>("");
  const activeIdRef = useRef<string>(active.id);
  activeIdRef.current = active.id;
  // The live pending consent resolver, so a conversation switch can fail-closed
  // any dangling money confirmation (resolve(false)) before tearing down.
  const consentRef = useRef<PendingConsent | null>(null);
  consentRef.current = consent;

  const refreshConvList = useCallback(() => setConvList(listConversations().conversations), []);

  // Flush the current transcript to the active conversation. Called at every turn
  // boundary (turn_done / error) and on switch, never mid-stream. Reads the
  // latest turns through a no-op functional setState so a flush right after the
  // stream loop can't persist a stale snapshot before React commits the last
  // delta.
  const flushSnapshot = useCallback(() => {
    setTurns((latest) => {
      const messages = toConvMessages(latest);
      saveMessages(activeIdRef.current, messages);
      // Mirror into the active conv object too, so a session rebuild on a
      // [lang/cfgVersion/policy] change re-seeds from the CURRENT transcript
      // (not the stale snapshot captured when the conversation was opened).
      setActiveState((a) => (a.id === activeIdRef.current ? { ...a, messages } : a));
      return latest;
    });
    refreshConvList();
  }, [refreshConvList]);

  // Whether a usable LLM key is configured. Drives the no-key nudge so we never
  // silently fall through to the scripted mock without telling the user.
  useEffect(() => {
    let live = true;
    const saved = loadConfig();
    if (!saved) {
      setNeedsKey(true);
      return;
    }
    hasApiKey(saved.id)
      .then((has) => {
        if (live) setNeedsKey(!has);
      })
      .catch(() => {
        if (live) setNeedsKey(true);
      });
    return () => {
      live = false;
    };
  }, [cfgVersion]);

  // The merged consent policy spans every enabled MCP server, so it must be
  // refetched whenever the config/server set changes. getPolicy is async; we
  // resolve it into state and rebuild the session once it lands (the session
  // falls back to EXFER_POLICY until then — fail-closed, never looser).
  useEffect(() => {
    let live = true;
    const saved = loadConfig();
    const cfg = saved ? toProviderConfig(saved) : undefined;
    const { tools } = hostDeps(cfg);
    void tools
      .getPolicy?.()
      .then((p) => {
        if (live) setPolicy(p);
      })
      .catch(() => {
        /* keep prior/undefined → EXFER_POLICY fallback */
      });
    return () => {
      live = false;
    };
  }, [cfgVersion]);

  const session = useMemo(() => {
    const saved = loadConfig();
    const cfg = saved ? toProviderConfig(saved) : undefined;
    const { provider, tools } = hostDeps(cfg);
    return new AgentSession({
      provider,
      model: saved?.model ?? "deepseek-chat",
      listTools: tools.listTools,
      executeTool: tools.executeTool,
      policy,
      // Seed the LLM context from the active conversation so a config change
      // (lang/provider/policy) rebuilds the session WITHOUT losing the thread.
      initialMessages: toInitialMessages(fromConvMessages(active.messages)),
      requestConsent: (req) =>
        new Promise<boolean>((resolve) => {
          // Enrich the swap card with the economics from the preceding quote —
          // but only if the quote is for THIS swap_id (never show one swap's
          // economics for another).
          let card = req.card;
          if (card.toolName === "exfer_swap_execute") {
            const q = lastQuoteRef.current;
            const idField = card.fields.find((f) => f.labelKey === "swap_id");
            if (q && idField && String(q.swap_id) === String(idField.value)) {
              card = { ...card, fields: [...swapFields(q), ...card.fields] };
            }
          }
          setConsent({ card, resolve, prevFocus: document.activeElement });
        }),
      systemPrompt:
        "You are the exfer wallet agent. Use tools to fulfil the user's request; the app shows a confirmation card for any money move, so never ask the user to confirm or remind them that they must approve. " +
        "Be concise: lead with the answer, skip preamble and recap, and don't narrate which tool you're about to call. Format with Markdown — short paragraphs, bullet lists, and a table when presenting balances or a quote. " +
        `Always respond in ${lang === "zh" ? "Chinese (简体中文)" : "English"}.`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgVersion, lang, policy, active.id]);

  // Auto-scroll only when the user is already near the bottom (don't yank them
  // away while they re-read an address mid-stream).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Auto-grow the composer from 1 row up to a ~6-row cap (then it scrolls).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 24; // matches the .input line box; 6 rows ≈ 144px + padding
    const max = lineHeight * 6 + 16;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [input]);

  const patchLast = useCallback((fn: (t: Turn) => void) => {
    setTurns((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice();
      const last = { ...next[next.length - 1], blocks: next[next.length - 1].blocks.slice() };
      fn(last);
      next[next.length - 1] = last;
      return next;
    });
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return;
      lastUserText.current = text;
      setErrorBanner(null);
      setInput("");
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      setTurns((p) => [...p, { role: "user", text, blocks: [] }, { role: "assistant", blocks: [] }]);
      try {
        for await (const ev of session.send(text, controller.signal) as AsyncIterable<AgentEvent>) {
          switch (ev.type) {
            case "thinking_delta":
              patchLast((tn) => (tn.thinking = (tn.thinking ?? "") + ev.text));
              break;
            case "text_delta":
              // Pure: replace the tail block, never mutate a shared object
              // (StrictMode double-invokes reducers).
              patchLast((tn) => {
                const i = tn.blocks.length - 1;
                const tail = tn.blocks[i];
                if (tail?.kind === "text") tn.blocks[i] = { kind: "text", text: tail.text + ev.text };
                else tn.blocks.push({ kind: "text", text: ev.text });
              });
              break;
            case "tool_call_started":
              patchLast((tn) =>
                tn.blocks.push({ kind: "tool", card: { id: ev.id, name: ev.name, args: ev.args, status: "running", gated: ev.consentClass !== "auto" } }),
              );
              break;
            case "tool_result":
              if (ev.name === "exfer_swap_get_quote" && ev.ok) {
                try {
                  lastQuoteRef.current = JSON.parse(ev.summary) as Record<string, unknown>;
                } catch {
                  /* ignore */
                }
              }
              if (ev.name === "exfer_swap_execute") lastQuoteRef.current = null; // consumed
              patchLast((tn) => {
                const i = tn.blocks.findIndex((b) => b.kind === "tool" && b.card.id === ev.id);
                if (i >= 0) {
                  const b = tn.blocks[i] as { kind: "tool"; card: ToolCard };
                  tn.blocks[i] = { kind: "tool", card: { ...b.card, status: ev.ok ? "ok" : "error", summary: ev.summary } };
                }
              });
              break;
            case "subagent_started":
              patchLast((tn) => tn.blocks.push({ kind: "subagent", sub: { id: ev.id, task: ev.task, done: false, blocks: [] } }));
              break;
            case "subagent_event":
              patchLast((tn) => {
                const i = tn.blocks.findIndex((b) => b.kind === "subagent" && b.sub.id === ev.id);
                if (i < 0) return;
                const b = tn.blocks[i] as { kind: "subagent"; sub: SubAgent };
                const blocks = applyChildEvent(b.sub.blocks, ev.event);
                tn.blocks[i] = { kind: "subagent", sub: { ...b.sub, blocks } };
              });
              break;
            case "subagent_done":
              patchLast((tn) => {
                const i = tn.blocks.findIndex((b) => b.kind === "subagent" && b.sub.id === ev.id);
                if (i < 0) return;
                const b = tn.blocks[i] as { kind: "subagent"; sub: SubAgent };
                tn.blocks[i] = { kind: "subagent", sub: { ...b.sub, done: true } };
              });
              break;
            case "error":
              // Friendly, localized message in the bubble; raw stays behind a
              // disclosure (never a stack-trace-shaped string up top).
              setErrorBanner(ev.message);
              break;
          }
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        flushSnapshot();
      }
    },
    [busy, session, patchLast, flushSnapshot],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // Regenerate the last assistant turn: drop it, resend the last user text.
  const regenerate = useCallback(() => {
    if (busy || !lastUserText.current) return;
    setTurns((prev) => {
      // Strip trailing assistant turn so send() appends a fresh pair.
      const next = prev.slice();
      while (next.length && next[next.length - 1].role === "assistant") next.pop();
      if (next.length && next[next.length - 1].role === "user") next.pop();
      return next;
    });
    void send(lastUserText.current);
  }, [busy, send]);

  // ── multi-session controls ──────────────────────────────────────────
  const newChat = useCallback(() => {
    if (busy) return;
    flushSnapshot();
    const conv = createConversation();
    setActiveState(conv);
    setTurns([]);
    setErrorBanner(null);
    refreshConvList();
    setShowConvs(false);
  }, [busy, flushSnapshot, refreshConvList]);

  const switchTo = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) {
        setShowConvs(false);
        return;
      }
      if (busy) return; // block switch while a turn is streaming
      // Fail-closed any dangling money confirmation before leaving.
      if (consentRef.current) {
        consentRef.current.resolve(false);
        setConsent(null);
      }
      flushSnapshot();
      const next = listConversations().conversations.find((c) => c.id === id);
      if (!next) return;
      setActiveConv(id);
      setActiveState(next);
      setTurns(fromConvMessages(next.messages));
      setErrorBanner(null);
      setShowConvs(false);
    },
    [busy, flushSnapshot],
  );

  const onRename = useCallback(
    (id: string, title: string) => {
      renameConversation(id, title);
      refreshConvList();
      if (id === activeIdRef.current) setActiveState((a) => ({ ...a, title: title.trim() || null }));
    },
    [refreshConvList],
  );

  const onDelete = useCallback(
    (id: string) => {
      const nextActiveId = deleteConversation(id);
      refreshConvList();
      if (id === activeIdRef.current) {
        const next = listConversations().conversations.find((c) => c.id === nextActiveId) ?? ensureActive();
        setActiveConv(next.id);
        setActiveState(next);
        setTurns(fromConvMessages(next.messages));
        setErrorBanner(null);
      }
    },
    [refreshConvList],
  );

  // In the installed app, a missing LLM key must NOT silently fall through to the
  // scripted mock — disable the composer until a real provider key is configured.
  // The mock stays reachable only in browser-dev (!inTauri) for headless QA.
  const gateComposer = inTauri() && needsKey;
  const examples = [t("agent.empty.ex1"), t("agent.empty.ex2"), t("agent.empty.ex3"), t("agent.empty.ex4")];
  const convTitle = active.title ?? t("agent.conv.untitled");

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <button
          type="button"
          className="group flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left hover:bg-neutral-900/60"
          onClick={() => {
            refreshConvList();
            setShowConvs(true);
          }}
          title={t("agent.conv.open")}
          aria-label={t("agent.conv.open")}
          data-testid="agent-conv-open"
        >
          <span className="truncate text-lg font-semibold tracking-tight text-neutral-100">{convTitle}</span>
          <svg className="h-4 w-4 shrink-0 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className="btn-ghost px-2 py-1" title={t("agent.conv.new")} aria-label={t("agent.conv.new")} onClick={newChat} disabled={busy} data-testid="agent-new-chat">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button type="button" className="btn-ghost px-2 py-1" title={t("agent.mcp.open")} aria-label={t("agent.mcp.open")} onClick={() => setShowMcp(true)} data-testid="agent-mcp-open">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </button>
          <button type="button" className="btn-ghost px-2 py-1" title={t("agent.settings.open")} aria-label={t("agent.settings.open")} onClick={() => setShowSettings(true)} data-testid="agent-settings-open">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="agent-scroll flex-1 space-y-4 overflow-y-auto overflow-x-hidden">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-5 text-center fade-in">
            <div className="space-y-2">
              <h2 className="text-3xl font-semibold text-neutral-100">{t("agent.empty.title")}</h2>
              <p className="text-sm text-neutral-500">{t("agent.empty.subtitle")}</p>
            </div>
            {needsKey ? (
              <div className="banner-info max-w-sm space-y-2 text-left" data-testid="agent-nokey">
                <p className="font-medium">{t("agent.empty.noKeyTitle")}</p>
                <p className="text-cyan-100/80">{t("agent.empty.noKeyBody")}</p>
                <button type="button" className="btn-ghost px-2 py-1 text-cyan-200" onClick={() => setShowSettings(true)} data-testid="agent-nokey-cta">
                  {t("agent.empty.noKeyCta")}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wide text-neutral-600">{t("agent.empty.tryTitle")}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {examples.map((ex) => (
                    <button key={ex} type="button" onClick={() => setInput(ex)} className="suggestion-chip" data-testid="agent-example">
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="max-w-sm text-xs leading-relaxed text-neutral-600">{t("agent.empty.safety")}</p>
          </div>
        )}

        {turns.map((tn, i) =>
          tn.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl bg-cyan-500/15 px-4 py-2 text-sm text-cyan-50">{tn.text}</div>
            </div>
          ) : (
            <div key={i} className="space-y-2 fade-in" data-testid="assistant-turn">
              {tn.thinking && <ThinkingBlock thinking={tn.thinking} streaming={busy && i === turns.length - 1} hasText={tn.blocks.some((b) => b.kind === "text" && b.text)} t={t} />}
              {tn.blocks.map((b, j) =>
                b.kind === "text" ? (
                  b.text ? (
                    <Markdown key={j} source={b.text} />
                  ) : null
                ) : b.kind === "tool" ? (
                  <ToolCardView key={j} card={b.card} t={t} />
                ) : (
                  <SubAgentView key={j} sub={b.sub} t={t} />
                ),
              )}
              {busy && i === turns.length - 1 && !tn.blocks.length && <Spinner />}
              {/* Regenerate the last answer once the turn is done (not streaming). */}
              {!busy && i === turns.length - 1 && tn.blocks.some((b) => b.kind === "text" && b.text) && lastUserText.current && (
                <button type="button" className="btn-ghost px-2 py-1 text-xs text-neutral-500" onClick={regenerate} data-testid="agent-regenerate">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                    <path d="M21 3v5h-5" />
                    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                    <path d="M3 21v-5h5" />
                  </svg>
                  {t("agent.error.retry")}
                </button>
              )}
            </div>
          ),
        )}
      </div>

      {errorBanner && (
        <div className="banner-error mt-3 space-y-2" role="alert" data-testid="agent-error">
          <div className="flex items-center justify-between gap-3">
            <span>{humanizeError(errorBanner)}</span>
            <button type="button" className="btn-ghost shrink-0" onClick={() => send(lastUserText.current)}>
              {t("agent.error.retry")}
            </button>
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-red-300/70">{t("agent.error.rawDetails")}</summary>
            <pre className="mono mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-red-200/70">{errorBanner}</pre>
          </details>
        </div>
      )}

      <div className="mt-4 flex items-end gap-2">
        {gateComposer ? (
          // No LLM key: a clean prompt (message + CTA) that fills the row, instead
          // of a dead disabled input + a cramped button. Opens LLM settings.
          <div className="banner-info flex flex-1 items-center justify-between gap-3">
            <span className="text-sm text-cyan-100/80">{t("agent.empty.noKeyTitle")}</span>
            <button type="button" className="btn shrink-0" onClick={() => setShowSettings(true)} data-testid="agent-send">
              {t("agent.empty.noKeyCta")}
            </button>
          </div>
        ) : (
          <>
            <textarea
              ref={inputRef}
              rows={1}
              className="input flex-1 resize-none overflow-y-auto"
              placeholder={t("agent.composer.placeholder")}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is a newline. Guard the IME: a Chinese
                // (or any) composition confirm fires Enter too, and must never send.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(input);
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                  // Cmd/Ctrl+Enter is an explicit send alias.
                  e.preventDefault();
                  send(input);
                } else if (e.key === "ArrowUp" && input === "" && lastUserText.current) {
                  // Empty composer + ArrowUp recalls the last sent message to edit.
                  e.preventDefault();
                  setInput(lastUserText.current);
                }
              }}
              data-testid="agent-input"
            />
            {busy ? (
              <button type="button" className="btn-secondary" onClick={stop} data-testid="agent-stop">
                {t("agent.composer.stop")}
              </button>
            ) : (
              <button type="button" className="btn" disabled={!input.trim()} onClick={() => send(input)} data-testid="agent-send">
                {t("agent.composer.send")}
              </button>
            )}
          </>
        )}
      </div>

      {consent && (
        <ConfirmationCard
          card={consent.card}
          t={t}
          onResolve={(ok) => {
            const prev = consent.prevFocus;
            consent.resolve(ok);
            setConsent(null);
            if (prev instanceof HTMLElement) prev.focus();
          }}
        />
      )}

      {showConvs && (
        <Conversations
          conversations={convList}
          activeId={active.id}
          busy={busy}
          onSelect={switchTo}
          onRename={onRename}
          onDelete={onDelete}
          onClose={() => setShowConvs(false)}
        />
      )}

      {showSettings && (
        <AgentSettings
          onClose={(saved) => {
            setShowSettings(false);
            if (saved) setCfgVersion((v) => v + 1);
          }}
        />
      )}

      {showMcp && (
        <McpManager
          onClose={() => {
            setShowMcp(false);
            // Server set may have changed → re-merge policy and rebuild the session.
            setCfgVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}

// Thinking: a single low-chrome inline caret + label by default (no full box).
// It auto-collapses once text starts streaming, so the reasoning trace never
// dominates the answer.
function ThinkingBlock({ thinking, streaming, hasText, t }: { thinking: string; streaming: boolean; hasText: boolean; t: Tr }) {
  const open = streaming && !hasText;
  return (
    <details open={open} className="group text-xs text-neutral-500" data-testid="thinking-block">
      <summary className="flex cursor-pointer select-none items-center gap-1.5">
        <Caret />
        {streaming && !hasText && <Spinner />}
        <span>{streaming && !hasText ? t("agent.thinking.active") : t("agent.thinking.label")}</span>
      </summary>
      <div className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-800 pl-3 text-neutral-500">{thinking}</div>
    </details>
  );
}

function SubAgentView({ sub, t }: { sub: SubAgent; t: Tr }) {
  // Default-collapse a completed sub-agent so its transcript doesn't bury the
  // parent answer; keep it open while running. The accent rail groups it, so the
  // inner blocks carry no extra card border. Header shows status OR task — never
  // both restated.
  return (
    <details open={!sub.done} className="group rounded-lg border-l-2 border-cyan-500/40 bg-neutral-900/40 pl-3 pr-2 py-2" data-testid="subagent-block">
      <summary className="flex cursor-pointer select-none items-center gap-2 text-xs">
        <Caret />
        {!sub.done && <Spinner />}
        <span className="text-cyan-300">{sub.done ? t("agent.subagent.done") : t("agent.subagent.running")}</span>
        {!sub.done && <span className="truncate text-neutral-500">· {sub.task}</span>}
      </summary>
      <div className="mt-2 space-y-2">
        {sub.blocks.map((b, j) =>
          b.kind === "text" ? (
            b.text ? (
              <Markdown key={j} source={b.text} />
            ) : null
          ) : b.kind === "tool" ? (
            <ToolCardView key={j} card={b.card} t={t} />
          ) : null,
        )}
      </div>
    </details>
  );
}

function ToolCardView({ card, t }: { card: ToolCard; t: Tr }) {
  const declined = card.summary === "declined";
  // walletd errors come back as non-isError content, so the status alone can read
  // "ok" on a failed call. Sniff an error shape too — never a green check on a failure.
  // Match an error VALUE, not the JSON field name: swap results carry an
  // `"error":null` field on SUCCESS, and a bare /\berror\b/ flagged those as
  // failed. Real failures still set card.status==="error" (isError) or carry a
  // string error value / plain-text error phrase, all still matched below.
  const errored = card.status === "error" || (!!card.summary && !declined && /("error"\s*:\s*"[^"]|invalid params|\bfailed\b|code\s*-?\d|no [\w/]+ key|seedless)/i.test(card.summary));
  const statusText = card.status === "running" ? t("agent.tool.running", { name: toolLabel(card.name, t) }) : errored ? t("agent.tool.failed") : t("agent.tool.done");
  // Suppress the raw Details for tools with a dedicated humanized one-liner —
  // unless the call errored (then the raw text IS the useful info).
  const showDetails = !!card.summary && !declined && (errored || !SUMMARIZED_TOOLS.has(card.name));
  return (
    <div className="card-chat overflow-hidden px-3 py-2 text-sm" data-testid="tool-card">
      <div className="flex items-center gap-2" role="status">
        {card.status === "running" ? <Spinner /> : errored ? <XIcon /> : <CheckIcon />}
        <span className="truncate text-[13px] font-medium text-neutral-200">{toolLabel(card.name, t)}</span>
        {card.gated && <span className="pill pill-warn shrink-0">{t("agent.tool.gated")}</span>}
        <span className="sr-only">{statusText}</span>
      </div>
      {card.summary &&
        (declined ? (
          <div className="mt-1 text-xs text-amber-300">{t("agent.consent.declined")}</div>
        ) : (
          <>
            <div className="mt-1 break-words text-[13px] text-neutral-200">{humanizeTool(card.name, card.summary, t)}</div>
            {showDetails && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] text-neutral-500">{t("agent.tool.details")}</summary>
                <pre className="mono mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-neutral-950/60 p-2 text-[11px] text-neutral-400">{card.summary}</pre>
              </details>
            )}
          </>
        ))}
    </div>
  );
}

function ConfirmationCard({ card, t, onResolve }: { card: ConsentCard; t: Tr; onResolve: (ok: boolean) => void }) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  const [passphrase, setPassphrase] = useState("");
  const [authError, setAuthError] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const needAuth = inTauri(); // desktop: passphrase re-entry; browser-dev: pass-through

  useEffect(() => {
    declineRef.current?.focus(); // safe default
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onResolve(false);
      if (e.key !== "Tab") return;
      // Full focus trap over every focusable in the dialog (incl. Copy + the
      // passphrase field), not just the two buttons.
      const root = dialogRef.current;
      if (!root) return;
      const f = [...root.querySelectorAll<HTMLElement>('button,input,select,textarea,[href],[tabindex]:not([tabindex="-1"])')].filter(
        (el) => !el.hasAttribute("disabled"),
      );
      if (f.length < 2) return;
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResolve]);

  const approve = async () => {
    if (!needAuth) return onResolve(true);
    setVerifying(true);
    const ok = await confirmConsent(passphrase).catch(() => false);
    setVerifying(false);
    if (ok) onResolve(true);
    else setAuthError(true);
  };

  const titleText = (card.titleKey && t(`agent.consent.title.${card.titleKey}` as MsgKey)) || card.title;
  // Any value-moving / value-signing tool (every GATED tool) carries the warning.
  const risky = card.consentClass === "gated";

  // Total debit = amount + fee (only when both are base-exfer amounts, i.e. a
  // transfer — a swap's fee is a percentage, so this stays null there).
  const amtF = card.fields.find((f) => f.labelKey === "amount" && f.kind === "amount");
  const feeF = card.fields.find((f) => f.labelKey === "fee" && f.kind === "amount");
  const total =
    amtF && feeF && Number.isSafeInteger(Number(amtF.value)) && Number.isSafeInteger(Number(feeF.value))
      ? Number(amtF.value) + Number(feeF.value)
      : null;

  const renderValue = (f: ConsentField) => {
    if (f.kind === "amount") {
      const n = Number(f.value);
      return <span className="amount-md">{f.value === "" || Number.isNaN(n) ? t("agent.consent.feeEstimated") : formatExfer(n)}</span>;
    }
    if (f.kind === "address") {
      // Address is the irreversible part of a move — render it as a left-aligned
      // contiguous block (not ragged-right) so the user can verify it char by
      // char, and reuse the Markdown CopyChip so the copy affordance is
      // identical to every address chip elsewhere.
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="mono break-all text-left text-sm text-neutral-100">{f.value || "—"}</span>
          {f.value && <CopyChip value={f.value} />}
        </span>
      );
    }
    return <span className="mono text-sm text-neutral-100">{f.value || "—"}</span>;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="consent-card">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} className="card-padded w-full max-w-sm space-y-4 fade-in">
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5 text-cyan-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M12 3 4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6l-8-3Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <h2 id={titleId} className="text-lg font-semibold text-neutral-100">
            {titleText}
          </h2>
        </div>
        <div id={descId} className="space-y-4">
          <dl className="space-y-2 text-sm">
            {card.fields.map((f) => {
              // Amounts stay right-aligned (column reads as numbers); addresses
              // and other values block-align left so a long mono string reads as
              // one contiguous unit.
              const rightAlign = f.kind === "amount";
              return (
                <div key={f.label} className="grid grid-cols-[auto,1fr] items-start gap-3">
                  <dt className="text-neutral-400">{(f.labelKey && t(`agent.consent.field.${f.labelKey}` as MsgKey)) || f.label}</dt>
                  <dd className={rightAlign ? "text-right" : "min-w-0 text-left"}>{renderValue(f)}</dd>
                </div>
              );
            })}
          </dl>
          {total != null && (
            <div className="grid grid-cols-[auto,1fr] items-baseline gap-3 border-t border-neutral-800 pt-2 text-sm">
              <dt className="font-medium text-neutral-300">{t("agent.consent.total")}</dt>
              <dd className="amount-md text-right">{formatExfer(total)}</dd>
            </div>
          )}
          {risky && (
            <p role="alert" className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {t(card.toolName === "exfer_sign_message" ? "agent.consent.riskSign" : "agent.consent.risk")}
            </p>
          )}
        </div>
        {needAuth && (
          <label className="block space-y-1">
            <span className="label">{t("agent.consent.passphrase")}</span>
            <input
              type="password"
              className="input w-full"
              value={passphrase}
              autoComplete="off"
              onChange={(e) => {
                setPassphrase(e.target.value);
                setAuthError(false);
              }}
              onKeyDown={(e) => e.key === "Enter" && passphrase && approve()}
              data-testid="consent-passphrase"
            />
            {authError && <span className="text-xs text-red-400">{t("agent.consent.authFailed")}</span>}
          </label>
        )}
        <div className="flex gap-3 pt-1">
          <button ref={declineRef} type="button" className="btn-ghost flex-1" onClick={() => onResolve(false)} data-testid="consent-decline">
            {t("agent.consent.decline")}
          </button>
          <button type="button" className="btn flex-1" disabled={verifying || (needAuth && !passphrase)} onClick={approve} data-testid="consent-approve">
            {t("agent.consent.approve")}
          </button>
        </div>
      </div>
    </div>
  );
}
