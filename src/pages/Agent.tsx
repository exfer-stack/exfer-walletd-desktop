import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AgentSession, type AgentEvent, type ConsentCard, type ConsentField } from "exfer-agent";
import { useT, type Lang, type MsgKey } from "../lib/i18n";
import { hostDeps, inTauri, confirmConsent } from "../lib/agentHost";
import { AgentSettings } from "../components/agent/AgentSettings";
import { loadConfig, toProviderConfig } from "../lib/agentConfig";
import { formatExfer } from "../lib/rpc";

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
type Block = { kind: "text"; text: string } | { kind: "tool"; card: ToolCard };
interface Turn {
  role: "user" | "assistant";
  text?: string; // user turns
  thinking?: string;
  blocks: Block[]; // assistant turns, ordered text/tool
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

/** A human one-liner for a tool result; the raw JSON stays behind a disclosure. */
function humanizeTool(name: string, summary: string): string {
  try {
    const r = JSON.parse(summary) as Record<string, unknown>;
    switch (name) {
      case "exfer_get_balance":
        return `Balance: ${formatExfer(Number(r.balance))}`;
      case "exfer_transfer":
        return `Submitted · fee ${formatExfer(Number(r.fee ?? 0))} · tx ${String(r.tx_id ?? "").slice(0, 12)}…`;
      case "exfer_swap_get_quote":
        return `Quote: ${r.amount_in} → ≈ ${r.amount_out}${r.fee_bps != null ? ` · fee ${Number(r.fee_bps) / 100}%` : ""}`;
      case "exfer_swap_execute":
        return `Swap ${String(r.swap_id ?? "")} started (${String(r.state ?? "")}) · settling`;
      case "exfer_payment_uri_encode":
        return String(r.uri ?? summary);
      default:
        return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
    }
  } catch {
    return summary;
  }
}

export function Agent({ lang }: { lang: Lang }) {
  const { t } = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<PendingConsent | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [cfgVersion, setCfgVersion] = useState(0);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastQuoteRef = useRef<Record<string, unknown> | null>(null);
  const lastUserText = useRef<string>("");

  const session = useMemo(() => {
    const saved = loadConfig();
    const cfg = saved ? toProviderConfig(saved) : undefined;
    const { provider, tools } = hostDeps(cfg);
    return new AgentSession({
      provider,
      model: saved?.model ?? "deepseek-chat",
      listTools: tools.listTools,
      executeTool: tools.executeTool,
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
        "You are the exfer wallet agent. Use tools to fulfil requests; the app handles confirmation. " +
        `Always respond to the user in ${lang === "zh" ? "Chinese (简体中文)" : "English"}.`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgVersion, lang]);

  // Auto-scroll only when the user is already near the bottom (don't yank them
  // away while they re-read an address mid-stream).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [turns]);

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
            case "error":
              setErrorBanner(ev.message);
              break;
          }
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, session, patchLast, t],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const examples = [t("agent.empty.ex1"), t("agent.empty.ex2"), t("agent.empty.ex3")];

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-6">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight text-neutral-100">{t("nav.agent")}</h1>
        <button type="button" className="btn-ghost px-2 py-1" title={t("agent.settings.open")} aria-label={t("agent.settings.open")} onClick={() => setShowSettings(true)} data-testid="agent-settings-open">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-auto">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-5 text-center fade-in">
            <div className="space-y-2">
              <h2 className="text-3xl font-semibold text-neutral-100">{t("agent.empty.title")}</h2>
              <p className="text-sm text-neutral-500">{t("agent.empty.subtitle")}</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {examples.map((ex) => (
                <button key={ex} type="button" onClick={() => setInput(ex)} className="pill pill-info px-3 py-2 hover:brightness-125">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((tn, i) =>
          tn.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl bg-cyan-500/15 px-4 py-2 text-sm text-cyan-50">{tn.text}</div>
            </div>
          ) : (
            <div key={i} className="space-y-2 fade-in" data-testid="assistant-turn">
              {tn.thinking && (
                <details open={busy && i === turns.length - 1} className="rounded-lg border border-neutral-800/70 bg-neutral-900/40 px-3 py-2 text-xs text-neutral-400">
                  <summary className="flex cursor-pointer select-none items-center gap-2 text-neutral-400">
                    {busy && i === turns.length - 1 && <Spinner />}
                    {busy && i === turns.length - 1 ? t("agent.thinking.active") : t("agent.thinking.label")}
                  </summary>
                  <div className="mt-1 whitespace-pre-wrap">{tn.thinking}</div>
                </details>
              )}
              {tn.blocks.map((b, j) =>
                b.kind === "text" ? (
                  b.text ? (
                    <div key={j} className="whitespace-pre-wrap text-sm text-neutral-100">
                      {b.text}
                    </div>
                  ) : null
                ) : (
                  <ToolCardView key={j} card={b.card} t={t} />
                ),
              )}
              {busy && i === turns.length - 1 && !tn.blocks.length && <Spinner />}
            </div>
          ),
        )}
      </div>

      {errorBanner && (
        <div className="banner-error mt-3 flex items-center justify-between gap-3" role="alert" data-testid="agent-error">
          <span>{t("agent.error.generic", { message: errorBanner })}</span>
          <button type="button" className="btn-ghost shrink-0" onClick={() => send(lastUserText.current)}>
            {t("agent.error.retry")}
          </button>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <input
          className="input flex-1"
          placeholder={t("agent.composer.placeholder")}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(input)}
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

      {showSettings && (
        <AgentSettings
          onClose={(saved) => {
            setShowSettings(false);
            if (saved) setCfgVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}

function ToolCardView({ card, t }: { card: ToolCard; t: ReturnType<typeof useT>["t"] }) {
  const statusText = card.status === "running" ? t("agent.tool.running", { name: card.name }) : card.status === "ok" ? t("agent.tool.done") : t("agent.tool.failed");
  const declined = card.summary === "declined";
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-sm" data-testid="tool-card">
      <div className="flex items-center gap-2" role="status">
        {card.status === "running" ? (
          <Spinner />
        ) : (
          <span className={card.status === "ok" ? "text-emerald-300" : "text-red-400"} aria-hidden>
            {card.status === "ok" ? "✓" : "✕"}
          </span>
        )}
        <span className="mono text-neutral-300">{card.name}</span>
        {card.gated && <span className="pill pill-warn">{t("agent.tool.gated")}</span>}
        <span className="sr-only">{statusText}</span>
      </div>
      {card.summary &&
        (declined ? (
          <div className="mt-1 text-xs text-amber-300">{t("agent.consent.declined")}</div>
        ) : (
          <>
            <div className="mt-1 text-xs text-neutral-300">{humanizeTool(card.name, card.summary)}</div>
            <details className="mt-1">
              <summary className="cursor-pointer text-[11px] text-neutral-500">{t("agent.tool.details")}</summary>
              <pre className="mono mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-neutral-500">{card.summary}</pre>
            </details>
          </>
        ))}
    </div>
  );
}

function ConfirmationCard({ card, t, onResolve }: { card: ConsentCard; t: ReturnType<typeof useT>["t"]; onResolve: (ok: boolean) => void }) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
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
      return (
        <span className="flex items-start gap-1.5">
          <span className="mono break-all text-sm text-neutral-100">{f.value || "—"}</span>
          {f.value && (
            <button
              type="button"
              className="shrink-0 text-cyan-400 hover:text-cyan-200"
              aria-label={t("agent.consent.copy")}
              onClick={() => {
                void navigator.clipboard?.writeText(f.value);
                setCopied(f.value);
              }}
            >
              <span aria-hidden>{copied === f.value ? "✓" : t("agent.consent.copy")}</span>
              {copied === f.value && <span className="sr-only">{t("agent.consent.copied")}</span>}
            </button>
          )}
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
            {card.fields.map((f) => (
              <div key={f.label} className="grid grid-cols-[auto,1fr] items-start gap-3">
                <dt className="text-neutral-400">{(f.labelKey && t(`agent.consent.field.${f.labelKey}` as MsgKey)) || f.label}</dt>
                <dd className="text-right">{renderValue(f)}</dd>
              </div>
            ))}
          </dl>
          {total != null && (
            <div className="grid grid-cols-[auto,1fr] items-baseline gap-3 border-t border-neutral-800 pt-2 text-sm">
              <dt className="font-medium text-neutral-300">{t("agent.consent.total")}</dt>
              <dd className="amount-md text-right">{formatExfer(total)}</dd>
            </div>
          )}
          {risky && (
            <p role="alert" className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {t("agent.consent.risk")}
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
