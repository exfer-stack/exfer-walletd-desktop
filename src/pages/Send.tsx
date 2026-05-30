import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  rpc,
  parseExferAmount,
  formatExfer,
  formatBalanceCompact,
} from "../lib/rpc";
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
import { isHidden } from "../lib/hidden";

interface OutputRow {
  to: string;
  amount: string;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function Send() {
  const { balance, refresh, utxos, refreshUtxos } = useWallet();
  const toast = useToast();
  const [from, setFrom] = useState("");
  const [outputs, setOutputs] = useState<OutputRow[]>([
    { to: "", amount: "" },
  ]);
  // Fee priority: a multiplier over the network minimum. Most transfers
  // pay the minimum (Normal). Higher tiers bump fee-per-size so the tx
  // is packed sooner when blocks are congested.
  const [feeRate, setFeeRate] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);
  const recents = useMemo(listRecentRecipients, [receipt]);

  // Don't offer hidden addresses as a sending source.
  const sendable = (balance?.entries ?? []).filter((e) => !isHidden(e.address));

  useEffect(() => {
    if (sendable.length > 0 && !from) {
      setFrom(sendable[0].address);
    }
  }, [sendable, from]);

  // UTXO counts aren't polled; fetch them once so the "from" helper can
  // show how many UTXOs back the selected address.
  useEffect(() => {
    refreshUtxos();
  }, [refreshUtxos]);

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
    const feeRateInt = feeRate;

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
      refreshUtxos();
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
  const fromUtxoCount = utxos[from]?.utxo_count;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          Send EXFER
        </h1>
        <p className="text-base text-neutral-400">
          One transaction, up to 16 recipients. Pick a fee priority below —
          Normal is fine for most transfers.
        </p>
      </header>

      <form onSubmit={onSubmit} className="card-padded space-y-6">
        {/* From */}
        <div>
          <label className="label">From</label>
          {sendable.length === 0 ? (
            <p className="help">No addresses — generate one first.</p>
          ) : (
            // Selectable list rather than a bare <select>: every address and
            // its (spendable) balance is visible at once, with the chosen one
            // highlighted. Max 6 addresses, so the list never gets long.
            <div className="space-y-2" role="radiogroup" aria-label="From address">
              {sendable.map((e) => {
                const label = getLabel(e.address);
                const name =
                  label ?? (e.imported ? "Imported" : `Address ${e.index}`);
                const selected = from === e.address;
                const hasPending = (e.pending_received ?? 0) > 0;
                return (
                  <button
                    key={e.address}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setFrom(e.address)}
                    disabled={pending}
                    className={
                      "flex w-full items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-left transition disabled:opacity-50 " +
                      (selected
                        ? "border-cyan-400 bg-cyan-500/10"
                        : "border-neutral-700 bg-neutral-950 hover:border-neutral-600")
                    }
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-neutral-100">
                        {name}
                      </div>
                      <code className="addr-xs text-neutral-500">
                        {shortAddress(e.address)}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {hasPending && (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-neutral-600"
                          title="has an incoming deposit still confirming"
                        />
                      )}
                      <span
                        className="font-mono text-sm font-medium tabular-nums text-neutral-100"
                        title={formatExfer(e.balance)}
                      >
                        {formatBalanceCompact(e.balance)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {fromEntry && (
            <p className="help mt-2">
              Spendable:{" "}
              <span className="font-medium text-neutral-300">
                {formatExfer(fromEntry.balance)}
              </span>
              {fromUtxoCount != null && (
                <>
                  {" "}
                  · {fromUtxoCount} {fromUtxoCount === 1 ? "UTXO" : "UTXOs"}
                </>
              )}
              {/* An incoming deposit shows in the balance instantly, but it
                  can't be spent until it confirms — say so right here. */}
              {(fromEntry.pending_received ?? 0) > 0 && (
                <>
                  {" "}
                  ·{" "}
                  <span className="text-neutral-500">
                    {formatExfer(fromEntry.pending_received ?? 0)} still
                    confirming, not yet spendable
                  </span>
                </>
              )}
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

        {/* Network fee priority */}
        <div>
          <label className="label">Network fee</label>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { rate: 1, name: "Normal", approx: "≈ 0.0000007 EXFER", note: "recommended" },
                { rate: 3, name: "Faster", approx: "≈ 0.000002 EXFER", note: "" },
                { rate: 6, name: "Fastest", approx: "≈ 0.000004 EXFER", note: "" },
              ] as const
            ).map((tier) => {
              const active = feeRate === tier.rate;
              return (
                <button
                  key={tier.rate}
                  type="button"
                  onClick={() => setFeeRate(tier.rate)}
                  disabled={pending}
                  className={
                    "rounded-lg border px-3 py-2.5 text-left transition " +
                    (active
                      ? "border-cyan-400 bg-cyan-500/10"
                      : "border-neutral-700 bg-neutral-950 hover:border-neutral-600")
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-neutral-100">
                      {tier.name}
                    </span>
                    {tier.note && (
                      <span className="pill pill-info text-[10px]">
                        {tier.note}
                      </span>
                    )}
                  </div>
                  <div className="mono mt-0.5 text-xs text-neutral-400">
                    {tier.approx}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="help">
            Fees are tiny — well under a millionth of 1 EXFER. Normal pays the
            network minimum and confirms fine when the chain isn't busy;
            pick a higher tier only if transfers are slow to confirm. The
            exact fee is shown on the receipt.
          </p>
        </div>

        {/* Total */}
        <div className="flex items-baseline justify-between rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3">
          <span className="text-sm text-neutral-400">Total to send</span>
          <span className="amount-md">{formatExfer(totalExfers)}</span>
        </div>

        {error && <div className="banner-error">{error}</div>}

        <button
          type="submit"
          className="btn w-full text-base"
          disabled={pending || sendable.length === 0}
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
