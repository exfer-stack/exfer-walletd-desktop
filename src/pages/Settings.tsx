import { useEffect, useState, type FormEvent } from "react";
import {
  getNodeRpc,
  rpc,
  setNodeRpc,
  getIndexerConfig,
  setIndexerConfig,
  formatExfer,
  resetWallet,
} from "../lib/rpc";
import type { BootstrapStatus, WalletBalance } from "../lib/types";
import { listLabels } from "../lib/labels";
import { RevealPrivateKeyModal } from "../components/RevealPrivateKeyModal";
import { ImportKeyModal } from "../components/ImportKeyModal";
import { ImportMnemonicModal } from "../components/ImportMnemonicModal";
import { VaultBackupModal, VaultRestoreModal } from "../components/KeyringModals";
import { Governance } from "./Governance";
import { useToast } from "../lib/toast";
import { useWallet } from "../lib/wallet";
import { checkForUpdate, downloadAndApply } from "../lib/updater";
import { useT, LANGS, type Lang } from "../lib/i18n";
import { humanizeError } from "../lib/errors";

interface Props {
  onRestart: (status: BootstrapStatus) => void;
  fingerprint: string;
  localAddr: string;
  lang: Lang;
  setLang: (l: Lang) => void;
}

interface StatusInfo {
  version: string;
  uptime_secs: number;
  wallet_count: number;
  in_flight_transfers: number;
  in_flight_utxos: number;
  upstream?: { url: string; mode?: string };
}

export function Settings({ onRestart, fingerprint, localAddr, lang, setLang }: Props) {
  const toast = useToast();
  const { t } = useT();
  const [current, setCurrent] = useState<string>("");
  const [value, setValue] = useState("");
  const [savingNode, setSavingNode] = useState(false);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [nodeInfo, setNodeInfo] = useState<string | null>(null);

  // Indexer config ("" = use the bundled default). `current*` track what's
  // saved so the Save button can disable when nothing changed.
  const [indexerUrl, setIndexerUrl] = useState("");
  const [indexerCurUrl, setIndexerCurUrl] = useState("");
  const [savingIndexer, setSavingIndexer] = useState(false);
  const [indexerError, setIndexerError] = useState<string | null>(null);
  const [indexerInfo, setIndexerInfo] = useState<string | null>(null);

  // Swap is hard-coded ON against the official pool (not user-configurable),
  // so there's no swap row here anymore.

  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<StatusInfo | null>(null);

  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showImportPhrase, setShowImportPhrase] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  // Governance is re-homed under Settings: opened from a row here into a
  // self-contained full-screen overlay, so voting stays reachable.
  const [showGovernance, setShowGovernance] = useState(false);
  const { refresh } = useWallet();

  const [resetConfirm, setResetConfirm] = useState("");
  const [resetting, setResetting] = useState(false);

  const [updCheck, setUpdCheck] = useState<
    "idle" | "checking" | "none" | "available" | "installing"
  >("idle");
  const [updVersion, setUpdVersion] = useState<string | null>(null);
  const [updProgress, setUpdProgress] = useState<number>(0);

  useEffect(() => {
    getNodeRpc().then((v) => {
      setCurrent(v);
      setValue(v);
    });
    getIndexerConfig().then((c) => {
      setIndexerUrl(c.rpc);
      setIndexerCurUrl(c.rpc);
    }, () => {});
    rpc<StatusInfo>("get_status").then(setStatus, () => {});
  }, []);

  // ---- change flags (drive the per-row "changed" dot + the shared footer) ----
  const nodeChanged = value.trim() !== current.trim();
  const indexerChanged = indexerUrl.trim() !== indexerCurUrl.trim();
  const anyChanged = nodeChanged || indexerChanged;
  const savingAny = savingNode || savingIndexer;
  const connError = nodeError ?? indexerError;
  const connInfo = nodeInfo ?? indexerInfo;

  async function saveIndexer() {
    setIndexerError(null);
    setIndexerInfo(null);
    setSavingIndexer(true);
    try {
      const s = await setIndexerConfig(indexerUrl);
      setIndexerCurUrl(indexerUrl.trim());
      setIndexerInfo(
        indexerUrl.trim()
          ? t("set.indexerSavedCustom")
          : t("set.indexerSavedDefault"),
      );
      toast.success(t("set.indexerToastOkTitle"), t("set.indexerToastOkBody"));
      onRestart(s);
    } catch (err) {
      setIndexerError(humanizeError(err));
      toast.error(t("set.indexerToastErrTitle"), humanizeError(err));
    } finally {
      setSavingIndexer(false);
    }
  }

  async function saveNode() {
    setNodeError(null);
    setNodeInfo(null);
    setSavingNode(true);
    try {
      const s = await setNodeRpc(value);
      setCurrent(value);
      setNodeInfo(t("set.nodeSavedOk"));
      toast.success(t("set.nodeToastOkTitle"), t("set.nodeToastOkBody"));
      onRestart(s);
    } catch (err) {
      setNodeError(humanizeError(err));
      toast.error(t("set.nodeToastErrTitle"), humanizeError(err));
    } finally {
      setSavingNode(false);
    }
  }

  // One shared footer Save governs all three connection rows. Each save calls
  // setNodeRpc / setIndexerConfig / setSwapConfig (each onRestart-s) for the
  // rows that actually changed — behaviour identical to the old per-card Saves.
  async function saveConnections(e: FormEvent) {
    e.preventDefault();
    if (nodeChanged) await saveNode();
    if (indexerChanged) await saveIndexer();
  }

  function revertConnections() {
    setValue(current);
    setIndexerUrl(indexerCurUrl);
    setNodeError(null);
    setIndexerError(null);
    setNodeInfo(null);
    setIndexerInfo(null);
  }

  async function doCheckUpdate() {
    setUpdCheck("checking");
    try {
      const u = await checkForUpdate();
      if (u.available) {
        setUpdVersion(u.version ?? null);
        setUpdCheck("available");
      } else {
        setUpdCheck("none");
      }
    } catch (e) {
      toast.error(t("set.updCheckErrTitle"), humanizeError(e));
      setUpdCheck("idle");
    }
  }

  async function doInstallUpdate() {
    setUpdCheck("installing");
    setUpdProgress(0);
    try {
      await downloadAndApply((done, total) => {
        if (total) setUpdProgress(Math.round((done / total) * 100));
      });
      // On success the app relaunches; this line typically isn't reached.
    } catch (e) {
      toast.error(t("set.updFailedTitle"), humanizeError(e));
      setUpdCheck("available");
    }
  }

  async function doReset() {
    setResetting(true);
    try {
      await resetWallet();
      // resetWallet returns the app to NeedsPassword; bubble that up so
      // App re-renders the password prompt.
      onRestart({ status: "needs_password" } as BootstrapStatus);
    } catch (err) {
      toast.error(t("set.resetFailedTitle"), humanizeError(err));
      setResetting(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const balance = await rpc<WalletBalance>("get_wallet_balance", {
        utxos: true,
      });
      const labels = listLabels();
      const rows = [
        ["index", "address", "label", "balance_exfers", "balance_exfer", "utxo_count"],
        ...balance.entries.map((e) => [
          e.imported ? "imported" : String(e.index ?? ""),
          e.address,
          labels[e.address] ?? "",
          String(e.balance),
          formatExfer(e.balance).replace(" EXFER", ""),
          String(e.utxo_count ?? ""),
        ]),
      ];
      const csv = rows
        .map((r) =>
          r
            .map((cell) =>
              /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell,
            )
            .join(","),
        )
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `exfer-addresses-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  function exportLabels() {
    const labels = listLabels();
    const json = JSON.stringify(labels, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `exfer-labels-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-8 fade-in">
      {/* Header: title + walletd version chip, language toggle top-right */}
      <header className="flex items-end justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
            {t("set.title")}
          </h1>
          {status && (
            <span className="addr-xs text-neutral-500">walletd v{status.version}</span>
          )}
        </div>
        <div className="inline-flex overflow-hidden rounded-lg border border-neutral-700">
          {LANGS.map((l) => (
            <button
              key={l.key}
              type="button"
              onClick={() => setLang(l.key)}
              className={
                "px-3 py-1.5 text-sm transition " +
                (l.key === lang
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:text-neutral-200")
              }
            >
              {l.label}
            </button>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-12 items-start gap-5">
        {/* LEFT — Connections (routine config) + Daemon (machine state) */}
        <div className="col-span-12 space-y-5 lg:col-span-6">
        <form onSubmit={saveConnections} className="card-padded space-y-3">
          <Eyebrow>{t("set.connectionsTitle")}</Eyebrow>

          <ConnRow
            label={t("set.nodeTitle")}
            changed={nodeChanged}
            chip={current || t("set.loading")}
          >
            <input
              className="input font-mono text-sm"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={savingAny}
              placeholder="http://80.78.31.82:9334"
            />
          </ConnRow>

          <ConnRow
            label={t("set.indexerTitle")}
            changed={indexerChanged}
            chip={indexerCurUrl || t("set.indexerDefault")}
          >
            <input
              className="input font-mono text-sm"
              value={indexerUrl}
              onChange={(e) => setIndexerUrl(e.target.value)}
              disabled={savingAny}
              placeholder={t("set.indexerPlaceholder")}
            />
          </ConnRow>

          <div className="flex items-center gap-2 pt-1">
            <button type="submit" className="btn" disabled={savingAny || !anyChanged}>
              {savingAny ? t("set.restarting") : t("set.saveReconnect")}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={revertConnections}
              disabled={savingAny || !anyChanged}
            >
              {t("set.revert")}
            </button>
            {connError ? (
              <span className="text-sm text-red-400">{connError}</span>
            ) : connInfo ? (
              <span className="text-sm text-cyan-400">{connInfo}</span>
            ) : null}
          </div>
        </form>

          {/* Daemon — machine state; Updates folds in via the header button */}
          <section className="card-padded space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Eyebrow>{t("set.daemonTitle")}</Eyebrow>
              {updCheck === "available" ? (
                <button type="button" className="btn-ghost text-cyan-400" onClick={doInstallUpdate}>
                  {t("set.updInstall")} v{updVersion}
                </button>
              ) : updCheck === "installing" ? (
                <span className="addr-xs text-neutral-400">
                  {t("set.updDownloading", { pct: updProgress })}
                </span>
              ) : updCheck === "none" ? (
                <span className="addr-xs text-neutral-500">{t("set.updLatest")}</span>
              ) : (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={doCheckUpdate}
                  disabled={updCheck === "checking"}
                >
                  {updCheck === "checking" ? t("set.updChecking") : t("set.updCheck")}
                </button>
              )}
            </div>
            {updCheck === "installing" && (
              <div className="h-1 w-full overflow-hidden rounded bg-neutral-800">
                <div
                  className="h-full rounded bg-cyan-500 transition-[width]"
                  style={{ width: updProgress + "%" }}
                />
              </div>
            )}
            <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-2 text-sm">
              <dt className="text-neutral-400">{t("set.daemonBind")}</dt>
              <dd className="min-w-0">
                <CopyValue value={localAddr} />
              </dd>
              <dt className="self-start pt-1 text-neutral-400">{t("set.daemonTls")}</dt>
              <dd className="min-w-0">
                <CopyValue value={fingerprint} wrap />
              </dd>
              {status && (
                <>
                  <dt className="text-neutral-400">{t("set.daemonVersion")}</dt>
                  <dd className="mono tabular-nums text-sm text-neutral-100">{status.version}</dd>
                  <dt className="text-neutral-400">{t("set.daemonWalletCount")}</dt>
                  <dd className="mono tabular-nums text-sm text-neutral-100">{status.wallet_count}</dd>
                  <dt className="text-neutral-400">{t("set.daemonInflightTransfers")}</dt>
                  <dd className="mono tabular-nums text-sm text-neutral-100">{status.in_flight_transfers}</dd>
                  <dt className="text-neutral-400">{t("set.daemonInflightUtxos")}</dt>
                  <dd className="mono tabular-nums text-sm text-neutral-100">{status.in_flight_utxos}</dd>
                </>
              )}
            </dl>
          </section>
        </div>

        {/* RIGHT — backup, import, export, and key reveal as labeled rows
            (a clean settings list, not a grid of unlike buttons) */}
        <div className="col-span-12 space-y-5 lg:col-span-6">
          <section className="card-padded space-y-5">
            <Eyebrow>{t("set.backupDataTitle")}</Eyebrow>

            <SettingGroup title={t("set.grpVault")}>
              <SettingRow
                title={t("set.backupBtn")}
                desc={t("set.backupTip")}
                onClick={() => setShowBackup(true)}
              />
              <SettingRow
                title={t("set.restoreBtn")}
                desc={t("set.restoreDesc")}
                onClick={() => setShowRestore(true)}
              />
            </SettingGroup>

            <SettingGroup title={t("set.grpImport")}>
              <SettingRow
                title={t("set.importKey")}
                desc={t("set.importKeyDesc")}
                onClick={() => setShowImport(true)}
              />
              <SettingRow
                title={t("set.importPhrase")}
                desc={t("set.importPhraseDesc")}
                onClick={() => setShowImportPhrase(true)}
              />
            </SettingGroup>

            <SettingGroup title={t("set.grpExport")}>
              <SettingRow
                title={exporting ? t("set.exporting") : t("set.exportCsv")}
                desc={t("set.exportCsvDesc")}
                onClick={exportCsv}
                disabled={exporting}
              />
              <SettingRow
                title={t("set.exportLabels")}
                desc={t("set.exportLabelsDesc")}
                onClick={exportLabels}
              />
            </SettingGroup>
          </section>

          {/* Sensitive export — danger row with an always-visible warning */}
          <section className="card-padded space-y-3">
            <Eyebrow>{t("set.sensitiveTitle")}</Eyebrow>
            <SettingRow
              tone="danger"
              title={t("set.sensitiveExportKey")}
              onClick={() => setShowPrivateKey(true)}
            />
            <p className="help flex gap-1.5 text-amber-400/90">
              <span aria-hidden>⚠</span>
              <span>{t("set.sensitiveTip")}</span>
            </p>
          </section>
        </div>

        {/* Governance — re-homed here; opens the full voting surface. */}
        <section className="col-span-12 card-padded flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <Eyebrow>{t("set.governanceTitle")}</Eyebrow>
            <p className="text-sm text-neutral-400">{t("set.governanceDesc")}</p>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowGovernance(true)}
          >
            {t("nav.governance")}
          </button>
        </section>

        {/* BOTTOM — Danger zone, one compact red row */}
        <section className="col-span-12 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-red-500/40 bg-red-500/5 px-6 py-4">
          <div className="min-w-0">
            <Eyebrow className="text-red-300">{t("set.dangerTitle")}</Eyebrow>
            <p className="text-sm text-red-400/80">{t("set.dangerOneLiner")}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="reset-confirm">
              {t("set.resetTypePre")} WIPE {t("set.resetTypePost")}
            </label>
            <input
              id="reset-confirm"
              className="input max-w-[140px]"
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              disabled={resetting}
              placeholder="WIPE"
              autoComplete="off"
            />
            <button
              type="button"
              className="btn-danger"
              disabled={resetConfirm !== "WIPE" || resetting}
              onClick={doReset}
            >
              {resetting ? t("set.resetting") : t("set.resetBtn")}
            </button>
          </div>
        </section>
      </div>

      {showPrivateKey && (
        <RevealPrivateKeyModal onClose={() => setShowPrivateKey(false)} />
      )}

      {showImport && (
        <ImportKeyModal
          onClose={() => setShowImport(false)}
          onImported={() => {
            // Pull the newly-imported address into the wallet provider
            // so it shows up in Dashboard / Receive immediately.
            refresh().catch(() => {});
          }}
        />
      )}

      {showImportPhrase && (
        <ImportMnemonicModal
          onClose={() => setShowImportPhrase(false)}
          onImported={() => {
            refresh().catch(() => {});
          }}
        />
      )}

      {showBackup && <VaultBackupModal onClose={() => setShowBackup(false)} />}

      {showRestore && (
        <VaultRestoreModal
          onClose={() => setShowRestore(false)}
          onRestored={() => {
            refresh().catch(() => {});
          }}
        />
      )}

      {/* Governance — the full voting page in a self-contained overlay. */}
      {showGovernance && (
        <div className="fixed inset-0 z-50 overflow-auto bg-black fade-in">
          <div className="sticky top-0 z-10 flex items-center border-b border-neutral-800 bg-black/90 px-6 py-3 backdrop-blur">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShowGovernance(false)}
            >
              <span aria-hidden>←</span> {t("dash.back")}
            </button>
          </div>
          <Governance />
        </div>
      )}
    </div>
  );
}

/** A labeled group of settings rows: a small micro-header over a divided list.
 *  Turns the old grid of unlike buttons into a scannable, conventional settings
 *  list (vault backup / import / export each get their own group). */
function SettingGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="px-0.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {title}
      </div>
      <div className="divide-y divide-neutral-800/70">{children}</div>
    </div>
  );
}

/** A single settings row: title + one-line description on the left, a chevron
 *  affordance on the right; the whole row is the click target (macOS/iOS-style)
 *  so the meaning lives in the label, not a wall of identical buttons. */
function SettingRow({
  title,
  desc,
  onClick,
  disabled,
  tone,
}: {
  title: string;
  desc?: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group -mx-2 flex w-full items-center justify-between gap-4 rounded-lg px-2 py-2.5 text-left transition hover:bg-neutral-800/50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="min-w-0">
        <span
          className={
            "block text-sm font-medium " +
            (tone === "danger" ? "text-red-300" : "text-neutral-200")
          }
        >
          {title}
        </span>
        {desc && (
          <span className="mt-0.5 block text-xs text-neutral-500">{desc}</span>
        )}
      </span>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4 shrink-0 text-neutral-600 transition group-hover:text-neutral-300"
        aria-hidden
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  );
}

/** Compact uppercase card eyebrow — demotes the old text-lg h2s so the inputs
 *  and daemon numbers are the visual focus. */
function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={
        "text-sm font-semibold uppercase tracking-wide " +
        (className ?? "text-neutral-400")
      }
    >
      {children}
    </h2>
  );
}

/** One connection field: label + inline "currently in use" chip + a "changed"
 *  dot on one baseline, with the input(s) below. */
function ConnRow({
  label,
  chip,
  changed,
  children,
}: {
  label: string;
  chip: string;
  changed: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="label mb-0 flex items-center gap-1.5">
          {changed && <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" aria-hidden />}
          {label}
        </span>
        <code className="addr-xs min-w-0 flex-1 truncate text-right text-neutral-500">
          {chip}
        </code>
      </div>
      {children}
    </div>
  );
}

/** A monospace value you copy by clicking it. Long values (wrap) break
 *  onto multiple lines so they stay inside the card instead of spilling
 *  past the right edge. */
function CopyValue({ value, wrap }: { value: string; wrap?: boolean }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard denied */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={t("set.clickToCopy")}
      className="group flex w-full items-start gap-1.5 rounded-md px-1.5 py-0.5 text-left -mx-1.5 hover:bg-neutral-800/60"
    >
      <code
        className={
          "addr-xs flex-1 text-neutral-100 " +
          (wrap ? "break-all" : "truncate")
        }
      >
        {value}
      </code>
      <span
        className={
          "shrink-0 text-xs " +
          (copied
            ? "text-cyan-400"
            : "text-neutral-500 opacity-0 transition group-hover:opacity-100")
        }
        aria-hidden
      >
        {copied ? t("set.copied") : "⧉"}
      </span>
    </button>
  );
}
