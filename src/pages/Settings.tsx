import { useEffect, useState, type FormEvent } from "react";
import { getNodeRpc, rpc, setNodeRpc, formatExfer } from "../lib/rpc";
import type { BootstrapStatus, WalletBalance } from "../lib/types";
import { listLabels } from "../lib/labels";

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
  const [current, setCurrent] = useState<string>("");
  const [value, setValue] = useState("");
  const [savingNode, setSavingNode] = useState(false);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [nodeInfo, setNodeInfo] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<StatusInfo | null>(null);

  useEffect(() => {
    getNodeRpc().then((v) => {
      setCurrent(v);
      setValue(v);
    });
    rpc<StatusInfo>("get_status").then(setStatus, () => {});
  }, []);

  async function saveNode(e: FormEvent) {
    e.preventDefault();
    setNodeError(null);
    setNodeInfo(null);
    setSavingNode(true);
    try {
      const s = await setNodeRpc(value);
      setCurrent(value);
      setNodeInfo("Saved — walletd reconnected to the new node.");
      onRestart(s);
    } catch (err) {
      setNodeError(String(err));
    } finally {
      setSavingNode(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const balance = await rpc<WalletBalance>("get_wallet_balance");
      const labels = listLabels();
      const rows = [
        ["index", "address", "label", "balance_exfers", "balance_exfer", "utxo_count"],
        ...balance.entries.map((e) => [
          e.imported ? "imported" : String(e.index ?? ""),
          e.address,
          labels[e.address] ?? "",
          String(e.balance),
          formatExfer(e.balance).replace(" EXFER", ""),
          String(e.utxo_count),
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
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Settings
        </h1>
        <p className="text-base text-neutral-600">
          Configure the upstream Exfer node and manage local data.
        </p>
      </header>

      {/* Upstream node */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-900">
            Upstream node
          </h2>
          <p className="text-sm text-neutral-500">
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
            placeholder="http://89.127.232.155:9334"
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

      {/* Backup & export */}
      <section className="card-padded space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-neutral-900">
            Backup & export
          </h2>
          <p className="text-sm text-neutral-500">
            What's worth saving outside this device.
          </p>
        </header>

        <div className="banner-warn space-y-2">
          <div className="font-semibold">
            How recovery works in this wallet
          </div>
          <p>
            We use a custom HD derivation path, so the 24-word seed isn't
            portable to MetaMask / Sparrow / Electrum. Backup means two
            things:
          </p>
          <ol className="ml-4 list-decimal space-y-1">
            <li>
              <span className="font-medium">Your password.</span> Stored
              in your OS keychain on this machine. Write it down somewhere
              else too — losing it locks every key.
            </li>
            <li>
              <span className="font-medium">
                Your app-data directory.
              </span>{" "}
              Copy it to a USB / encrypted backup. Together with the
              password, this restores every address.
            </li>
          </ol>
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
        </div>
      </section>

      {/* Daemon status */}
      <section className="card-padded space-y-3">
        <header>
          <h2 className="text-lg font-semibold text-neutral-900">
            Daemon status
          </h2>
        </header>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-500">Bind</dt>
          <dd className="addr-xs font-medium text-neutral-800">{localAddr}</dd>
          <dt className="text-neutral-500">TLS fingerprint</dt>
          <dd className="addr-xs">{fingerprint}</dd>
          {status && (
            <>
              <dt className="text-neutral-500">Version</dt>
              <dd className="addr-xs">{status.version}</dd>
              <dt className="text-neutral-500">Wallet count</dt>
              <dd className="addr-xs">{status.wallet_count}</dd>
              <dt className="text-neutral-500">In-flight transfers</dt>
              <dd className="addr-xs">{status.in_flight_transfers}</dd>
              <dt className="text-neutral-500">In-flight UTXOs</dt>
              <dd className="addr-xs">{status.in_flight_utxos}</dd>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}
