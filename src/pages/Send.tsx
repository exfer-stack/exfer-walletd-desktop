import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  rpc,
  parseExferAmount,
  formatExfer,
  formatExferInput,
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
  // No fee picker: every transfer pays the network minimum (rate 1).
  const feeRate = 1;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);
  const recents = useMemo(listRecentRecipients, [receipt]);
  // Live fee estimate: the fee at rate 1 (= the tx's cost in exfers) for the
  // current template. null until there's a complete, valid template to simulate.
  const [baseFee, setBaseFee] = useState<number | null>(null);
  // Which recipient row (if any) is pinned to "Max". Its amount auto-tracks
  // (balance − fee − other rows) so it stays exact as the fee re-simulates and
  // never trips the insufficient-funds guard. Cleared when that row's amount is
  // edited by hand, or when any row is removed (indices shift).
  const [maxRow, setMaxRow] = useState<number | null>(null);

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

  // Sum of every row except the pinned "Max" row — what Max has to leave room
  // for. Bad/empty amounts count as 0.
  const othersTotal = useMemo(() => {
    if (maxRow === null) return 0;
    return outputs.reduce((s, o, k) => {
      if (k === maxRow) return s;
      try {
        return s + parseExferAmount(o.amount);
      } catch {
        return s;
      }
    }, 0);
  }, [outputs, maxRow]);

  // Keep the Max row exact. Re-runs when the fee re-simulates (`baseFee`) or the
  // other rows change (`othersTotal`), so "send max" respects amounts already
  // entered elsewhere and lands exactly on balance − fee — never over. Writing
  // the Max row doesn't change `othersTotal` (it's excluded), so this can't
  // loop; it converges once the simulated fee settles.
  useEffect(() => {
    if (maxRow === null) return;
    const fromEnt = balance?.entries.find((e) => e.address === from);
    const bal = fromEnt?.balance ?? 0;
    // Until the real fee simulates, reserve a UTXO-sized floor (~69 exfers/input)
    // so the FIRST Max fill leaves room for the fee — otherwise it fills 100%,
    // simulate_transfer fails ("insufficient: amount + fee"), baseFee stays null,
    // and it never converges. Once baseFee lands it takes over (tighter + exact).
    const feeFloor = Math.max(2000, (fromEnt?.utxo_count ?? 1) * 500);
    const avail = Math.max(0, bal - (baseFee ?? feeFloor) - othersTotal);
    // NON-grouped — formatExfer adds commas for ≥1,000 EXFER, which
    // parseExferAmount rejects (Max would silently become unsendable).
    const amt = formatExferInput(avail);
    setOutputs((prev) => {
      if (maxRow >= prev.length || prev[maxRow].amount === amt) return prev;
      return prev.map((o, k) => (k === maxRow ? { ...o, amount: amt } : o));
    });
  }, [baseFee, othersTotal, maxRow, from, balance]);

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
    // Indices shift on removal — drop the Max pin rather than track it wrong.
    setMaxRow(null);
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

    // Guard a zero-value send (e.g. Max on a drained address fills "0"): the
    // daemon would reject it, but a clear message beats a raw error — and it
    // stops a pointless fee-only broadcast.
    if (parsedOutputs.reduce((a, o) => a + o.amount, 0) <= 0) {
      setError(t("snd.enterAmount"));
      return;
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

  function sendAnother() {
    setReceipt(null);
    setError(null);
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
    <div className="mx-auto max-w-6xl space-y-4 p-6 fade-in">
      {/* Compact top bar: title left, live total + fee right. No subtitle. */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight text-neutral-100">
          {t("snd.title")}
        </h1>
        <div className="flex items-baseline gap-2 text-sm">
          <span className="text-neutral-500">{t("snd.totalShort")}</span>
          <span className="amount-md text-neutral-100">
            {formatExfer(totalExfers)}
          </span>
          <span className="font-mono tabular-nums text-neutral-500">
            ·{" "}
            {t("snd.feeShort")}{" "}
            {baseFee != null
              ? "≈" + formatExfer(baseFee)
              : t("snd.networkMinimum")}
          </span>
        </div>
      </div>

      <div className="card-padded grid grid-cols-[300px_1fr] items-start gap-6 divide-x divide-neutral-800">
        {/* LEFT — source picker. Stays visible through the receipt. */}
        <div className="space-y-2 pr-6">
          <label className="label">{t("snd.from")}</label>
          {sendable.length === 0 ? (
            <p className="help">{t("snd.noAddresses")}</p>
          ) : (
            <div
              className="space-y-1.5"
              role="radiogroup"
              aria-label={t("snd.fromAria")}
            >
              {sendable.map((e) => {
                const label = getLabel(e.address);
                const name =
                  label ??
                  (e.imported
                    ? t("snd.imported")
                    : t("snd.addressN", { n: e.index ?? "" }));
                const selected = from === e.address;
                const hasPending = (e.pending_received ?? 0) > 0;
                const pendingTitle =
                  hasPending
                    ? t("snd.stillConfirming", {
                        amt: formatExfer(e.pending_received ?? 0),
                      })
                    : t("snd.pendingDotTitle");
                return (
                  <button
                    key={e.address}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setFrom(e.address)}
                    disabled={pending}
                    className={
                      "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition disabled:opacity-50 " +
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
                    <div className="flex shrink-0 items-center gap-1.5">
                      {hasPending && (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-amber-500"
                          title={pendingTitle}
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
          {/* UTXO count chip on the selected source only. */}
          {fromEntry && fromUtxoCount != null && (
            <div className="pt-0.5">
              <span className="font-mono text-xs text-neutral-500">
                {fromUtxoCount === 1
                  ? t("snd.utxo1", { n: fromUtxoCount })
                  : t("snd.utxoN", { n: fromUtxoCount })}
              </span>
            </div>
          )}
        </div>

        {/* RIGHT — recipients + send, OR the receipt (swaps in place). */}
        {receipt ? (
          <div className="pl-6">
            <Receipt receipt={receipt} onSendAnother={sendAnother} />
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4 pl-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="label mb-0">
                  {outputs.length > 1
                    ? t("snd.recipientsCount", { n: outputs.length })
                    : t("snd.recipientSingle")}
                </span>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={addRow}
                  disabled={outputs.length >= 16 || pending}
                  aria-label={t("snd.addRecipient")}
                  title={t("snd.addRecipient")}
                >
                  + {t("snd.add")}
                </button>
              </div>

              {/* One-time column headers above the dense row list. */}
              <div className="grid grid-cols-[1.6fr_minmax(120px,0.8fr)_auto] items-center gap-2">
                <span className="label mb-0 pl-3.5">{t("snd.addrCol")}</span>
                <span className="label mb-0 pr-3.5 text-right">
                  {t("snd.amountCol")}
                </span>
                <span className="h-7 w-7" aria-hidden />
              </div>

              {outputs.map((o, i) => (
                <RecipientRow
                  key={i}
                  index={i}
                  value={o}
                  recents={recents}
                  canRemove={outputs.length > 1}
                  disabled={pending}
                  isMax={maxRow === i}
                  onToggleMax={() => setMaxRow(maxRow === i ? null : i)}
                  onChange={(patch) => updateOutput(i, patch)}
                  onAmountEdit={() => {
                    // A manual edit releases the Max pin on this row.
                    if (maxRow === i) setMaxRow(null);
                  }}
                  onRemove={() => removeRow(i)}
                />
              ))}
            </div>

            {error && <div className="banner-error">{error}</div>}

            <div className="flex items-center justify-end">
              <button
                type="submit"
                className="btn"
                disabled={pending || sendable.length === 0}
              >
                {pending ? t("snd.broadcasting") : t("snd.broadcast")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function RecipientRow({
  index,
  value,
  recents,
  canRemove,
  disabled,
  isMax,
  onToggleMax,
  onChange,
  onAmountEdit,
  onRemove,
}: {
  index: number;
  value: OutputRow;
  recents: string[];
  canRemove: boolean;
  disabled: boolean;
  isMax: boolean;
  onToggleMax: () => void;
  onChange: (patch: Partial<OutputRow>) => void;
  onAmountEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  // Inline per-row validation: a non-empty address that isn't 64 hex tints
  // this row's input red. Empty (not yet typed) stays neutral.
  const addrInvalid =
    value.to.trim().length > 0 && !HEX64.test(value.to.trim());
  return (
    <div className="grid grid-cols-[1.6fr_minmax(120px,0.8fr)_auto] items-center gap-2">
      <input
        className={
          "input font-mono text-xs " +
          (addrInvalid ? "border-red-500/70 focus:border-red-500" : "")
        }
        placeholder={t("snd.addrPlaceholder")}
        value={value.to}
        onChange={(e) => onChange({ to: e.target.value })}
        disabled={disabled}
        list={`recents-${index}`}
        autoComplete="off"
        aria-invalid={addrInvalid}
      />
      <datalist id={`recents-${index}`}>
        {recents.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <div className="flex items-center gap-1.5">
        <input
          className="input flex-1 text-right font-mono tabular-nums"
          placeholder="0.01"
          value={value.amount}
          onChange={(e) => {
            // A manual edit releases the Max pin on this row.
            onAmountEdit();
            onChange({ amount: e.target.value });
          }}
          disabled={disabled}
          inputMode="decimal"
        />
        <button
          type="button"
          onClick={onToggleMax}
          disabled={disabled}
          aria-pressed={isMax}
          className={
            "btn-ghost shrink-0 border px-2 py-1 text-xs disabled:opacity-30 " +
            (isMax
              ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
              : "border-transparent")
          }
          title={t("snd.max")}
        >
          {t("snd.max")}
        </button>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="btn-ghost flex h-7 w-7 items-center justify-center p-0 disabled:opacity-30"
        disabled={disabled || !canRemove}
        aria-label={t("snd.remove")}
        title={t("snd.remove")}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3 6h18" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      </button>
    </div>
  );
}

function Receipt({
  receipt,
  onSendAnother,
}: {
  receipt: TransferReceipt;
  onSendAnother: () => void;
}) {
  const { t } = useT();
  return (
    <section className="space-y-4 fade-in">
      <div className="flex items-center gap-2">
        <span className="pill pill-success text-sm">
          {t("snd.broadcastPill")}
        </span>
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

      <div className="flex justify-end">
        <button type="button" className="btn-ghost" onClick={onSendAnother}>
          {t("snd.sendAnother")}
        </button>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold text-neutral-100 tabular-nums">
        {value}
      </div>
    </div>
  );
}
