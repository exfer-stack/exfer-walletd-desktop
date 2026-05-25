import { useEffect, useMemo, useState, type FormEvent } from "react";
import { rpc, parseExferAmount, formatExfer } from "../lib/rpc";
import type { TransferReceipt } from "../lib/types";
import { getLabel, shortAddress } from "../lib/labels";
import {
  appendHistory,
  listRecentRecipients,
  rememberRecipient,
} from "../lib/history";
import { CopyButton } from "../components/CopyButton";
import { useWallet } from "../lib/wallet";
import { useToast } from "../lib/toast";

interface OutputRow {
  to: string;
  amount: string;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function Send() {
  const { balance, refresh } = useWallet();
  const toast = useToast();
  const [from, setFrom] = useState("");
  const [outputs, setOutputs] = useState<OutputRow[]>([
    { to: "", amount: "" },
  ]);
  const [feeRate, setFeeRate] = useState("1");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);
  const recents = useMemo(listRecentRecipients, [receipt]);

  useEffect(() => {
    if (balance && balance.entries.length > 0 && !from) {
      setFrom(balance.entries[0].address);
    }
  }, [balance, from]);

  function updateOutput(i: number, patch: Partial<OutputRow>) {
    setOutputs((prev) => prev.map((o, k) => (k === i ? { ...o, ...patch } : o)));
  }
  function addRow() {
    setOutputs((prev) => [...prev, { to: "", amount: "" }]);
  }
  function removeRow(i: number) {
    setOutputs((prev) => prev.filter((_, k) => k !== i));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setReceipt(null);

    if (!from) {
      setError("Pick a sending address.");
      return;
    }
    const feeRateInt = Number(feeRate);
    if (!Number.isFinite(feeRateInt) || feeRateInt < 1) {
      setError("Fee rate must be a positive integer (1 = consensus floor).");
      return;
    }

    const parsedOutputs: { to: string; amount: number }[] = [];
    for (let i = 0; i < outputs.length; i++) {
      const o = outputs[i];
      if (!HEX64.test(o.to.trim())) {
        setError(`Recipient #${i + 1}: address must be 64 hex characters.`);
        return;
      }
      try {
        const amt = parseExferAmount(o.amount);
        parsedOutputs.push({ to: o.to.trim().toLowerCase(), amount: amt });
      } catch (err) {
        setError(`Recipient #${i + 1}: ${String(err)}`);
        return;
      }
    }

    setPending(true);
    try {
      const result = await rpc<TransferReceipt>("transfer", {
        from,
        outputs: parsedOutputs,
        fee_rate: feeRateInt,
      });
      setReceipt(result);
      appendHistory(result);
      for (const o of parsedOutputs) rememberRecipient(o.to);
      const sent = parsedOutputs.reduce((a, o) => a + o.amount, 0);
      toast.success("Transfer broadcast", `Sent ${formatExfer(sent)}.`);
      // Pull fresh balances so the Dashboard/From dropdown reflect the
      // spend immediately instead of waiting for the next poll.
      refresh();
      // Reset the recipient rows for the next send; keep `from`.
      setOutputs([{ to: "", amount: "" }]);
    } catch (e) {
      setError(String(e));
      toast.error("Transfer failed", String(e));
    } finally {
      setPending(false);
    }
  }

  const totalExfers = outputs.reduce((acc, o) => {
    try {
      return acc + parseExferAmount(o.amount);
    } catch {
      return acc;
    }
  }, 0);

  const fromEntry = balance?.entries.find((e) => e.address === from);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          Send EXFER
        </h1>
        <p className="text-base text-neutral-400">
          One transaction, up to 16 recipients. Fees are paid in the consensus
          unit; <span className="font-mono">rate = 1</span> is the floor.
        </p>
      </header>

      <form onSubmit={onSubmit} className="card-padded space-y-6">
        {/* From */}
        <div>
          <label className="label">From</label>
          <select
            className="input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            disabled={pending || !balance || balance.entries.length === 0}
          >
            {balance && balance.entries.length === 0 && (
              <option value="">No addresses — generate one first</option>
            )}
            {balance?.entries.map((e) => {
              const label = getLabel(e.address);
              const tag = label
                ? `${label} — ${shortAddress(e.address)}`
                : e.imported
                  ? `imported — ${shortAddress(e.address)}`
                  : `Address ${e.index} — ${shortAddress(e.address)}`;
              return (
                <option key={e.address} value={e.address}>
                  {tag} · {formatExfer(e.balance)}
                </option>
              );
            })}
          </select>
          {fromEntry && (
            <p className="help">
              Available:{" "}
              <span className="font-medium text-neutral-300">
                {formatExfer(fromEntry.balance)}
              </span>{" "}
              · {fromEntry.utxo_count}{" "}
              {fromEntry.utxo_count === 1 ? "UTXO" : "UTXOs"}
            </p>
          )}
        </div>

        {/* Outputs */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="label mb-0">
              Recipients ({outputs.length}/16)
            </span>
            <button
              type="button"
              className="btn-ghost"
              onClick={addRow}
              disabled={outputs.length >= 16 || pending}
            >
              + Add recipient
            </button>
          </div>
          {outputs.map((o, i) => (
            <RecipientRow
              key={i}
              index={i}
              value={o}
              recents={recents}
              canRemove={outputs.length > 1}
              disabled={pending}
              onChange={(patch) => updateOutput(i, patch)}
              onRemove={() => removeRow(i)}
            />
          ))}
        </div>

        {/* Fee + total */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Fee rate (priority)</label>
            <input
              className="input"
              value={feeRate}
              onChange={(e) => setFeeRate(e.target.value)}
              disabled={pending}
              inputMode="numeric"
            />
            <p className="help">
              <span className="font-medium text-neutral-300">1</span> = the
              cheapest fee the network accepts — fine when the chain isn't
              busy. Miners pack transactions by fee-per-size, so raise this
              to jump the queue when blocks are full. The actual fee scales
              with the transaction's size.
            </p>
          </div>
          <div>
            <label className="label">Total to send</label>
            <div className="amount-md mt-1.5">
              {formatExfer(totalExfers)}
            </div>
            <p className="help">Plus the network fee — settled at broadcast.</p>
          </div>
        </div>

        {error && <div className="banner-error">{error}</div>}

        <button
          type="submit"
          className="btn w-full text-base"
          disabled={
            pending || !balance || balance.entries.length === 0
          }
        >
          {pending ? "Broadcasting…" : "Review & broadcast"}
        </button>
      </form>

      {receipt && <ReceiptCard receipt={receipt} />}
    </div>
  );
}

function RecipientRow({
  index,
  value,
  recents,
  canRemove,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  value: OutputRow;
  recents: string[];
  canRemove: boolean;
  disabled: boolean;
  onChange: (patch: Partial<OutputRow>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Recipient {index + 1}
        </span>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="btn-ghost text-xs"
            disabled={disabled}
          >
            Remove
          </button>
        )}
      </div>
      <div className="grid grid-cols-[1.5fr_1fr] gap-3">
        <div>
          <label className="label">Address (64 hex)</label>
          <input
            className="input font-mono text-xs"
            placeholder="e.g. 4dce3ee577…"
            value={value.to}
            onChange={(e) => onChange({ to: e.target.value })}
            disabled={disabled}
            list={`recents-${index}`}
            autoComplete="off"
          />
          <datalist id={`recents-${index}`}>
            {recents.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="label">Amount (EXFER)</label>
          <input
            className="input"
            placeholder="0.01"
            value={value.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
            disabled={disabled}
            inputMode="decimal"
          />
        </div>
      </div>
    </div>
  );
}

function ReceiptCard({ receipt }: { receipt: TransferReceipt }) {
  return (
    <section className="card-padded space-y-4 fade-in">
      <div className="flex items-center gap-2">
        <span className="pill pill-success text-sm">✓ Broadcast</span>
        <span className="text-sm text-neutral-400">
          built at height {receipt.built_at_height}
        </span>
      </div>

      <div>
        <div className="label">Transaction ID</div>
        <div className="flex gap-2">
          <code className="addr flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
            {receipt.tx_id}
          </code>
          <CopyButton text={receipt.tx_id} className="btn-secondary" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Fee" value={formatExfer(receipt.fee)} />
        <Stat label="Size" value={`${receipt.size} bytes`} />
        <Stat
          label="I/O"
          value={`${receipt.inputs.length} in · ${receipt.outputs.length} out`}
        />
      </div>

      <p className="text-sm text-neutral-400">
        Tracking the confirmation? Head to the{" "}
        <span className="font-medium text-neutral-300">Activity</span> tab —
        we logged this transfer there.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </div>
      <div className="mt-1 font-mono text-sm font-semibold text-neutral-100 tabular-nums">
        {value}
      </div>
    </div>
  );
}
