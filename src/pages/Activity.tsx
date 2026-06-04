import { useEffect, useMemo, useState } from "react";
import { rpc, formatExfer } from "../lib/rpc";
import {
  listHistory,
  clearHistory,
  loadConfirmed,
  rememberConfirmed,
  type HistoryEntry,
} from "../lib/history";
import { getLabel, shortAddress } from "../lib/labels";
import { CopyButton } from "../components/CopyButton";
import { useT, type MsgKey } from "../lib/i18n";
import { txExplorerUrl } from "../lib/format";
import { getSwapUsd } from "../lib/swapPrice";

const EXPLORER = "https://explorer.exfer.dev";
const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;

// New act.* / swap-record keys live in Activity for now (the i18n dictionary is
// updated separately). Cast through MsgKey so the typed t()/interpolation still
// works for these keys.
type AnyKey = MsgKey | string;

/** A hash shown as: optional label, short form, copy button, and an
 *  "open in explorer" link — so the bare hex is never a dead end. */
function HashLine({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href: string;
}) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-xs text-neutral-500">{label}</span>
      <code className="addr-xs flex-1 truncate">{shortAddress(value, 10, 8)}</code>
      <CopyButton text={value} className="btn-ghost text-xs" />
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="rounded-md px-1.5 py-0.5 text-xs text-cyan-400 hover:bg-neutral-800"
        title={t("act.viewExplorer")}
      >
        ↗
      </a>
    </div>
  );
}

interface TxStatus {
  in_mempool: boolean;
  block_height?: number;
  block_id?: string;
}

/** A swap record from walletd's journal (serde snake_case). A cross-chain swap
 *  shows as one labeled record (both legs + status), not just its raw EXFER
 *  transfer. Verified against the live walletd `swap_list` shape. */
interface SwapRow {
  swap_id: string;
  direction: "exfer_to_bnb" | "bnb_to_exfer";
  status: string;
  amount_in: string;
  amount_out: string;
  fee_bps?: number;
  created_at: number;
  updated_at: number;
  // The swap's own EXFER-leg tx ids, so we can hide them from the raw transfer
  // feed (a swap shows once as a unified record, not twice).
  user_lock_tx?: string | null;
  pool_lock_ref?: string | null;
  claim_tx?: string | null;
  refund_tx?: string | null;
  error?: string | null;
}

// Statuses that are terminal — anything else is still in flight.
const SWAP_TERMINAL = new Set(["quoted", "completed", "refunded", "failed"]);

/** Trim a decimal string to a few significant places (amounts come from the
 *  journal as exact strings). Keeps tiny BNB values readable. */
function fmtAmt(s: string, dp = 4): string {
  if (!s) return s;
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, dp).replace(/0+$/, "");
  if (!frac && w === "0") {
    const n = Number(s);
    if (isFinite(n) && n !== 0) {
      return n.toLocaleString("en-US", {
        maximumSignificantDigits: 4,
        useGrouping: false,
      });
    }
  }
  return frac ? `${w}.${frac}` : w;
}

/** Swap status → label key + pill class (desktop pill vocabulary). */
function swapPill(status: string): { key: AnyKey; cls: string } {
  switch (status) {
    case "completed":
      return { key: "act.swapCompleted", cls: "pill-success" };
    case "refunded":
      return { key: "act.swapRefunded", cls: "pill-warn" };
    case "failed":
      return { key: "act.swapFailed", cls: "pill-error" };
    default:
      return { key: "act.swapInProgress", cls: "pill-info" };
  }
}

export function Activity() {
  const { t } = useT();
  // Cast helper so the not-yet-in-dictionary act.* keys still interpolate.
  const tx = (key: AnyKey, vars?: Record<string, string | number>) =>
    t(key as MsgKey, vars);
  const [version, bump] = useState(0); // bump to force reload
  const rawHistory = useMemo(listHistory, [version]);
  // Seed from the confirmed-tx cache so already-mined transfers render as
  // "confirmed" immediately instead of flashing "checking" on every visit.
  const [statuses, setStatuses] = useState<Record<string, TxStatus | "error">>(
    () => {
      const cached = loadConfirmed();
      const seed: Record<string, TxStatus> = {};
      for (const [tx_id, c] of Object.entries(cached)) {
        seed[tx_id] = { in_mempool: false, block_height: c.block_height, block_id: c.block_id };
      }
      return seed;
    },
  );
  const [polling, setPolling] = useState(false);

  // Cross-chain swaps live in walletd's journal, not the EXFER history log —
  // surface them as their own labeled records. swap_list throws when the swap
  // engine isn't configured, so a failure just clears the swap section.
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const all = await rpc<SwapRow[]>("swap_list");
        if (cancelled) return;
        // Drop bare quotes (no funds moved); show everything that locked.
        const real = (all ?? []).filter((s) => s.status !== "quoted");
        real.sort((a, b) => b.created_at - a.created_at);
        setSwaps(real);
      } catch {
        if (!cancelled) setSwaps([]);
      }
    };
    load();
    const id = window.setInterval(load, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Hide the EXFER legs that belong to a swap — they're already represented by
  // the unified swap record, so showing the raw transfer too would double-count.
  const swapTxIds = useMemo(() => {
    const s = new Set<string>();
    for (const sw of swaps) {
      for (const tx of [sw.user_lock_tx, sw.claim_tx, sw.refund_tx]) if (tx) s.add(tx);
    }
    return s;
  }, [swaps]);
  const history = useMemo(
    () => rawHistory.filter((h) => !swapTxIds.has(h.tx_id)),
    [rawHistory, swapTxIds],
  );

  const inflight = useMemo(
    () => swaps.filter((s) => !SWAP_TERMINAL.has(s.status)),
    [swaps],
  );

  async function refreshOne(tx_id: string) {
    try {
      const r = await rpc<{
        in_mempool: boolean;
        block_height?: number;
        block_id?: string;
      }>("get_transaction", { tx_id });
      setStatuses((s) => ({
        ...s,
        [tx_id]: {
          in_mempool: r.in_mempool,
          block_height: r.block_height,
          block_id: r.block_id,
        },
      }));
      // A height is final — cache it so future visits skip the lookup.
      if (r.block_height != null) {
        rememberConfirmed(tx_id, r.block_height, r.block_id);
      }
    } catch {
      setStatuses((s) => ({ ...s, [tx_id]: "error" }));
    }
  }

  async function refreshAll(force = false) {
    setPolling(true);
    try {
      const targets = force
        ? history
        : history.filter((h) => {
            const st = statuses[h.tx_id];
            // Skip rows already known confirmed (seeded from cache).
            return !(st && st !== "error" && st.block_height != null);
          });
      await Promise.all(targets.map((h) => refreshOne(h.tx_id)));
    } finally {
      setPolling(false);
    }
  }

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-poll while any tx hasn't confirmed yet. get_transaction is a
  // point lookup (not the UTXO-scan rate-limit bucket), so a 15s cadence
  // is safe. Stops once everything is confirmed/settled.
  useEffect(() => {
    const id = window.setInterval(() => {
      const unsettled = history.filter((h) => {
        const st = statuses[h.tx_id];
        return !(st && st !== "error" && st.block_height != null);
      });
      if (unsettled.length === 0) return; // nothing to chase
      unsettled.forEach((h) => refreshOne(h.tx_id));
    }, 15_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, statuses]);

  if (history.length === 0 && swaps.length === 0) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
            {t("act.title")}
          </h1>
          <p className="text-base text-neutral-400">{t("act.emptyDesc")}</p>
        </header>
        <div className="card-padded text-center text-sm text-neutral-400">
          {t("act.emptyState")}
        </div>
      </div>
    );
  }

  const n = history.length + swaps.length; // swaps + transfers on record

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-8 fade-in">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
            {t("act.title")}
          </h1>
          <p className="text-base text-neutral-400">
            {n === 1 ? tx("act.countOne", { n }) : tx("act.countMany", { n })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => refreshAll(true)}
            disabled={polling}
            className="btn-ghost"
          >
            {polling ? t("act.refreshing") : t("act.refresh")}
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm(t("act.clearConfirm"))) {
                clearHistory();
                bump((v) => v + 1);
              }
            }}
            className="btn-ghost text-red-600 hover:bg-red-500/10"
          >
            {t("act.clearLog")}
          </button>
        </div>
      </header>

      {/* In-flight swaps — a compact strip at the very top so an active swap is
          impossible to miss while it settles. */}
      {inflight.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            {tx("act.swapInProgress")}
          </h2>
          <div className="space-y-2">
            {inflight.map((s) => (
              <InflightSwapCard key={s.swap_id} s={s} />
            ))}
          </div>
        </section>
      )}

      {/* Settled swaps — the cross-chain analogue of the transfer log. */}
      {swaps.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            {tx("act.swaps")}
          </h2>
          <div className="space-y-3">
            {swaps.map((s) => (
              <SwapCard key={s.swap_id} swap={s} />
            ))}
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            {tx("act.transfers")}
          </h2>
          <div className="space-y-3">
            {history.map((h) => (
              <ActivityCard key={h.tx_id} entry={h} status={statuses[h.tx_id]} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Compact in-flight swap line — spinner + "X EXFER → Y BNB" + a status word. */
function InflightSwapCard({ s }: { s: SwapRow }) {
  const { t } = useT();
  const tx = (key: AnyKey, vars?: Record<string, string | number>) =>
    t(key as MsgKey, vars);
  const sell = s.direction === "exfer_to_bnb";
  const inUnit = sell ? "EXFER" : "BNB";
  const outUnit = sell ? "BNB" : "EXFER";
  return (
    <div className="card flex items-center gap-3 px-5 py-3">
      <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-neutral-600 border-t-cyan-400" />
      <div className="flex-1 text-sm text-neutral-200">
        <span className="amount">{fmtAmt(s.amount_in)}</span> {inUnit}
        {" → "}
        <span className="amount">{fmtAmt(s.amount_out)}</span> {outUnit}
      </div>
      <span className="text-xs text-neutral-400">{tx("act.swapStatusLine", { status: s.status })}</span>
    </div>
  );
}

/** A settled swap as one record: direction + amounts + status pill, expandable
 *  to the executed rate, price-then, fee, times and on-chain references. */
function SwapCard({ swap: s }: { swap: SwapRow }) {
  const { t } = useT();
  const tx = (key: AnyKey, vars?: Record<string, string | number>) =>
    t(key as MsgKey, vars);
  const [open, setOpen] = useState(false);

  const sell = s.direction === "exfer_to_bnb";
  const inUnit = sell ? "EXFER" : "BNB";
  const outUnit = sell ? "BNB" : "EXFER";
  const pill = swapPill(s.status);
  const created = new Date(s.created_at * 1000);

  // Executed rate is exact (on-chain amounts); the USD anchor is the EXFER/USD
  // spot snapshotted at execute time (per-device, may be absent for old swaps).
  const exferAmt = sell ? Number(s.amount_in) : Number(s.amount_out);
  const bnbAmt = sell ? Number(s.amount_out) : Number(s.amount_in);
  const rate = exferAmt > 0 && isFinite(bnbAmt) ? bnbAmt / exferAmt : null;
  const usdThen = getSwapUsd(s.swap_id);
  const valueThen = usdThen != null && exferAmt > 0 ? exferAmt * usdThen : null;
  const sig = (v: number) =>
    v.toLocaleString("en-US", { maximumSignificantDigits: 4, useGrouping: false });
  const usd = (u: number) =>
    u >= 1
      ? u.toFixed(2)
      : u.toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false });

  const refs: { key: AnyKey; value: string }[] = [];
  if (s.user_lock_tx) refs.push({ key: "act.refUserLock", value: s.user_lock_tx });
  if (s.pool_lock_ref) refs.push({ key: "act.refPoolLock", value: s.pool_lock_ref });
  if (s.claim_tx) refs.push({ key: "act.refClaim", value: s.claim_tx });
  if (s.refund_tx) refs.push({ key: "act.refRefund", value: s.refund_tx });

  return (
    <article className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 px-5 py-3 text-left hover:bg-neutral-800/40"
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold text-neutral-100">
            {sell ? tx("act.soldExfer") : tx("act.boughtExfer")}
          </div>
          <div className="text-xs text-neutral-500">
            {created.toLocaleDateString()} · {created.toLocaleTimeString()}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="amount text-sm text-emerald-400">
            +{fmtAmt(s.amount_out)}
            <span className="font-medium text-neutral-500"> {outUnit}</span>
          </span>
          <span className={`pill ${pill.cls}`}>{tx(pill.key)}</span>
          <span className="text-xs text-neutral-500">{open ? "▾" : "▸"}</span>
        </div>
      </button>

      {open && (
        <div className="space-y-4 border-t border-neutral-800 p-5">
          <div className="text-center text-base text-neutral-100">
            <span className="amount">{fmtAmt(s.amount_in)}</span>
            <span className="text-sm text-neutral-500"> {inUnit}</span>
            {" → "}
            <span className="amount">{fmtAmt(s.amount_out)}</span>
            <span className="text-sm text-neutral-500"> {outUnit}</span>
          </div>

          <div className="space-y-1.5">
            {rate != null && (
              <Row label={tx("act.swapRate")} value={`1 EXFER ≈ ${sig(rate)} BNB`} />
            )}
            {usdThen != null && (
              <Row label={tx("act.swapPriceThen")} value={`≈ $${usd(usdThen)}`} />
            )}
            {valueThen != null && (
              <Row label={tx("act.swapValueThen")} value={`≈ $${usd(valueThen)}`} />
            )}
            {typeof s.fee_bps === "number" && (
              <Row label={t("act.fee")} value={`${s.fee_bps / 100}%`} />
            )}
            <Row
              label={tx("act.swapCreated")}
              value={`${created.toLocaleDateString()} · ${created.toLocaleTimeString()}`}
            />
          </div>

          {refs.length > 0 && (
            <div className="space-y-2 border-t border-neutral-800 pt-4">
              {refs.map((r) => (
                <HashLine
                  key={r.value}
                  label={tx(r.key)}
                  value={r.value}
                  href={txExplorerUrl(r.value)}
                />
              ))}
            </div>
          )}

          {s.error && (
            <div className="text-sm text-red-400">{s.error}</div>
          )}
        </div>
      )}
    </article>
  );
}

function ActivityCard({
  entry,
  status,
}: {
  entry: HistoryEntry;
  status: TxStatus | "error" | undefined;
}) {
  const { t } = useT();
  const dt = new Date(entry.broadcast_at);
  const recipients = entry.outputs.filter((o) => !o.is_change);
  const change = entry.outputs.find((o) => o.is_change);

  let statusPill: { text: string; className: string };
  if (status === "error") {
    statusPill = { text: t("act.pillError"), className: "pill-warn" };
  } else if (!status) {
    statusPill = { text: t("act.pillChecking"), className: "pill-info" };
  } else if (status.block_height != null) {
    statusPill = {
      text: t("act.pillConfirmed", { h: status.block_height }),
      className: "pill-success",
    };
  } else if (status.in_mempool) {
    statusPill = { text: t("act.pillMempool"), className: "pill-info" };
  } else {
    statusPill = { text: t("act.pillNotFound"), className: "pill-warn" };
  }

  return (
    <article className="card overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-neutral-800 px-5 py-3">
        <div className="text-sm text-neutral-400">
          {dt.toLocaleDateString()} · {dt.toLocaleTimeString()}
        </div>
        <span className={`pill ${statusPill.className}`}>
          {statusPill.text}
        </span>
      </div>

      <div className="grid gap-4 p-5 md:grid-cols-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            {t("act.sentTo")}
          </div>
          <ul className="mt-2 space-y-3">
            {recipients.map((o, i) => {
              const label = getLabel(o.to);
              return (
                <li key={i} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-neutral-200">
                      {label ?? t("act.externalAddress")}
                    </span>
                    <span className="amount text-sm">
                      {formatExfer(o.amount)}
                    </span>
                  </div>
                  <HashLine label={t("act.addrLabel")} value={o.to} href={addrUrl(o.to)} />
                </li>
              );
            })}
          </ul>
        </div>
        <div className="space-y-1.5">
          <Row label={t("act.fee")} value={formatExfer(entry.fee)} />
          <Row
            label={t("act.io")}
            value={t("act.ioValue", {
              in: entry.inputs.length,
              out: entry.outputs.length,
            })}
          />
          {change && (
            <Row label={t("act.change")} value={formatExfer(change.amount)} />
          )}
          <Row label={t("act.size")} value={`${entry.size} B`} />
        </div>
      </div>

      <div className="border-t border-neutral-800 bg-neutral-900 px-5 py-3">
        <HashLine label={t("act.txId")} value={entry.tx_id} href={txUrl(entry.tx_id)} />
      </div>
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-neutral-400">{label}</span>
      <span className="amount">{value}</span>
    </div>
  );
}
