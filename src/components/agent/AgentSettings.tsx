import { useState } from "react";
import { useT, type MsgKey } from "../../lib/i18n";
import { PROVIDER_PRESETS, loadConfig, saveConfig, saveApiKey, type SavedConfig } from "../../lib/agentConfig";
import { loadSearchConfig, saveSearchConfig, type SearchProvider } from "../../lib/searchConfig";
import { openExternal } from "../../lib/openExternal";

const SEARCH_KEY_URL: Record<string, string> = {
  tavily: "https://app.tavily.com",
  brave: "https://brave.com/search/api/",
};

// "Bring your own LLM": pick a preset (or Custom), set baseUrl/model, paste a
// key. Non-secret config → localStorage; key → OS keychain (Tauri) / dev store.
export function AgentSettings({ onClose }: { onClose: (saved: boolean) => void }) {
  const { t } = useT();
  const existing = loadConfig();
  const [presetIdx, setPresetIdx] = useState(() => {
    const i = PROVIDER_PRESETS.findIndex((p) => p.baseUrl === existing?.baseUrl);
    return i >= 0 ? i : 0;
  });
  const preset = PROVIDER_PRESETS[presetIdx];
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? preset.baseUrl);
  const [model, setModel] = useState(existing?.model ?? preset.defaultModel);
  const [apiKey, setApiKey] = useState("");
  const existingSearch = loadSearchConfig();
  const [searchProvider, setSearchProvider] = useState<SearchProvider>(existingSearch?.provider ?? "tavily");
  const [searchKey, setSearchKey] = useState(existingSearch?.apiKey ?? "");
  const [saving, setSaving] = useState(false);

  const onPreset = (i: number) => {
    setPresetIdx(i);
    const p = PROVIDER_PRESETS[i];
    setBaseUrl(p.baseUrl);
    setModel(p.defaultModel);
  };

  const onSave = async () => {
    setSaving(true);
    const cfg: SavedConfig = { id: "user", label: preset.label, kind: preset.kind, baseUrl, model };
    saveConfig(cfg);
    if (apiKey.trim()) await saveApiKey("user", apiKey.trim());
    saveSearchConfig({ provider: searchProvider, apiKey: searchProvider === "free" ? "" : searchKey.trim() });
    setSaving(false);
    onClose(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="agent-settings">
      <div role="dialog" aria-modal="true" className="card-padded w-full max-w-md space-y-4 fade-in">
        <h2 className="text-lg font-semibold text-neutral-100">{t("agent.settings.title")}</h2>

        <label className="block space-y-1">
          <span className="label">{t("agent.settings.provider")}</span>
          <select className="input w-full" value={presetIdx} onChange={(e) => onPreset(Number(e.target.value))} data-testid="settings-provider">
            {PROVIDER_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {(p.labelKey && t(p.labelKey as MsgKey)) || p.label}
              </option>
            ))}
          </select>
          {(preset.noteKey || preset.note) && <span className="help">{(preset.noteKey && t(preset.noteKey as MsgKey)) || preset.note}</span>}
        </label>

        <label className="block space-y-1">
          <span className="label">{t("agent.settings.baseUrl")}</span>
          <input className="input mono w-full" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com" />
        </label>

        <label className="block space-y-1">
          <span className="label">{t("agent.settings.model")}</span>
          <input className="input mono w-full" value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
        </label>

        <label className="block space-y-1">
          <span className="label">{t("agent.settings.apiKey")}</span>
          <p className="text-xs text-neutral-500">{t("agent.settings.keyExplain")}</p>
          <input type="password" className="input w-full" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" autoComplete="off" data-testid="settings-apikey" />
          {preset.keyUrl && (
            <button type="button" className="text-xs text-cyan-400 underline decoration-cyan-400/40 underline-offset-2 hover:text-cyan-300" onClick={() => void openExternal(preset.keyUrl!)} data-testid="settings-getkey-llm">
              {t("agent.settings.getKey")} ↗
            </button>
          )}
          <span className="help">{t("agent.settings.keyNote")}</span>
        </label>

        <label className="block space-y-1 border-t border-neutral-800 pt-3">
          <span className="label">{t("agent.settings.searchProvider")}</span>
          <p className="text-xs text-neutral-500">{t("agent.settings.searchExplain")}</p>
          <select className="input w-full" value={searchProvider} onChange={(e) => setSearchProvider(e.target.value as SearchProvider)} data-testid="settings-search-provider">
            <option value="tavily">Tavily {t("agent.settings.searchAgentTag")}</option>
            <option value="brave">Brave</option>
            <option value="free">{t("agent.settings.searchFree")}</option>
          </select>
          {searchProvider !== "free" && (
            <>
              <input
                type="password"
                className="input w-full"
                value={searchKey}
                onChange={(e) => setSearchKey(e.target.value)}
                placeholder={searchProvider === "tavily" ? "tvly-… (optional)" : "BSA… (optional)"}
                autoComplete="off"
                data-testid="settings-search-key"
              />
              {SEARCH_KEY_URL[searchProvider] && (
                <button type="button" className="text-xs text-cyan-400 underline decoration-cyan-400/40 underline-offset-2 hover:text-cyan-300" onClick={() => void openExternal(SEARCH_KEY_URL[searchProvider])} data-testid="settings-getkey-search">
                  {t("agent.settings.getKey")} ↗
                </button>
              )}
            </>
          )}
        </label>

        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-ghost flex-1" onClick={() => onClose(false)}>
            {t("agent.settings.cancel")}
          </button>
          <button type="button" className="btn flex-1" disabled={saving} onClick={onSave} data-testid="settings-save">
            {t("agent.settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
