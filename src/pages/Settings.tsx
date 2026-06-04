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

interface Props {
  onRestart: (status: BootstrapStatus) => void;
  fingerprint: string;
  localAddr: string;
}

interface StatusInfo {
  version: string;
  uptime_secs: number;
  wallet_count: number;
  in_flight_transfers: number;
  in_flight_utxos: number;
  upstream?: { url: string; mode?: string };
}

export function Settings({ onRestart, fingerprint, localAddr }: Props) {
  const toast = useToast();
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
      setSwapError("Chain id must be a whole number (e.g. 56 mainnet, 97 testnet).");
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
          ? "Saved — swap enabled, walletd reconnected."
          : "Saved — swap disabled.",
      );
      toast.success("Swap config updated", "walletd reconnected.");
      onRestart(s);
    } catch (err) {
      setSwapError(String(err));
      toast.error("Couldn't update swap config", String(err));
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
          ? "Saved — walletd reconnected to the new indexer."
          : "Saved — using the bundled default indexer.",
      );
      toast.success("Indexer updated", "walletd reconnected.");
      onRestart(s);
    } catch (err) {
      setIndexerError(String(err));
      toast.error("Couldn't update indexer", String(err));
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
      setNodeInfo("Saved — walletd reconnected to the new node.");
      toast.success("Node updated", "Reconnected to the new endpoint.");
      onRestart(s);
    } catch (err) {
      setNodeError(String(err));
      toast.error("Couldn't switch node", String(err));
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
      toast.error("Update check failed", String(e));
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
      toast.error("Update failed", String(e));
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
      toast.error("Reset failed", String(err));
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
          Settings
        </h1>
        <p className="text-base text-neutral-400">
          Configure the upstream Exfer node and manage local data.
        </p>
      </header>

      {/* Upstream node */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">
            Upstream node
          </h2>
          <p className="text-sm text-neutral-400">
            The Exfer JSON-RPC endpoint walletd talks to for chain reads and
            broadcast. Comma-separated for round-robin + failover.
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
            Currently in use:{" "}
            <code className="addr-xs">{current || "(loading)"}</code>
          </p>
          {nodeError && <div className="banner-error">{nodeError}</div>}
          {nodeInfo && <div className="banner-success">{nodeInfo}</div>}
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn"
              disabled={savingNode || value.trim() === current.trim()}
            >
              {savingNode ? "Restarting walletd…" : "Save & reconnect"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setValue(current)}
              disabled={savingNode}
            >
              Revert
            </button>
          </div>
        </form>
      </section>

      {/* Indexer */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">Indexer</h2>
          <p className="text-sm text-neutral-400">
            The exfer-indexer walletd delegates address-history queries to —
            it powers the Activity feed and the From/To on each transfer. Leave
            blank to use the bundled default. The indexer serves public
            read-only chain data, so no token is needed.
          </p>
        </header>
        <form onSubmit={saveIndexer} className="space-y-3">
          <input
            className="input font-mono text-sm"
            value={indexerUrl}
            onChange={(e) => setIndexerUrl(e.target.value)}
            disabled={savingIndexer}
            placeholder="http://198.13.38.245:9335 (default)"
          />
          <p className="help">
            Currently in use:{" "}
            <code className="addr-xs">{indexerCurUrl || "Default (bundled)"}</code>
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
              {savingIndexer ? "Restarting walletd…" : "Save & reconnect"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setIndexerUrl(indexerCurUrl)}
              disabled={savingIndexer}
            >
              Revert
            </button>
          </div>
        </form>
      </section>

      {/* Swap */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">Swap</h2>
          <p className="text-sm text-neutral-400">
            Cross-chain EXFER ↔ BNB swaps run through a swap pool. Leave the pool
            URL blank to keep swap off. The current public pool is on BSC
            <span className="text-neutral-300"> testnet (Chapel)</span> — to use
            it, set the BSC RPC to a testnet endpoint and chain id to 97.
          </p>
        </header>
        <form onSubmit={saveSwap} className="space-y-3">
          <div>
            <label className="label">Pool URL</label>
            <input
              className="input font-mono text-sm"
              value={swapPool}
              onChange={(e) => setSwapPool(e.target.value)}
              disabled={savingSwap}
              placeholder="blank = swap off · e.g. http://64.176.231.198:8080"
            />
          </div>
          <div className="grid grid-cols-[1.6fr_1fr] gap-3">
            <div>
              <label className="label">BSC RPC URL</label>
              <input
                className="input font-mono text-sm"
                value={swapBscRpc}
                onChange={(e) => setSwapBscRpc(e.target.value)}
                disabled={savingSwap}
                placeholder="blank = mainnet default"
              />
            </div>
            <div>
              <label className="label">BSC chain id</label>
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
            Swap is currently{" "}
            <code className="addr-xs">
              {swapCur.pool ? `ON — ${swapCur.pool}` : "OFF"}
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
              {savingSwap ? "Restarting walletd…" : "Save & reconnect"}
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
              Revert
            </button>
          </div>
        </form>
      </section>

      {/* Updates */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">Updates</h2>
          <p className="text-sm text-neutral-400">
            New versions are downloaded, signature-verified, and installed
            in place — no manual reinstall.
          </p>
        </header>

        {updCheck === "available" ? (
          <div className="banner-success flex items-center justify-between gap-3">
            <span>
              Version <span className="font-mono">v{updVersion}</span> is
              available.
            </span>
            <button
              type="button"
              className="btn"
              onClick={doInstallUpdate}
            >
              Install & restart
            </button>
          </div>
        ) : updCheck === "installing" ? (
          <div className="banner-info space-y-2">
            <div>Downloading update… {updProgress}%</div>
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
              {updCheck === "checking" ? "Checking…" : "Check for updates"}
            </button>
            {updCheck === "none" && (
              <span className="text-sm text-neutral-400">
                You're on the latest version.
              </span>
            )}
          </div>
        )}
      </section>

      {/* Data export / import utilities */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">
            Export &amp; import data
          </h2>
          <p className="text-sm text-neutral-400">
            Address lists, labels, and single-key files. To back up the keys
            themselves, use <span className="font-medium text-neutral-300">Back up wallet</span>{" "}
            above.
          </p>
        </header>

        <div className="banner-info space-y-1 text-sm">
          <div className="font-semibold">Don't forget your password</div>
          <p>
            Your wallet password unlocks every key and encrypts the backup
            file. It's saved in this machine's OS keychain — write it down
            somewhere else too, since losing it locks every address.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            className="btn-secondary"
          >
            {exporting ? "Exporting…" : "Export addresses (CSV)"}
          </button>
          <button
            type="button"
            onClick={exportLabels}
            className="btn-secondary"
          >
            Export labels (JSON)
          </button>
          <button
            type="button"
            onClick={() => setShowImport(true)}
            className="btn-secondary"
          >
            Import wallet.key…
          </button>
          <button
            type="button"
            onClick={() => setShowImportPhrase(true)}
            className="btn-secondary"
          >
            Import recovery phrase…
          </button>
        </div>
        <p className="help">
          <span className="font-medium text-neutral-300">Import wallet.key</span>{" "}
          adds an externally-held address (e.g. one exported from
          exfer.dev or another machine) to this wallet. Old{" "}
          <span className="font-mono">.key</span> files still import — the
          format is unchanged.{" "}
          <span className="font-medium text-neutral-300">
            Import recovery phrase
          </span>{" "}
          brings in an address from its 24 words; the standard scheme matches
          exfer.dev and the Exfer mobile wallet, so the same phrase lands on the
          same address.
        </p>
      </section>

      {/* Whole-wallet encrypted backup — the recommended way to back up */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">
            Back up &amp; restore
          </h2>
          <p className="text-sm text-neutral-400">
            Every address in this wallet is its own key. One encrypted{" "}
            <span className="font-mono">.vault</span> file backs up all of
            them at once — no seed phrase to copy down.
          </p>
        </header>

        <div className="banner-info text-sm">
          The backup file is encrypted with{" "}
          <strong>your wallet password</strong>. Keep the file and the
          password somewhere safe; you need both to restore. New addresses you
          create later aren't in an old backup — re-export after adding keys.
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => setShowBackup(true)}
          >
            Back up wallet…
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowRestore(true)}
          >
            Restore from backup…
          </button>
        </div>
        <p className="help">
          Prefer this over single-key exports for routine backup. To move{" "}
          <em>one</em> address elsewhere, use its row menu (Recovery phrase,
          Export wallet.key) instead.
        </p>
      </section>

      {/* Sensitive data export — gated by password re-entry */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-100">
            Sensitive recovery export
          </h2>
          <p className="text-sm text-neutral-400">
            Reveal the master secrets directly. Both actions ask for
            your password again before showing anything.
          </p>
        </header>

        <div className="banner-error space-y-1 text-sm">
          <div className="font-semibold">Read first</div>
          <p>
            These flows show plaintext key material on screen. Anyone
            looking at your screen, screenshot apps, or screen-share
            sessions can capture it. Only proceed if you actually need
            paper / off-app backup.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-danger"
            onClick={() => setShowPrivateKey(true)}
          >
            Export private key for an address
          </button>
        </div>
        <p className="help">
          To move an address to exfer.dev or the Exfer CLI, prefer{" "}
          <span className="font-medium text-neutral-300">
            Export wallet.key
          </span>{" "}
          from the address's row menu — it's encrypted and imports directly.
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
            Daemon status
          </h2>
        </header>
        <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-400">Bind</dt>
          <dd className="min-w-0">
            <CopyValue value={localAddr} />
          </dd>
          <dt className="self-start pt-1 text-neutral-400">TLS fingerprint</dt>
          <dd className="min-w-0">
            <CopyValue value={fingerprint} wrap />
          </dd>
          {status && (
            <>
              <dt className="text-neutral-400">Version</dt>
              <dd className="addr-xs">{status.version}</dd>
              <dt className="text-neutral-400">Wallet count</dt>
              <dd className="addr-xs">{status.wallet_count}</dd>
              <dt className="text-neutral-400">In-flight transfers</dt>
              <dd className="addr-xs">{status.in_flight_transfers}</dd>
              <dt className="text-neutral-400">In-flight UTXOs</dt>
              <dd className="addr-xs">{status.in_flight_utxos}</dd>
            </>
          )}
        </dl>
      </section>

      {/* Danger zone — wipe everything on this device */}
      <section className="rounded-xl border border-red-500/40 bg-red-500/5 p-6 space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-red-300">Danger zone</h2>
          <p className="text-sm text-neutral-400">
            Permanently erase this wallet from this computer.
          </p>
        </header>

        <div className="banner-error space-y-1 text-sm">
          <div className="font-semibold">Reset wipes everything locally</div>
          <p>
            Deletes the encrypted keys, tokens, and TLS cert from this
            machine's app-data directory and clears the saved password from
            your OS keychain. Coins on-chain are untouched, but{" "}
            <strong>
              without a backup (vault file, or each address's recovery
              phrase / private key) you will not be able to get back in
            </strong>
            . Back up first if you might need this wallet again.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="reset-confirm">
            Type <span className="font-mono text-red-300">WIPE</span> to
            confirm
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
              {resetting ? "Wiping…" : "Reset wallet"}
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
      title="Click to copy"
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
        {copied ? "✓ copied" : "⧉"}
      </span>
    </button>
  );
}
