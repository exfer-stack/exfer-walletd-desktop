import { useState } from "react";
import { useT } from "../../lib/i18n";
import { PROVIDER_PRESETS, loadConfig, saveConfig, saveApiKey, type SavedConfig } from "../../lib/agentConfig";

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
                {p.label}
              </option>
            ))}
          </select>
          {preset.note && <span className="help">{preset.note}</span>}
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
          <input type="password" className="input w-full" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" autoComplete="off" data-testid="settings-apikey" />
          <span className="help">{t("agent.settings.keyNote")}</span>
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
