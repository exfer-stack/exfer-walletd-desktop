import { useEffect, useState, type FormEvent } from "react";
import {
  getNodeRpc,
  rpc,
  setNodeRpc,
  getIndexerConfig,
  setIndexerConfig,
  getSwapConfig,
  setSwapConfig,
  formatExfer,
  resetWallet,
} from "../lib/rpc";
import type { BootstrapStatus, WalletBalance } from "../lib/types";
import { listLabels } from "../lib/labels";
import { RevealPrivateKeyModal } from "../components/RevealPrivateKeyModal";
import { ImportKeyModal } from "../components/ImportKeyModal";
import { ImportMnemonicModal } from "../components/ImportMnemonicModal";
import { VaultBackupModal, VaultRestoreModal } from "../components/KeyringModals";
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

  // Swap engine config. Empty pool URL = swap OFF (the default). The current
  // public pool is on BSC testnet, so enabling it also wants a testnet RPC +
  // chain id 97. `swapCur*` track the saved values for the Save/Revert gates.
  const [swapPool, setSwapPool] = useState("");
  const [swapBscRpc, setSwapBscRpc] = useState("");
  const [swapChain, setSwapChain] = useState("");
  const [swapCur, setSwapCur] = useState({ pool: "", rpc: "", chain: "" });
  const [savingSwap, setSavingSwap] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [swapInfo, setSwapInfo] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<StatusInfo | null>(null);

  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showImportPhrase, setShowImportPhrase] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
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
    getSwapConfig().then((c) => {
      const chain = c.bsc_chain_id ? String(c.bsc_chain_id) : "";
      setSwapPool(c.pool_url);
      setSwapBscRpc(c.bsc_rpc_url);
      setSwapChain(chain);
      setSwapCur({ pool: c.pool_url, rpc: c.bsc_rpc_url, chain });
    }, () => {});
    rpc<StatusInfo>("get_status").then(setStatus, () => {});
  }, []);

  async function saveSwap(e: FormEvent) {
    e.preventDefault();
    setSwapError(null);
    setSwapInfo(null);
    const chainNum = swapChain.trim() === "" ? 0 : Number(swapChain.trim());
    if (!Number.isInteger(chainNum) || chainNum < 0) {
      setSwapError(t("set.swapChainErr"));
      return;
    }
    setSavingSwap(true);
    try {
      const s = await setSwapConfig({
        pool_url: swapPool,
        bsc_rpc_url: swapBscRpc,
        bsc_chain_id: chainNum,
      });
      setSwapCur({ pool: swapPool.trim(), rpc: swapBscRpc.trim(), chain: swapChain.trim() });
      setSwapInfo(
        swapPool.trim()
          ? t("set.swapSavedOn")
          : t("set.swapSavedOff"),
      );
      toast.success(t("set.swapToastOkTitle"), t("set.swapToastOkBody"));
      onRestart(s);
    } catch (err) {
      setSwapError(humanizeError(err));
      toast.error(t("set.swapToastErrTitle"), humanizeError(err));
    } finally {
      setSavingSwap(false);
    }
  }

  async function saveIndexer(e: FormEvent) {
    e.preventDefault();
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

  async function saveNode(e: FormEvent) {
    e.preventDefault();
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
    <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          {t("set.title")}
        </h1>
        <p className="text-base text-neutral-400">
          {t("set.subtitle")}
        </p>
      </header>

      {/* Display / language */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">
            {t("set.langTitle")}
          </h2>
          <p className="text-sm text-neutral-400">{t("set.langDesc")}</p>
        </header>
        <div>
          <label className="label">{t("set.langLabel")}</label>
          <div className="flex gap-2">
            {LANGS.map((l) => (
              <button
                key={l.key}
                type="button"
                className={l.key === lang ? "btn" : "btn-secondary"}
                onClick={() => setLang(l.key)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Upstream node */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">
            {t("set.nodeTitle")}
          </h2>
          <p className="text-sm text-neutral-400">
            {t("set.nodeDesc")}
          </p>
        </header>
        <form onSubmit={saveNode} className="space-y-3">
          <input
            className="input font-mono text-sm"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={savingNode}
            placeholder="http://80.78.31.82:9334"
          />
          <p className="help">
            {t("set.currentlyInUse")}{" "}
            <code className="addr-xs">{current || t("set.loading")}</code>
          </p>
          {nodeError && <div className="banner-error">{nodeError}</div>}
          {nodeInfo && <div className="banner-success">{nodeInfo}</div>}
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn"
              disabled={savingNode || value.trim() === current.trim()}
            >
              {savingNode ? t("set.restarting") : t("set.saveReconnect")}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setValue(current)}
              disabled={savingNode}
            >
              {t("set.revert")}
            </button>
          </div>
        </form>
      </section>

      {/* Indexer */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">{t("set.indexerTitle")}</h2>
          <p className="text-sm text-neutral-400">
            {t("set.indexerDesc")}
          </p>
        </header>
        <form onSubmit={saveIndexer} className="space-y-3">
          <input
            className="input font-mono text-sm"
            value={indexerUrl}
            onChange={(e) => setIndexerUrl(e.target.value)}
            disabled={savingIndexer}
            placeholder={t("set.indexerPlaceholder")}
          />
          <p className="help">
            {t("set.currentlyInUse")}{" "}
            <code className="addr-xs">{indexerCurUrl || t("set.indexerDefault")}</code>
          </p>
          {indexerError && <div className="banner-error">{indexerError}</div>}
          {indexerInfo && <div className="banner-success">{indexerInfo}</div>}
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn"
              disabled={
                savingIndexer || indexerUrl.trim() === indexerCurUrl.trim()
              }
            >
              {savingIndexer ? t("set.restarting") : t("set.saveReconnect")}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setIndexerUrl(indexerCurUrl)}
              disabled={savingIndexer}
            >
              {t("set.revert")}
            </button>
          </div>
        </form>
      </section>

      {/* Swap */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">{t("set.swapTitle")}</h2>
          <p className="text-sm text-neutral-400">
            {t("set.swapDesc")}
          </p>
        </header>
        <form onSubmit={saveSwap} className="space-y-3">
          <div>
            <label className="label">{t("set.swapPoolLabel")}</label>
            <input
              className="input font-mono text-sm"
              value={swapPool}
              onChange={(e) => setSwapPool(e.target.value)}
              disabled={savingSwap}
              placeholder={t("set.swapPoolPlaceholder")}
            />
          </div>
          <div className="grid grid-cols-[1.6fr_1fr] gap-3">
            <div>
              <label className="label">{t("set.swapRpcLabel")}</label>
              <input
                className="input font-mono text-sm"
                value={swapBscRpc}
                onChange={(e) => setSwapBscRpc(e.target.value)}
                disabled={savingSwap}
                placeholder={t("set.swapRpcPlaceholder")}
              />
            </div>
            <div>
              <label className="label">{t("set.swapChainLabel")}</label>
              <input
                className="input font-mono text-sm"
                value={swapChain}
                onChange={(e) => setSwapChain(e.target.value)}
                disabled={savingSwap}
                inputMode="numeric"
                placeholder="56 / 97"
              />
            </div>
          </div>
          <p className="help">
            {t("set.swapStatus")}{" "}
            <code className="addr-xs">
              {swapCur.pool ? t("set.swapOn", { pool: swapCur.pool }) : t("set.swapOff")}
            </code>
          </p>
          {swapError && <div className="banner-error">{swapError}</div>}
          {swapInfo && <div className="banner-success">{swapInfo}</div>}
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn"
              disabled={
                savingSwap ||
                (swapPool.trim() === swapCur.pool.trim() &&
                  swapBscRpc.trim() === swapCur.rpc.trim() &&
                  swapChain.trim() === swapCur.chain.trim())
              }
            >
              {savingSwap ? t("set.restarting") : t("set.saveReconnect")}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setSwapPool(swapCur.pool);
                setSwapBscRpc(swapCur.rpc);
                setSwapChain(swapCur.chain);
              }}
              disabled={savingSwap}
            >
              {t("set.revert")}
            </button>
          </div>
        </form>
      </section>

      {/* Updates */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">{t("set.updTitle")}</h2>
          <p className="text-sm text-neutral-400">
            {t("set.updDesc")}
          </p>
        </header>

        {updCheck === "available" ? (
          <div className="banner-success flex items-center justify-between gap-3">
            <span>
              {t("set.updAvailablePre")}{" "}
              <span className="font-mono">v{updVersion}</span>{" "}
              {t("set.updAvailablePost")}
            </span>
            <button
              type="button"
              className="btn"
              onClick={doInstallUpdate}
            >
              {t("set.updInstall")}
            </button>
          </div>
        ) : updCheck === "installing" ? (
          <div className="banner-info space-y-2">
            <div>{t("set.updDownloading", { pct: updProgress })}</div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
              <div
                className="h-full bg-cyan-400 transition-all"
                style={{ width: `${updProgress}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn-secondary"
              onClick={doCheckUpdate}
              disabled={updCheck === "checking"}
            >
              {updCheck === "checking" ? t("set.updChecking") : t("set.updCheck")}
            </button>
            {updCheck === "none" && (
              <span className="text-sm text-neutral-400">
                {t("set.updLatest")}
              </span>
            )}
          </div>
        )}
      </section>

      {/* Data export / import utilities */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">
            {t("set.exportTitle")}
          </h2>
          <p className="text-sm text-neutral-400">
            {t("set.exportDesc")}
          </p>
        </header>

        <div className="banner-info space-y-1 text-sm">
          <div className="font-semibold">{t("set.pwReminderTitle")}</div>
          <p>
            {t("set.pwReminderBody")}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            className="btn-secondary"
          >
            {exporting ? t("set.exporting") : t("set.exportCsv")}
          </button>
          <button
            type="button"
            onClick={exportLabels}
            className="btn-secondary"
          >
            {t("set.exportLabels")}
          </button>
          <button
            type="button"
            onClick={() => setShowImport(true)}
            className="btn-secondary"
          >
            {t("set.importKey")}
          </button>
          <button
            type="button"
            onClick={() => setShowImportPhrase(true)}
            className="btn-secondary"
          >
            {t("set.importPhrase")}
          </button>
        </div>
        <p className="help">
          {t("set.importHelp")}
        </p>
      </section>

      {/* Whole-wallet encrypted backup — the recommended way to back up */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">
            {t("set.backupTitle")}
          </h2>
          <p className="text-sm text-neutral-400">
            {t("set.backupDesc")}
          </p>
        </header>

        <div className="banner-info text-sm">
          {t("set.backupWarn")}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => setShowBackup(true)}
          >
            {t("set.backupBtn")}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowRestore(true)}
          >
            {t("set.restoreBtn")}
          </button>
        </div>
        <p className="help">
          {t("set.backupHelp")}
        </p>
      </section>

      {/* Sensitive data export — gated by password re-entry */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">
            {t("set.sensitiveTitle")}
          </h2>
          <p className="text-sm text-neutral-400">
            {t("set.sensitiveDesc")}
          </p>
        </header>

        <div className="banner-error space-y-1 text-sm">
          <div className="font-semibold">{t("set.sensitiveWarnTitle")}</div>
          <p>
            {t("set.sensitiveWarnBody")}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-danger"
            onClick={() => setShowPrivateKey(true)}
          >
            {t("set.sensitiveExportKey")}
          </button>
        </div>
        <p className="help">
          {t("set.sensitiveHelp")}
        </p>
      </section>

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

      {/* Daemon status */}
      <section className="card-padded space-y-3">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">
            {t("set.daemonTitle")}
          </h2>
        </header>
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
              <dd className="addr-xs">{status.version}</dd>
              <dt className="text-neutral-400">{t("set.daemonWalletCount")}</dt>
              <dd className="addr-xs">{status.wallet_count}</dd>
              <dt className="text-neutral-400">{t("set.daemonInflightTransfers")}</dt>
              <dd className="addr-xs">{status.in_flight_transfers}</dd>
              <dt className="text-neutral-400">{t("set.daemonInflightUtxos")}</dt>
              <dd className="addr-xs">{status.in_flight_utxos}</dd>
            </>
          )}
        </dl>
      </section>

      {/* Danger zone — wipe everything on this device */}
      <section className="rounded-xl border border-red-500/40 bg-red-500/5 p-6 space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-red-300">{t("set.dangerTitle")}</h2>
          <p className="text-sm text-neutral-400">
            {t("set.dangerDesc")}
          </p>
        </header>

        <div className="banner-error space-y-1 text-sm">
          <div className="font-semibold">{t("set.resetWarnTitle")}</div>
          <p>
            {t("set.resetWarnBody")}
          </p>
        </div>

        <div>
          <label className="label" htmlFor="reset-confirm">
            {t("set.resetTypePre")}{" "}
            <span className="font-mono text-red-300">WIPE</span>{" "}
            {t("set.resetTypePost")}
          </label>
          <div className="flex gap-2">
            <input
              id="reset-confirm"
              className="input max-w-[200px]"
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
        </div>
      </section>
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
