import { useEffect, useState, type FormEvent } from "react";
import { rpc, parseExferAmount, formatExfer } from "../lib/rpc";
import type { TransferReceipt, WalletBalance } from "../lib/types";

export function Transfer() {
  const [addresses, setAddresses] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [feeRate, setFeeRate] = useState("1");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);

  useEffect(() => {
    rpc<WalletBalance>("get_wallet_balance").then(
      (r) => {
        const addrs = r.entries.map((e) => e.address);
        setAddresses(addrs);
        if (addrs.length > 0 && !from) setFrom(addrs[0]);
      },
      (e) => setError(String(e)),
    );
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setReceipt(null);

    let amountExfers: number;
    let feeRateInt: number;
    try {
      amountExfers = parseExferAmount(amount);
      feeRateInt = Number(feeRate);
      if (!Number.isFinite(feeRateInt) || feeRateInt < 1) {
        throw new Error("fee_rate must be a positive integer");
      }
    } catch (err) {
      setError(String(err));
      return;
    }

    if (!/^[0-9a-fA-F]{64}$/.test(to)) {
      setError("recipient address must be 64 hex characters");
      return;
    }

    setPending(true);
    try {
      const result = await rpc<TransferReceipt>("transfer", {
        from,
        outputs: [{ to, amount: amountExfers }],
        fee_rate: feeRateInt,
      });
      setReceipt(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4 p-6">
      <h2 className="text-lg font-semibold">Send</h2>

      <form onSubmit={onSubmit} className="card p-4 space-y-4 max-w-xl">
        <div>
          <label className="label">From</label>
          <select
            className="input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            disabled={pending || addresses.length === 0}
          >
            {addresses.length === 0 && (
              <option value="">No addresses yet — generate one first</option>
            )}
            {addresses.map((a) => (
              <option key={a} value={a}>
                {a.slice(0, 10)}…{a.slice(-6)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label">To (64-hex address)</label>
          <input
            className="input font-mono text-xs"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="e.g. 4dce3ee577ae384f92f79962d4e6faddfbeb4b91aa9188754f3c42dd5a81a8cd"
            disabled={pending}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Amount (EXFER)</label>
            <input
              className="input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.01"
              disabled={pending}
            />
          </div>
          <div>
            <label className="label">Fee rate (consensus floor = 1)</label>
            <input
              className="input"
              value={feeRate}
              onChange={(e) => setFeeRate(e.target.value)}
              disabled={pending}
            />
          </div>
        </div>

        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="btn"
          disabled={pending || !from || addresses.length === 0}
        >
          {pending ? "Broadcasting…" : "Send"}
        </button>
      </form>

      {receipt && (
        <div className="card p-4 space-y-2 max-w-xl">
          <div className="font-semibold text-green-700">Broadcast OK</div>
          <div className="text-sm">
            <span className="text-neutral-500">tx_id:</span>{" "}
            <code className="break-all font-mono text-xs">{receipt.tx_id}</code>
          </div>
          <div className="text-sm">
            <span className="text-neutral-500">fee:</span>{" "}
            <span className="font-mono">{formatExfer(receipt.fee)}</span>
            <span className="ml-2 text-neutral-500">
              ({receipt.fee} exfers, rate {receipt.fee_rate})
            </span>
          </div>
          <div className="text-sm">
            <span className="text-neutral-500">size:</span>{" "}
            <span className="font-mono">{receipt.size} bytes</span>
            <span className="ml-2 text-neutral-500">
              · inputs: {receipt.inputs.length} · outputs:{" "}
              {receipt.outputs.length}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
