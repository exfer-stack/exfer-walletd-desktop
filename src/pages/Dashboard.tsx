import { useState } from "react";
import { rpc, formatExfer, MAX_ADDRESSES } from "../lib/rpc";
import type { GeneratedAddress } from "../lib/types";
import { AddressRow } from "../components/AddressRow";
import { useWallet } from "../lib/wallet";
import { useToast } from "../lib/toast";

export function Dashboard() {
  const { balance: data, loading, error, refresh } = useWallet();
  const toast = useToast();
  const [generating, setGenerating] = useState(false);

  async function generateAddress() {
    setGenerating(true);
    try {
      const a = await rpc<GeneratedAddress>("generate_address");
      await refresh();
      toast.success("Address created", `Index ${a.index} is ready to receive.`);
    } catch (e) {
      toast.error("Couldn't create address", String(e));
    } finally {
      setGenerating(false);
    }
  }

  const isEmpty = !loading && data !== null && data.entries.length === 0;
  const atCap = (data?.entries.length ?? 0) >= MAX_ADDRESSES;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-8 fade-in">
      {/* Hero — total balance */}
      <section className="card-padded">
        <div className="text-sm font-medium uppercase tracking-wide text-neutral-400">
          Total balance
        </div>
        <div className="amount-lg mt-2">
          {data ? formatExfer(data.total) : "—"}
        </div>
        <div className="mt-1 text-sm text-neutral-400">
          across{" "}
          <span className="font-medium text-neutral-300">
            {data?.entries.length ?? 0}
          </span>{" "}
          {data?.entries.length === 1 ? "address" : "addresses"}
        </div>
      </section>

      {error && !data && (
        <div className="banner-error flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={refresh} className="btn-secondary">
            Retry
          </button>
        </div>
      )}

      {/* Address list */}
      <section className="card overflow-hidden">
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-base font-semibold tracking-tight text-neutral-100">
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
              disabled={generating || atCap}
              className="btn"
              title={
                atCap
                  ? `This wallet is capped at ${MAX_ADDRESSES} addresses`
                  : undefined
              }
            >
              {generating ? "Generating…" : "+ New address"}
            </button>
          </div>
        </header>

        {atCap && (
          <div className="border-b border-neutral-800 bg-neutral-900/60 px-5 py-2.5 text-xs text-neutral-400">
            You've reached the {MAX_ADDRESSES}-address limit for this wallet.
            Reuse an existing address to receive — one address can take any
            number of deposits.
          </div>
        )}

        {loading && !data ? (
          <SkeletonRows />
        ) : isEmpty ? (
          <div className="px-5 py-12 text-center">
            <div className="mx-auto max-w-md space-y-2">
              <div className="text-lg font-medium text-neutral-300">
                No addresses yet
              </div>
              <p className="text-sm text-neutral-400">
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
            <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="px-5 py-2.5 text-left">Index</th>
                <th className="px-5 py-2.5 text-left">Label</th>
                <th className="px-5 py-2.5 text-left">Address</th>
                <th className="px-5 py-2.5 text-left">UTXOs</th>
                <th className="px-5 py-2.5 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
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

function SkeletonRows() {
  return (
    <div className="divide-y divide-neutral-800">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="h-4 w-6 animate-pulse rounded bg-neutral-800" />
          <div className="h-4 w-24 animate-pulse rounded bg-neutral-800" />
          <div className="h-4 flex-1 animate-pulse rounded bg-neutral-800" />
          <div className="h-4 w-28 animate-pulse rounded bg-neutral-800" />
        </div>
      ))}
    </div>
  );
}
