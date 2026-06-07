// Launch update prompt — shown once per new version when the app comes up and
// the updater reports a newer release. Pure typography: version headline, the
// changelog for the user's language, then Update-and-restart / Later. The
// install path reuses the signed tauri-updater flow (download → verify →
// install → relaunch) with a live progress bar; "Later" is remembered per
// version so the same release never nags twice. Settings keeps its manual
// check + install button regardless.

import { useState } from "react";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import {
  changelogLines,
  dismissUpdate,
  downloadAndApply,
  type UpdateInfo,
} from "../lib/updater";

declare const __APP_VERSION__: string | undefined;
const CURRENT = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "";

export function UpdateModal({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const { lang, t } = useT();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lines = changelogLines(info.notes, lang);
  const version = info.version ?? "";

  function later() {
    if (busy) return;
    dismissUpdate(version);
    onClose();
  }
  async function install() {
    setBusy(true);
    setError(null);
    try {
      // Relaunches on success — code after this only runs on failure.
      await downloadAndApply((done, total) => setProgress({ done, total }));
    } catch (e) {
      setError(humanizeError(e));
      setBusy(false);
      setProgress(null);
    }
  }

  const pct =
    progress && progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-6 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) later();
      }}
    >
      <div className="card-padded w-full max-w-md space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-neutral-100">{t("upd.modalTitle", { v: version })}</h2>
          {CURRENT && <p className="mt-0.5 text-xs text-neutral-500">{t("upd.modalSub", { v: CURRENT })}</p>}
        </div>

        {lines.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">{t("upd.whatsNew")}</div>
            <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2.5 text-sm leading-relaxed text-neutral-300">
                  <span className="shrink-0 text-neutral-600">—</span>
                  <span>{l}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {busy && (
          <div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
              <div
                className="h-full rounded bg-cyan-400 transition-all"
                style={{ width: `${pct ?? 30}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-neutral-500">
              {pct != null ? t("upd.downloadingPct", { pct: String(pct) }) : t("upd.downloading")}
            </p>
          </div>
        )}
        {error && <div className="banner-error">{error}</div>}

        <div className="flex gap-2.5">
          <button type="button" className="btn flex-[1.4]" disabled={busy} onClick={install}>
            {busy ? t("upd.installing") : t("upd.installRestart")}
          </button>
          <button type="button" className="btn-secondary flex-1" disabled={busy} onClick={later}>
            {t("upd.later")}
          </button>
        </div>
      </div>
    </div>
  );
}
