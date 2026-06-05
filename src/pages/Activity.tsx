import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { swapStatusText } from "../lib/inflight";

const EXPLORER = "https://explorer.exfer.dev";
const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;

// New act.* / swap-record keys live in Activity for now (the i18n dictionary is
// updated separately). Cast through MsgKey so the typed t()/interpolation still
// works for these keys.
type AnyKey = MsgKey | string;

/** Inline stroke icons — same idiom as Send.tsx (lucide paths, currentColor)
 *  so the row affordances and controls share one weight/baseline instead of
 *  OS-rendered Unicode/emoji glyphs. */
function Svg({
  size = 16,
  className,
  children,
}: {
  size?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

const IconRefresh = (p: { className?: string }) => (
  <Svg className={p.className}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M3 21v-5h5" />
  </Svg>
);
const IconTrash = (p: { className?: string }) => (
  <Svg className={p.className}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </Svg>
);
const IconSwap = (p: { className?: string }) => (
  <Svg size={14} className={p.className}>
    <path d="M8 3 4 7l4 4" />
    <path d="M4 7h16" />
    <path d="m16 21 4-4-4-4" />
    <path d="M20 17H4" />
  </Svg>
);
const IconArrowUp = (p: { className?: string }) => (
  <Svg size={14} className={p.className}>
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </Svg>
);
const IconArrowUpRight = (p: { className?: string }) => (
  <Svg size={14} className={p.className}>
    <path d="M7 17 17 7" />
    <path d="M7 7h10v10" />
  </Svg>
);

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
      <span className="w-20 shrink-0 whitespace-nowrap text-xs text-neutral-500">{label}</span>
      <code className="addr-xs flex-1 truncate">{shortAddress(value, 10, 8)}</code>
      <CopyButton text={value} className="btn-ghost text-xs" />
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex rounded-md p-1 text-cyan-400 hover:bg-neutral-800"
        title={t("act.viewExplorer")}
      >
        <IconArrowUpRight className="h-3.5 w-3.5" />
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

/** Transfer status → pill text + class. Pulled out so both the row and the
 *  detail panel share one vocabulary. */
function transferPill(
  t: (k: MsgKey, vars?: Record<string, string | number>) => string,
  status: TxStatus | "error" | undefined,
): { text: string; cls: string } {
  if (status === "error") return { text: t("act.pillError"), cls: "pill-warn" };
  if (!status) return { text: t("act.pillChecking"), cls: "pill-info" };
  if (status.block_height != null)
    return { text: t("act.pillConfirmed", { h: status.block_height }), cls: "pill-success" };
  if (status.in_mempool) return { text: t("act.pillMempool"), cls: "pill-info" };
  return { text: t("act.pillNotFound"), cls: "pill-warn" };
}

/** mm-dd HH:MM in Geist Mono — the dense row timestamp. */
function fmtStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// A unified, time-sorted row: a swap or a transfer. The table renders both.
type Item =
  | { kind: "swap"; id: string; ts: number; swap: SwapRow }
  | { kind: "transfer"; id: string; ts: number; entry: HistoryEntry };

export function Activity({
  onResumeSwap,
}: {
  // Tapping an in-flight swap row routes to Swap with that swap as the resume
  // target. (Activity only surfaces swaps in flight; LP ops resume from the
  // Liquidity tab via its own nav badge / resume hand-off.)
  onResumeSwap?: (swapId: string) => void;
} = {}) {
  const { t } = useT();
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
  // Two-step inline confirm for the destructive clear (avoids the unstyled
  // native confirm() dialog against the dark themed surfaces).
  const [confirmingClear, setConfirmingClear] = useState(false);

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

  // Filter segments: all / swaps only / transfers only.
  const [filter, setFilter] = useState<"all" | "swap" | "transfer">("all");
  const [selected, setSelected] = useState<string | null>(null);

  // One unified, in-flight-first then time-sorted list.
  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    for (const s of swaps)
      list.push({ kind: "swap", id: `swap:${s.swap_id}`, ts: s.created_at * 1000, swap: s });
    for (const h of history)
      list.push({
        kind: "transfer",
        id: `tx:${h.tx_id}`,
        ts: new Date(h.broadcast_at).getTime(),
        entry: h,
      });
    const inFlight = (it: Item) =>
      it.kind === "swap" && !SWAP_TERMINAL.has(it.swap.status);
    list.sort((a, b) => {
      const fa = inFlight(a) ? 1 : 0;
      const fb = inFlight(b) ? 1 : 0;
      if (fa !== fb) return fb - fa; // in-flight pinned to the top
      return b.ts - a.ts; // then newest first
    });
    return list;
  }, [swaps, history]);

  const shown = useMemo(
    () => (filter === "all" ? items : items.filter((it) => it.kind === filter)),
    [items, filter],
  );

  // Default selection = newest visible row; keep selection valid as data shifts.
  useEffect(() => {
    if (shown.length === 0) {
      if (selected !== null) setSelected(null);
      return;
    }
    if (!selected || !shown.some((it) => it.id === selected)) {
      setSelected(shown[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const n = history.length + swaps.length; // swaps + transfers on record
  const selItem = items.find((it) => it.id === selected) ?? null;

  if (history.length === 0 && swaps.length === 0) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-6">
        <h1 className="text-lg font-semibold tracking-tight text-neutral-100">
          {t("act.title")}
        </h1>
        <div className="card-padded text-sm text-neutral-500">{t("act.emptyState")}</div>
      </div>
    );
  }

  const seg = (key: "all" | "swap" | "transfer", label: string) => (
    <button
      type="button"
      onClick={() => setFilter(key)}
      className={`rounded-md px-2.5 py-1 text-xs transition ${
        filter === key
          ? "bg-neutral-700 text-neutral-100"
          : "text-neutral-400 hover:text-neutral-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6 fade-in">
      {/* Compact one-row header: title + count, segmented filter, icon actions. */}
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight text-neutral-100">
          {t("act.title")}
          <span className="ml-2 text-sm font-normal text-neutral-500">· {n}</span>
        </h1>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-0.5 rounded-lg bg-neutral-900 p-0.5">
            {seg("all", t("act.filterAll"))}
            {seg("swap", t("act.swaps"))}
            {seg("transfer", t("act.transfers"))}
          </div>
          <button
            type="button"
            onClick={() => refreshAll(true)}
            disabled={polling}
            title={t("act.refresh")}
            className="btn-ghost rounded-md p-1.5 text-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <IconRefresh className={`h-4 w-4 ${polling ? "animate-spin" : ""}`} />
          </button>
          {confirmingClear ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  clearHistory();
                  bump((v) => v + 1);
                  setConfirmingClear(false);
                }}
                className="btn-danger rounded-md px-2.5 py-1 text-xs"
              >
                {t("act.clearConfirmBtn" as MsgKey)}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingClear(false)}
                className="btn-ghost rounded-md px-2.5 py-1 text-xs"
              >
                {t("kr.cancel")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingClear(true)}
              title={t("act.clearLog")}
              className="btn-ghost rounded-md p-1.5 text-red-500 hover:bg-red-500/10"
            >
              <IconTrash className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {/* Two-pane terminal: dense unified table | sticky detail panel. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="card overflow-hidden">
          {shown.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-neutral-500">
              {t("act.emptyState")}
            </div>
          ) : (
            <div className="max-h-[calc(100vh-9rem)] overflow-y-auto">
            <table className="w-full table-fixed">
              <thead className="sticky top-0 z-10 bg-neutral-950 text-xs text-neutral-500">
                <tr className="border-b border-neutral-800">
                  <th className="w-7" />
                  <th className="w-[5.5rem] py-1.5 pl-3 text-left font-normal">
                    {t("act.colTime" as MsgKey)}
                  </th>
                  <th className="py-1.5 text-left font-normal">
                    {t("act.colDesc" as MsgKey)}
                  </th>
                  <th className="w-28 py-1.5 pr-2 text-right font-normal">
                    {t("act.colAmount" as MsgKey)}
                  </th>
                  <th className="w-24 py-1.5 pr-3 text-right font-normal">
                    {t("act.colStatus" as MsgKey)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((it) =>
                  it.kind === "swap" ? (
                    <SwapRowItem
                      key={it.id}
                      s={it.swap}
                      selected={selected === it.id}
                      onSelect={() => setSelected(it.id)}
                    />
                  ) : (
                    <TransferRowItem
                      key={it.id}
                      entry={it.entry}
                      status={statuses[it.entry.tx_id]}
                      selected={selected === it.id}
                      onSelect={() => setSelected(it.id)}
                    />
                  ),
                )}
              </tbody>
            </table>
            </div>
          )}
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          {selItem == null ? (
            <p className="px-1 py-2 text-sm text-neutral-500">{t("act.emptyState")}</p>
          ) : selItem.kind === "swap" ? (
            <SwapDetail s={selItem.swap} onResume={onResumeSwap} />
          ) : (
            <TransferDetail
              entry={selItem.entry}
              status={statuses[selItem.entry.tx_id]}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table rows
// ---------------------------------------------------------------------------

function rowCls(selected: boolean, accent: boolean): string {
  const base =
    "cursor-pointer border-l-2 transition border-b border-neutral-800/70 last:border-b-0";
  const sel = selected ? "bg-neutral-800/60" : "hover:bg-neutral-800/30";
  const left = selected
    ? "border-l-cyan-400"
    : accent
      ? "border-l-cyan-500/60"
      : "border-l-transparent";
  return `${base} ${sel} ${left}`;
}

function SwapRowItem({
  s,
  selected,
  onSelect,
}: {
  s: SwapRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useT();
  const inflight = !SWAP_TERMINAL.has(s.status);
  const sell = s.direction === "exfer_to_bnb";
  const outUnit = sell ? "BNB" : "EXFER";
  const pill = swapPill(s.status);
  const created = new Date(s.created_at * 1000);

  return (
    <tr className={rowCls(selected, inflight)} onClick={onSelect}>
      <td className="w-7 py-2 pl-3 pr-1 align-middle text-neutral-500">
        <IconSwap className="mx-auto h-3.5 w-3.5" />
      </td>
      <td className="w-[5.5rem] py-2 pr-2 align-middle">
        <span className="addr-xs whitespace-nowrap text-neutral-500">{fmtStamp(created)}</span>
      </td>
      <td className="py-2 pr-2 align-middle">
        <span className="block truncate text-sm text-neutral-200">
          {sell ? t("act.soldExfer") : t("act.boughtExfer")}
        </span>
      </td>
      <td className="w-28 py-2 pr-2 text-right align-middle">
        <span className="amount text-sm text-emerald-400">
          +{fmtAmt(s.amount_out)}
          <span className="ml-0.5 text-xs font-medium text-neutral-500">{outUnit}</span>
        </span>
      </td>
      <td className="w-24 py-2 pr-3 text-right align-middle">
        {inflight ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-neutral-600 border-t-cyan-400" />
            <span className="text-xs text-neutral-400">{t("act.swapInProgress")}</span>
          </span>
        ) : (
          <span className={`pill ${pill.cls}`}>{t(pill.key as MsgKey)}</span>
        )}
      </td>
    </tr>
  );
}

function TransferRowItem({
  entry,
  status,
  selected,
  onSelect,
}: {
  entry: HistoryEntry;
  status: TxStatus | "error" | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useT();
  const dt = new Date(entry.broadcast_at);
  const recipients = entry.outputs.filter((o) => !o.is_change);
  const first = recipients[0];
  const label = first ? getLabel(first.to) : undefined;
  const desc =
    recipients.length > 1
      ? t("act.recipientsMany", { n: recipients.length })
      : label ?? t("act.externalAddress");
  const total = recipients.reduce((sum, o) => sum + o.amount, 0);
  const pill = transferPill(t, status);

  return (
    <tr className={rowCls(selected, false)} onClick={onSelect}>
      <td className="w-7 py-2 pl-3 pr-1 align-middle text-neutral-500">
        <IconArrowUp className="mx-auto h-3.5 w-3.5" />
      </td>
      <td className="w-[5.5rem] py-2 pr-2 align-middle">
        <span className="addr-xs whitespace-nowrap text-neutral-500">{fmtStamp(dt)}</span>
      </td>
      <td className="py-2 pr-2 align-middle">
        <span className="block truncate text-sm text-neutral-200">{desc}</span>
      </td>
      <td className="w-28 py-2 pr-2 text-right align-middle">
        <span className="amount text-sm text-neutral-200">{formatExfer(total)}</span>
      </td>
      <td className="w-24 py-2 pr-3 text-right align-middle">
        <span className={`pill ${pill.cls}`}>{pill.text}</span>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function SwapDetail({
  s,
  onResume,
}: {
  s: SwapRow;
  onResume?: (swapId: string) => void;
}) {
  const { t } = useT();
  const tx = (key: AnyKey, vars?: Record<string, string | number>) =>
    t(key as MsgKey, vars);

  const sell = s.direction === "exfer_to_bnb";
  const inUnit = sell ? "EXFER" : "BNB";
  const outUnit = sell ? "BNB" : "EXFER";
  const inflight = !SWAP_TERMINAL.has(s.status);
  const pill = swapPill(s.status);
  const created = new Date(s.created_at * 1000);

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
    <div className="card-padded space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-neutral-100">
          {sell ? tx("act.soldExfer") : tx("act.boughtExfer")}
        </div>
        {inflight ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-neutral-600 border-t-cyan-400" />
            <span className="text-xs text-neutral-400">{swapStatusText(t, s.status)}</span>
          </span>
        ) : (
          <span className={`pill ${pill.cls}`}>{tx(pill.key)}</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Row label={tx("act.youSent") } value={`${fmtAmt(s.amount_in)} ${inUnit}`} />
        <Row label={tx("act.youReceived")} value={`${fmtAmt(s.amount_out)} ${outUnit}`} />
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
          className="col-span-2"
        />
      </div>

      {inflight && onResume && (
        <button
          type="button"
          onClick={() => onResume(s.swap_id)}
          className="btn-secondary w-full"
        >
          {t("act.swapResume")} ›
        </button>
      )}

      {refs.length > 0 && (
        <div className="space-y-2 border-t border-neutral-800 pt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            {t("act.onChain")}
          </div>
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

      {s.error && <div className="text-sm text-red-400">{s.error}</div>}
    </div>
  );
}

function TransferDetail({
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
  const total = recipients.reduce((sum, o) => sum + o.amount, 0);
  const pill = transferPill(t, status);
  const first = recipients[0];
  const label = first ? getLabel(first.to) : undefined;
  const title =
    recipients.length > 1
      ? t("act.recipientsMany", { n: recipients.length })
      : label ?? t("act.externalAddress");

  return (
    <div className="card-padded space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="truncate text-sm font-semibold text-neutral-100">{title}</div>
        <span className={`pill ${pill.cls}`}>{pill.text}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Row label={t("act.amount")} value={formatExfer(total)} />
        <Row label={t("act.fee")} value={formatExfer(entry.fee)} />
        {change && <Row label={t("act.change")} value={formatExfer(change.amount)} />}
        <Row
          label={t("act.swapCreated")}
          value={`${dt.toLocaleDateString()} · ${dt.toLocaleTimeString()}`}
          className="col-span-2"
        />
      </div>

      <div className="space-y-2 border-t border-neutral-800 pt-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {t("act.onChain")}
        </div>
        <HashLine label={t("act.txId")} value={entry.tx_id} href={txUrl(entry.tx_id)} />
        {recipients.map((o, i) => (
          <HashLine
            key={i}
            label={t("act.sentTo")}
            value={o.to}
            href={addrUrl(o.to)}
          />
        ))}
      </div>

      <div className="addr-xs text-neutral-600">
        {t("act.ioValue", { in: entry.inputs.length, out: entry.outputs.length })} ·{" "}
        {t("act.sizeBytes", { size: entry.size })}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`space-y-0.5${className ? ` ${className}` : ""}`}>
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="amount text-sm text-neutral-100">{value}</div>
    </div>
  );
}
