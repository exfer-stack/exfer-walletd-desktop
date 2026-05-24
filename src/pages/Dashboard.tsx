import { useEffect, useState } from "react";
import { rpc, formatExfer } from "../lib/rpc";
import type { WalletBalance } from "../lib/types";

export function Dashboard() {
  const [data, setData] = useState<WalletBalance | null>(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Addresses</h2>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="btn-ghost"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {data && (
        <div className="card overflow-hidden">
          <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm">
            <span className="font-medium text-neutral-700">Total:</span>{" "}
            <span className="font-mono">{formatExfer(data.total)}</span>
          </div>
          {data.entries.length === 0 ? (
            <div className="p-6 text-sm text-neutral-500">
              No addresses yet — head to the Generate tab to mint one.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Index</th>
                  <th className="px-4 py-2">Address</th>
                  <th className="px-4 py-2">UTXOs</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {data.entries.map((e) => (
                  <tr key={e.address}>
                    <td className="px-4 py-2 font-mono text-neutral-500">
                      {e.imported ? "imported" : e.index}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {e.address.slice(0, 10)}…{e.address.slice(-6)}
                    </td>
                    <td className="px-4 py-2 font-mono text-neutral-500">
                      {e.utxo_count}
                      {e.truncated && (
                        <span
                          className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800"
                          title="Node returned a truncated UTXO list (>1000)"
                        >
                          ⚠
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      {formatExfer(e.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
