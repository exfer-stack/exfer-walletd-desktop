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
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";

interface OutputRow {
  to: string;
  amount: string;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function Send() {
  const { balance, refresh, utxos, refreshUtxos, suspendPolling } = useWallet();
  const toast = useToast();
  const { t } = useT();

  // Suspend the background balance poll + SSE-triggered refreshes for as long
  // as the Send screen is open, so the per-IP scan-rate budget is reserved for
  // simulate_transfer + the transfer itself (otherwise a poll firing mid-send
  // tips a normal transfer into "network is busy"). Matches the mobile wallet.
  useEffect(() => suspendPolling(), [suspendPolling]);
  const [from, setFrom] = useState("");
  const [outputs, setOutputs] = useState<OutputRow[]>([
    { to: "", amount: "" },
  ]);
  // Fee priority: a multiplier over the network minimum. Most transfers
  // pay the minimum (Normal). Higher tiers bump fee-per-size so the tx
  // is packed sooner when blocks are congested.
  // No fee picker: every transfer pays the network minimum (the right choice
  // almost always); the exact amount is computed per-transaction below.
  const feeRate = 1;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);
  const recents = useMemo(listRecentRecipients, [receipt]);
  // Live fee estimate: the fee at rate 1 (= the tx's cost in exfers) for the
  // current template. Each tier's fee is `rate × baseFee`, since fee is linear
  // in the rate. null until there's a complete, valid template to simulate.
  const [baseFee, setBaseFee] = useState<number | null>(null);

  // Don't offer hidden addresses as a sending source.
  const sendable = (balance?.entries ?? []).filter((e) => !isHidden(e.address));

  // Fully-parsed outputs, or [] if any recipient is incomplete/invalid (we
  // can't estimate a fee for a template that wouldn't build).
  const validOutputs = useMemo(() => {
    const out: { to: string; amount: number }[] = [];
    for (const o of outputs) {
      if (!HEX64.test(o.to.trim())) return [];
      try {
        out.push({
          to: o.to.trim().toLowerCase(),
          amount: parseExferAmount(o.amount),
        });
      } catch {
        return [];
      }
    }
    return out;
  }, [outputs]);

  // Debounced simulate_transfer (no broadcast) → the real fee for this exact
  // template. Updates as recipients change. null on any error (e.g. funds).
  useEffect(() => {
    if (!from || validOutputs.length === 0) {
      setBaseFee(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const sim = await rpc<{ fee: number }>("simulate_transfer", {
          from,
          outputs: validOutputs,
          fee_rate: 1,
        });
        if (!cancelled) setBaseFee(sim.fee);
      } catch {
        if (!cancelled) setBaseFee(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [from, validOutputs]);

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
      setError(t("snd.pickFrom"));
      return;
    }
    const feeRateInt = feeRate;

    const parsedOutputs: { to: string; amount: number }[] = [];
    for (let i = 0; i < outputs.length; i++) {
      const o = outputs[i];
      if (!HEX64.test(o.to.trim())) {
        setError(t("snd.recipBadAddr", { n: i + 1 }));
        return;
      }
      try {
        const amt = parseExferAmount(o.amount);
        parsedOutputs.push({ to: o.to.trim().toLowerCase(), amount: amt });
      } catch (err) {
        setError(t("snd.recipPrefix", { n: i + 1 }) + humanizeError(err));
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
      toast.success(
        t("snd.broadcastTitle"),
        t("snd.broadcastBody", { amt: formatExfer(sent) }),
      );
      // Pull fresh balances so the Dashboard/From dropdown reflect the
      // spend immediately instead of waiting for the next poll.
      refresh();
      refreshUtxos();
      // Reset the recipient rows for the next send; keep `from`.
      setOutputs([{ to: "", amount: "" }]);
    } catch (e) {
      setError(humanizeError(e));
      toast.error(t("snd.failedTitle"), humanizeError(e));
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
          {t("snd.title")}
        </h1>
        <p className="text-base text-neutral-400">
          {t("snd.subtitle")}
        </p>
      </header>

      <form onSubmit={onSubmit} className="card-padded space-y-6">
        {/* From */}
        <div>
          <label className="label">{t("snd.from")}</label>
          {sendable.length === 0 ? (
            <p className="help">{t("snd.noAddresses")}</p>
          ) : (
            // Selectable list rather than a bare <select>: every address and
            // its (spendable) balance is visible at once, with the chosen one
            // highlighted. Max 6 addresses, so the list never gets long.
            <div className="space-y-2" role="radiogroup" aria-label={t("snd.fromAria")}>
              {sendable.map((e) => {
                const label = getLabel(e.address);
                const name =
                  label ??
                  (e.imported ? t("snd.imported") : t("snd.addressN", { n: e.index ?? "" }));
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
                          title={t("snd.pendingDotTitle")}
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
              {t("snd.spendableLabel")}{" "}
              <span className="font-medium text-neutral-300">
                {formatExfer(fromEntry.balance)}
              </span>
              {fromUtxoCount != null && (
                <>
                  {" "}
                  ·{" "}
                  {fromUtxoCount === 1
                    ? t("snd.utxo1", { n: fromUtxoCount })
                    : t("snd.utxoN", { n: fromUtxoCount })}
                </>
              )}
              {/* An incoming deposit shows in the balance instantly, but it
                  can't be spent until it confirms — say so right here. */}
              {(fromEntry.pending_received ?? 0) > 0 && (
                <>
                  {" "}
                  ·{" "}
                  <span className="text-neutral-500">
                    {t("snd.stillConfirming", {
                      amt: formatExfer(fromEntry.pending_received ?? 0),
                    })}
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
              {t("snd.recipients", { n: outputs.length })}
            </span>
            <button
              type="button"
              className="btn-ghost"
              onClick={addRow}
              disabled={outputs.length >= 16 || pending}
            >
              {t("snd.addRecipient")}
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

        {/* Total + the auto network fee. No tier picker: the fee is the
            network minimum, computed for this exact transaction. */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-neutral-400">{t("snd.totalToSend")}</span>
            <span className="amount-md">{formatExfer(totalExfers)}</span>
          </div>
          <div className="mt-1.5 flex items-baseline justify-between text-xs text-neutral-500">
            <span>{t("snd.networkFee")}</span>
            <span className="font-mono tabular-nums">
              {baseFee != null
                ? "≈ " + formatExfer(baseFee)
                : t("snd.networkMinimum")}
            </span>
          </div>
        </div>

        {error && <div className="banner-error">{error}</div>}

        <button
          type="submit"
          className="btn w-full text-base"
          disabled={pending || sendable.length === 0}
        >
          {pending ? t("snd.broadcasting") : t("snd.reviewBroadcast")}
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
  const { t } = useT();
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          {t("snd.recipientN", { n: index + 1 })}
        </span>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="btn-ghost text-xs"
            disabled={disabled}
          >
            {t("snd.remove")}
          </button>
        )}
      </div>
      <div className="grid grid-cols-[1.5fr_1fr] gap-3">
        <div>
          <label className="label">{t("snd.addrField")}</label>
          <input
            className="input font-mono text-xs"
            placeholder={t("snd.addrPlaceholder")}
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
          <label className="label">{t("snd.amountField")}</label>
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
  const { t } = useT();
  return (
    <section className="card-padded space-y-4 fade-in">
      <div className="flex items-center gap-2">
        <span className="pill pill-success text-sm">{t("snd.broadcastPill")}</span>
        <span className="text-sm text-neutral-400">
          {t("snd.builtAtHeight", { h: receipt.built_at_height })}
        </span>
      </div>

      <div>
        <div className="label">{t("snd.txId")}</div>
        <div className="flex gap-2">
          <code className="addr flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
            {receipt.tx_id}
          </code>
          <CopyButton text={receipt.tx_id} className="btn-secondary" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Stat label={t("snd.statFee")} value={formatExfer(receipt.fee)} />
        <Stat
          label={t("snd.statSize")}
          value={t("snd.bytes", { n: receipt.size })}
        />
        <Stat
          label={t("snd.statIO")}
          value={t("snd.ioValue", {
            in: receipt.inputs.length,
            out: receipt.outputs.length,
          })}
        />
      </div>

      <p className="text-sm text-neutral-400">
        {t("snd.activityNotePre")}{" "}
        <span className="font-medium text-neutral-300">
          {t("snd.activityTab")}
        </span>{" "}
        {t("snd.activityNotePost")}
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
