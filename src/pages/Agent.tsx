import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSession, type AgentEvent, type ConsentCard } from "exfer-agent";
import { useT } from "../lib/i18n";
import { hostDeps } from "../lib/agentHost";

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
interface Turn {
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  tools: ToolCard[];
}
interface PendingConsent {
  card: ConsentCard;
  resolve: (ok: boolean) => void;
}

const Spinner = () => (
  <svg className="h-3.5 w-3.5 animate-spin text-cyan-300" viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
    <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2Z" />
  </svg>
);

export function Agent() {
  const { t } = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<PendingConsent | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // One session per page mount. requestConsent surfaces the card and resolves
  // the boolean the core awaits.
  const session = useMemo(() => {
    const { provider, tools } = hostDeps();
    return new AgentSession({
      provider,
      model: "deepseek-chat",
      listTools: tools.listTools,
      executeTool: tools.executeTool,
      requestConsent: (req) => new Promise<boolean>((resolve) => setConsent({ card: req.card, resolve })),
      systemPrompt: "You are the exfer wallet agent. Use tools to fulfil requests; the app handles confirmation.",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, consent]);

  // Mutate the in-flight assistant turn (always the last one).
  const patchLast = useCallback((fn: (t: Turn) => void) => {
    setTurns((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice();
      const last = { ...next[next.length - 1], tools: next[next.length - 1].tools.slice() };
      fn(last);
      next[next.length - 1] = last;
      return next;
    });
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return;
      setInput("");
      setBusy(true);
      setTurns((p) => [...p, { role: "user", text, tools: [] }, { role: "assistant", text: "", tools: [] }]);
      try {
        for await (const ev of session.send(text) as AsyncIterable<AgentEvent>) {
          switch (ev.type) {
            case "thinking_delta":
              patchLast((tn) => (tn.thinking = (tn.thinking ?? "") + ev.text));
              break;
            case "text_delta":
              patchLast((tn) => (tn.text += ev.text));
              break;
            case "tool_call_started":
              patchLast((tn) =>
                tn.tools.push({ id: ev.id, name: ev.name, args: ev.args, status: "running", gated: ev.consentClass !== "auto" }),
              );
              break;
            case "tool_result":
              patchLast((tn) => {
                const c = tn.tools.find((x) => x.id === ev.id);
                if (c) {
                  c.status = ev.ok ? "ok" : "error";
                  c.summary = ev.summary;
                }
              });
              break;
            case "error":
              patchLast((tn) => (tn.text += `\n\n⚠ ${t("agent.error.generic", { message: ev.message })}`));
              break;
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, session, patchLast, t],
  );

  const examples = [t("agent.empty.ex1"), t("agent.empty.ex2"), t("agent.empty.ex3")];

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-6">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-auto">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-6 text-center fade-in">
            <h1 className="text-2xl font-semibold text-neutral-100">{t("agent.empty.title")}</h1>
            <div className="flex flex-wrap justify-center gap-2">
              {examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => send(ex)}
                  className="rounded-full border border-neutral-800 px-3 py-1.5 text-sm text-neutral-400 hover:border-cyan-500/50 hover:text-neutral-100"
                >
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
                <details className="rounded-lg border border-neutral-800/70 bg-neutral-900/40 px-3 py-2 text-xs text-neutral-400">
                  <summary className="cursor-pointer select-none text-neutral-500">{t("agent.thinking.label")}</summary>
                  <div className="mt-1 whitespace-pre-wrap">{tn.thinking}</div>
                </details>
              )}
              {tn.tools.map((c) => (
                <div key={c.id} className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-sm" data-testid="tool-card">
                  <div className="flex items-center gap-2">
                    {c.status === "running" ? <Spinner /> : <span className={c.status === "ok" ? "text-cyan-300" : "text-red-400"}>{c.status === "ok" ? "✓" : "✕"}</span>}
                    <span className="mono text-neutral-300">{c.name}</span>
                    {c.gated && <span className="rounded bg-amber-500/15 px-1.5 text-[10px] text-amber-300">gated</span>}
                  </div>
                  {c.summary && <pre className="mono mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-neutral-500">{c.summary}</pre>}
                </div>
              ))}
              {tn.text && <div className="whitespace-pre-wrap text-sm text-neutral-100">{tn.text}</div>}
              {busy && i === turns.length - 1 && !tn.text && !tn.tools.length && <Spinner />}
            </div>
          ),
        )}
      </div>

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
        <button type="button" className="btn-primary" disabled={busy || !input.trim()} onClick={() => send(input)} data-testid="agent-send">
          {t("agent.composer.send")}
        </button>
      </div>

      {consent && (
        <ConfirmationCard
          card={consent.card}
          onResolve={(ok) => {
            consent.resolve(ok);
            setConsent(null);
          }}
        />
      )}
    </div>
  );
}

function ConfirmationCard({ card, onResolve }: { card: ConsentCard; onResolve: (ok: boolean) => void }) {
  const { t } = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onResolve(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResolve]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="consent-card">
      <div className="card-padded w-full max-w-sm space-y-4 fade-in">
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5 text-cyan-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M12 3 4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6l-8-3Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <h2 className="text-lg font-semibold text-neutral-100">{card.title}</h2>
        </div>
        <dl className="space-y-1.5 text-sm">
          {card.fields.map((f) => (
            <div key={f.label} className="flex justify-between gap-3">
              <dt className="text-neutral-500">{f.label}</dt>
              <dd className="mono truncate text-neutral-100" title={f.value}>{f.value || "—"}</dd>
            </div>
          ))}
        </dl>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={() => onResolve(false)} data-testid="consent-decline">
            {t("agent.consent.decline")}
          </button>
          <button type="button" className="btn-primary flex-1" onClick={() => onResolve(true)} data-testid="consent-approve">
            {t("agent.consent.approve")}
          </button>
        </div>
      </div>
    </div>
  );
}
