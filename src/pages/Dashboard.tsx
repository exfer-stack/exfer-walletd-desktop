import { useEffect, useState } from "react";
import { rpc, formatExfer } from "../lib/rpc";
import type { WalletBalance, GeneratedAddress } from "../lib/types";
import { AddressRow } from "../components/AddressRow";

export function Dashboard() {
  const [data, setData] = useState<WalletBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const result = await rpc<WalletBalance>("get_wallet_balance");
      setData(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function generateAddress() {
    setGenerating(true);
    setError(null);
    try {
      await rpc<GeneratedAddress>("generate_address");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const isEmpty = data && data.entries.length === 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-8 fade-in">
      {/* Hero — total balance */}
      <section className="card-padded">
        <div className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Total balance
        </div>
        <div className="amount-lg mt-2">
          {data ? formatExfer(data.total) : "—"}
        </div>
        <div className="mt-1 text-sm text-neutral-500">
          across{" "}
          <span className="font-medium text-neutral-700">
            {data?.entries.length ?? 0}
          </span>{" "}
          {data?.entries.length === 1 ? "address" : "addresses"}
        </div>
      </section>

      {error && <div className="banner-error">{error}</div>}

      {/* Address list */}
      <section className="card overflow-hidden">
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <h2 className="text-base font-semibold tracking-tight text-neutral-800">
            Addresses
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="btn-ghost"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={generateAddress}
              disabled={generating}
              className="btn"
            >
              {generating ? "Generating…" : "+ New address"}
            </button>
          </div>
        </header>

        {isEmpty ? (
          <div className="px-5 py-12 text-center">
            <div className="mx-auto max-w-md space-y-2">
              <div className="text-lg font-medium text-neutral-700">
                No addresses yet
              </div>
              <p className="text-sm text-neutral-500">
                Mint your first address and you're ready to receive EXFER.
              </p>
              <button
                type="button"
                onClick={generateAddress}
                disabled={generating}
                className="btn mt-3"
              >
                {generating ? "Generating…" : "+ Generate first address"}
              </button>
            </div>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-5 py-2.5 text-left">Index</th>
                <th className="px-5 py-2.5 text-left">Label</th>
                <th className="px-5 py-2.5 text-left">Address</th>
                <th className="px-5 py-2.5 text-left">UTXOs</th>
                <th className="px-5 py-2.5 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {data?.entries.map((e) => (
                <AddressRow
                  key={e.address}
                  address={e.address}
                  index={e.index}
                  imported={e.imported}
                  balance={e.balance}
                  utxoCount={e.utxo_count}
                  truncated={e.truncated}
                  onLabelChange={refresh}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
