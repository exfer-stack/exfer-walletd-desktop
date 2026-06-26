import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { mcpListServers, mcpAddServer, mcpRemoveServer, mcpSetEnabled, type McpServerConfig } from "../../lib/mcpRegistry";

// Tools & MCP-server manager (mirrors the AgentSettings.tsx modal pattern). Lists
// the implicit built-in "exfer" server (read-only) plus user-added servers from
// the registry, and lets the user add/remove/enable them. The registry wrappers
// route through the Rust commands in Tauri and a localStorage fallback in
// browser-dev. The built-in server is never in the registry, so it is rendered
// statically here and is not removable.

type Transport = "stdio" | "http";
type Consent = "auto" | "gated";

export function McpManager({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const [servers, setServers] = useState<McpServerConfig[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // add-form state
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [url, setUrl] = useState("");
  const [defaultConsent, setDefaultConsent] = useState<Consent>("gated");

  const refresh = () =>
    mcpListServers()
      .then(setServers)
      .catch(() => setServers([]));

  useEffect(() => {
    void refresh();
  }, []);

  const resetForm = () => {
    setId("");
    setLabel("");
    setTransport("stdio");
    setCommand("");
    setArgsText("");
    setEnvText("");
    setUrl("");
    setDefaultConsent("gated");
    setFormError(null);
  };

  const parseEnv = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
  };

  const onAdd = async () => {
    const trimId = id.trim();
    const trimLabel = label.trim();
    if (!trimId || !trimLabel) return setFormError(t("agent.mcp.errIdRequired"));
    if (trimId === "exfer") return setFormError(t("agent.mcp.errIdReserved"));
    if ((servers ?? []).some((s) => s.id === trimId)) return setFormError(t("agent.mcp.errIdTaken"));

    const cfg: McpServerConfig = { id: trimId, label: trimLabel, transport, enabled: true, defaultConsent };
    if (transport === "stdio") {
      const cmd = command.trim();
      if (!cmd) return setFormError(t("agent.mcp.errCommand"));
      cfg.command = cmd;
      const args = argsText.split("\n").map((a) => a.trim()).filter(Boolean);
      if (args.length) cfg.args = args;
      const env = parseEnv(envText);
      if (Object.keys(env).length) cfg.env = env;
    } else {
      const u = url.trim();
      if (!u) return setFormError(t("agent.mcp.errUrl"));
      cfg.url = u;
    }

    setBusy(true);
    try {
      await mcpAddServer(cfg);
      resetForm();
      await refresh();
    } catch (e) {
      setFormError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (sid: string) => {
    setBusy(true);
    try {
      await mcpRemoveServer(sid);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onToggle = async (sid: string, enabled: boolean) => {
    setBusy(true);
    try {
      await mcpSetEnabled(sid, enabled);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="mcp-manager">
      <div role="dialog" aria-modal="true" className="card-padded max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto fade-in">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-neutral-100">{t("agent.mcp.title")}</h2>
          <p className="text-sm text-neutral-500">{t("agent.mcp.subtitle")}</p>
        </div>

        {/* Built-in server — always on, not removable. A muted lock pill, NOT the
            cyan Enabled pill, so it reads as "locked on" rather than a toggle. */}
        <div className="card-chat px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-neutral-100">{t("agent.mcp.builtinLabel")}</div>
              <div className="text-xs text-neutral-500">{t("agent.mcp.builtinNote")}</div>
            </div>
            <span className="pill shrink-0 bg-neutral-800 text-neutral-400">
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              {t("agent.mcp.builtinAlwaysOn")}
            </span>
          </div>
        </div>

        {/* User-added servers */}
        <div className="space-y-2">
          <h3 className="label">{t("agent.mcp.yourServers")}</h3>
          {servers === null ? (
            <p className="text-xs text-neutral-500">…</p>
          ) : servers.length === 0 ? (
            <p className="text-xs text-neutral-500">{t("agent.mcp.empty")}</p>
          ) : (
            servers.map((s) => (
              <div key={s.id} className="card-chat px-3 py-2" data-testid={`mcp-server-${s.id}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-neutral-100">{s.label}</div>
                    <div className="mono truncate text-xs text-neutral-500">
                      {s.id} · {s.transport} · {s.defaultConsent}
                    </div>
                    <div className="mono truncate text-[11px] text-neutral-600">{s.transport === "http" ? s.url : [s.command, ...(s.args ?? [])].join(" ")}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-400">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer rounded border-neutral-700 bg-neutral-950 accent-cyan-500"
                        checked={s.enabled}
                        disabled={busy}
                        onChange={(e) => onToggle(s.id, e.target.checked)}
                        data-testid={`mcp-toggle-${s.id}`}
                      />
                      {s.enabled ? t("agent.mcp.enabled") : t("agent.mcp.disabled")}
                    </label>
                    <button type="button" className="btn-ghost px-2 py-1 text-xs text-red-400" disabled={busy} onClick={() => onRemove(s.id)} data-testid={`mcp-remove-${s.id}`}>
                      {t("agent.mcp.remove")}
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Add-server form */}
        <div className="space-y-3 border-t border-neutral-800 pt-4">
          <h3 className="label">{t("agent.mcp.addTitle")}</h3>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="label">{t("agent.mcp.fieldId")}</span>
              <input className="input mono w-full" value={id} onChange={(e) => setId(e.target.value)} placeholder="filesystem" data-testid="mcp-add-id" />
            </label>
            <label className="block space-y-1">
              <span className="label">{t("agent.mcp.fieldLabel")}</span>
              <input className="input w-full" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Filesystem" data-testid="mcp-add-label" />
            </label>
          </div>
          <span className="help">{t("agent.mcp.fieldIdHint")}</span>

          <label className="block space-y-1">
            <span className="label">{t("agent.mcp.fieldTransport")}</span>
            <select className="input w-full cursor-pointer accent-cyan-500" value={transport} onChange={(e) => setTransport(e.target.value as Transport)} data-testid="mcp-add-transport">
              <option value="stdio">{t("agent.mcp.transportStdio")}</option>
              <option value="http">{t("agent.mcp.transportHttp")}</option>
            </select>
          </label>

          {transport === "stdio" ? (
            <>
              <label className="block space-y-1">
                <span className="label">{t("agent.mcp.fieldCommand")}</span>
                <input className="input mono w-full" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" data-testid="mcp-add-command" />
              </label>
              <label className="block space-y-1">
                <span className="label">{t("agent.mcp.fieldArgs")}</span>
                <textarea className="input mono w-full" rows={3} value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path"} data-testid="mcp-add-args" />
              </label>
              <label className="block space-y-1">
                <span className="label">{t("agent.mcp.fieldEnv")}</span>
                <textarea className="input mono w-full" rows={2} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="API_KEY=…" data-testid="mcp-add-env" />
              </label>
            </>
          ) : (
            <label className="block space-y-1">
              <span className="label">{t("agent.mcp.fieldUrl")}</span>
              <input className="input mono w-full" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" data-testid="mcp-add-url" />
            </label>
          )}

          <label className="block space-y-1">
            <span className="label">{t("agent.mcp.fieldConsent")}</span>
            <select className="input w-full cursor-pointer accent-cyan-500" value={defaultConsent} onChange={(e) => setDefaultConsent(e.target.value as Consent)} data-testid="mcp-add-consent">
              <option value="gated">{t("agent.mcp.consentGated")}</option>
              <option value="auto">{t("agent.mcp.consentAuto")}</option>
            </select>
            <span className="help">{t("agent.mcp.consentHint")}</span>
          </label>

          {formError && (
            <p role="alert" className="text-xs text-red-400" data-testid="mcp-add-error">
              {formError}
            </p>
          )}

          <button type="button" className="btn w-full" disabled={busy} onClick={onAdd} data-testid="mcp-add-submit">
            {t("agent.mcp.add")}
          </button>
        </div>

        <div className="flex justify-end border-t border-neutral-800 pt-4">
          <button type="button" className="btn-ghost" onClick={onClose} data-testid="mcp-close">
            {t("agent.mcp.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
