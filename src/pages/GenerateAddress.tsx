import { useState } from "react";
import { rpc } from "../lib/rpc";
import type { GeneratedAddress } from "../lib/types";

export function GenerateAddress() {
  const [latest, setLatest] = useState<GeneratedAddress | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mint() {
    setPending(true);
    setError(null);
    try {
      const result = await rpc<GeneratedAddress>("generate_address");
      setLatest(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard denied — ignore */
    }
  }

  return (
    <div className="space-y-4 p-6">
      <h2 className="text-lg font-semibold">Generate address</h2>

      <p className="text-sm text-neutral-600">
        Walletd derives a new HD address at the next free index and seals it
        under your password. Safe to mint as many as you need.
      </p>

      <button type="button" className="btn" onClick={mint} disabled={pending}>
        {pending ? "Generating…" : "Mint new address"}
      </button>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {latest && (
        <div className="card p-4 space-y-3">
          <div>
            <div className="label">Address (index {latest.index})</div>
            <div className="flex gap-2">
              <code className="flex-1 break-all rounded bg-neutral-100 px-3 py-2 font-mono text-xs">
                {latest.address}
              </code>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => copy(latest.address)}
              >
                Copy
              </button>
            </div>
          </div>
          <div>
            <div className="label">Pubkey</div>
            <code className="block break-all rounded bg-neutral-100 px-3 py-2 font-mono text-xs">
              {latest.pubkey}
            </code>
          </div>
        </div>
      )}
    </div>
  );
}
