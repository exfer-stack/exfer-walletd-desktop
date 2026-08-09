import { useEffect, useMemo, useState, type ReactNode } from "react";
import { rpc, formatExfer } from "../lib/rpc";
import { clearHistory } from "../lib/history";
import { useWallet } from "../lib/wallet";
import { isHidden } from "../lib/hidden";
import {
  buildActivityFeed,
  type ActivityItem,
} from "../lib/activity";
import type { WalletEntry } from "../lib/types";
import { getLabel, shortAddress } from "../lib/labels";
import { openExternal } from "../lib/openExternal";
import { CopyButton } from "../components/CopyButton";
import { useT, type MsgKey } from "../lib/i18n";
import { txExplorerUrl } from "../lib/format";
import { getSwapUsd } from "../lib/swapPrice";
import { swapStatusText } from "../lib/inflight";
import {
  derivePhase,
  refundEta,
  formatEta,
  GRACE_SEC,
  type SwapPhase,
} from "../lib/swapPhase";
import { getBlockHeight } from "../lib/market";

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
const IconArrowDown = (p: { className?: string }) => (
  <Svg size={14} className={p.className}>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
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
        // In the Tauri shell a bare target="_blank" is a no-op — route the open
        // through the system browser explicitly (works in browser-dev too).
        onClick={(e) => {
          e.preventDefault();
          void openExternal(href);
        }}
        className="inline-flex rounded-md p-1 text-cyan-400 hover:bg-neutral-800"
        title={t("act.viewExplorer")}
      >
        <IconArrowUpRight className="h-3.5 w-3.5" />
      </a>
    </div>
  );
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
  // Phase-derivation inputs (swap_list returns the full record): the quote
  // deadline plus the HTLC timeouts — sell side a block HEIGHT on EXFER, buy
  // side wall-clock seconds on BSC.
  expires_at?: number | null;
  exfer_timeout_height?: number | null;
  bsc_timeout_sec?: number | null;
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

/** Transfer status → pill text + class. Derived from the merged ActivityItem
 *  (indexer/mempool/local), so both the row and the detail panel share one
 *  vocabulary for incoming AND outgoing transfers. */
function transferPill(
  t: (k: MsgKey, vars?: Record<string, string | number>) => string,
  item: ActivityItem,
): { text: string; cls: string } {
  if (item.status === "confirmed" && item.block_height != null)
    return { text: t("act.pillConfirmed", { h: item.block_height }), cls: "pill-success" };
  if (item.status === "confirmed")
    return { text: t("act.pillConfirmedNoH" as MsgKey), cls: "pill-success" };
  return { text: t("act.pillMempool"), cls: "pill-info" };
}

/** mm-dd HH:MM in Geist Mono — the dense row timestamp. */
function fmtStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// A unified, time-sorted row: a swap or a transfer. The table renders both.
// Transfers are now ActivityItems from the merged indexer + mempool + local
// feed (so incoming deposits appear), not local-only send records.
type Item =
  | { kind: "swap"; id: string; ts: number; swap: SwapRow }
  | { kind: "transfer"; id: string; ts: number; item: ActivityItem };

/** Merge a fresh (possibly degraded / incomplete) feed over the last-good one,
 *  keyed by tx_id, WITHOUT losing confirmed rows. Used only when the indexer
 *  fetch failed for some/all addresses: keep what we had, add/upgrade with the
 *  degraded pass, but never downgrade a confirmed row to pending/missing. A
 *  later COMPLETE load replaces the feed wholesale, so any stale row self-heals. */
function mergeFeeds(prev: ActivityItem[], fresh: ActivityItem[]): ActivityItem[] {
  const byId = new Map<string, ActivityItem>();
  for (const it of prev) byId.set(it.tx_id, it);
  for (const it of fresh) {
    const old = byId.get(it.tx_id);
    if (old?.status === "confirmed" && it.status !== "confirmed") continue;
    byId.set(it.tx_id, it);
  }
  return [...byId.values()];
}

export function Activity({
  onResumeSwap,
}: {
  // Tapping an in-flight swap row routes to Swap with that swap as the resume
  // target. (Activity only surfaces swaps in flight; LP ops resume from the
  // Liquidity tab via its own nav badge / resume hand-off.)
  onResumeSwap?: (swapId: string) => void;
} = {}) {
  const { t } = useT();
  const { balance } = useWallet();
  const [polling, setPolling] = useState(false);
  // Two-step inline confirm for the destructive clear (avoids the unstyled
  // native confirm() dialog against the dark themed surfaces).
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Transfers now come from the merged indexer + mempool + local feed (see
  // lib/activity.ts) — so INCOMING deposits appear, not just our own sends. The
  // addresses to query are the visible (non-hidden) wallet entries.
  const ownAddrs = useMemo(
    () =>
      (balance?.entries ?? [])
        .filter((e) => !isHidden(e.address))
        .map((e) => e.address),
    [balance],
  );
  const ownKey = ownAddrs.join(",");
  const [feed, setFeed] = useState<ActivityItem[]>([]);

  // Load the feed on mount, when the wallet (address set) changes, and whenever
  // the balance moves — a deposit/send shifts `total` or `projected`, so keying
  // on both surfaces new activity within one provider poll / SSE push without a
  // separate timer. Fail-soft: buildActivityFeed never throws (it degrades to
  // the local log), so a transient outage can't blank the list.
  async function loadFeed() {
    if (!ownAddrs.length) {
      // Address set not loaded yet (cold start) — keep what we're showing
      // rather than flashing empty; this re-fires once addresses arrive.
      return;
    }
    setPolling(true);
    try {
      const { items, indexerOk } = await buildActivityFeed(ownAddrs);
      if (indexerOk) {
        setFeed(items);
      } else {
        // Degraded fetch (indexer failed for some/all addresses): don't blank
        // the visible history with this partial result — merge fresh over what
        // we have, keeping every confirmed row. A later complete load replaces.
        setFeed((prev) => mergeFeeds(prev, items));
      }
    } finally {
      setPolling(false);
    }
  }
  useEffect(() => {
    void loadFeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownKey, balance?.total, balance?.projected]);

  // Cross-chain swaps live in walletd's journal, not the EXFER history log —
  // surface them as their own labeled records. swap_list throws when the swap
  // engine isn't configured; a failed poll KEEPS the previous list (clearing
  // it would also clear the lock-leg tx-id filter, flashing raw swap legs into
  // the transfer feed as "sent to unknown address").
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const all = await rpc<SwapRow[]>("swap_list");
        if (cancelled) return;
        // Drop quotes the user never executed — no funds ever moved, so they're
        // not swaps and must not look like failures. New records use the benign
        // "expired" status; older builds marked them "failed (never executed)",
        // so drop those too. Show everything that actually locked.
        const real = (all ?? []).filter(
          (s) =>
            s.status !== "quoted" &&
            s.status !== "expired" &&
            !(s.status === "failed" && /never executed/i.test(s.error ?? "")),
        );
        real.sort((a, b) => b.created_at - a.created_at);
        setSwaps(real);
      } catch {
        /* transient poll failure — keep the previous list */
      }
    };
    load();
    const id = window.setInterval(load, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // A coarse wall clock for the swap-phase derivation. 30s is plenty: the
  // phases move on hour-scale HTLC timeouts, not seconds.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      30_000,
    );
    return () => window.clearInterval(id);
  }, []);

  // EXFER tip height — needed only to turn a SELL-side HTLC timeout HEIGHT
  // into a refund ETA, so it's polled lazily: only while at least one sell
  // sits user_locked past its quote expiry + grace. A null height degrades
  // the unmatched copy to "a few hours".
  const [tipHeight, setTipHeight] = useState<number | null>(null);
  const needHeight = useMemo(
    () =>
      swaps.some(
        (s) =>
          s.direction === "exfer_to_bnb" &&
          s.status === "user_locked" &&
          s.expires_at != null &&
          nowSec > s.expires_at + GRACE_SEC,
      ),
    [swaps, nowSec],
  );
  useEffect(() => {
    if (!needHeight) return;
    let cancelled = false;
    const poll = async () => {
      const h = await getBlockHeight();
      if (!cancelled && h != null) setTipHeight(h);
    };
    void poll();
    const id = window.setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [needHeight]);

  // Hide the EXFER legs that belong to a swap — they're already represented by
  // the unified swap record, so showing the raw transfer too would double-count.
  const swapTxIds = useMemo(() => {
    const s = new Set<string>();
    for (const sw of swaps) {
      for (const tx of [sw.user_lock_tx, sw.claim_tx, sw.refund_tx]) if (tx) s.add(tx);
    }
    return s;
  }, [swaps]);
  // The swap's own EXFER legs are already represented by the unified swap
  // record, so drop them from the transfer feed (no double-count).
  const transfers = useMemo(
    () => feed.filter((it) => !swapTxIds.has(it.tx_id)),
    [feed, swapTxIds],
  );

  // Auto-poll while any transfer is still pending. buildActivityFeed resolves
  // status via the indexer + a point get_transaction lookup, so a 15s cadence
  // is safe. Stops once everything is confirmed/settled.
  useEffect(() => {
    if (!transfers.some((it) => it.status === "pending")) return; // nothing to chase
    const id = window.setInterval(() => void loadFeed(), 15_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers, ownKey]);

  // Filter segments: all / swaps only / transfers only.
  const [filter, setFilter] = useState<"all" | "swap" | "transfer">("all");
  const [selected, setSelected] = useState<string | null>(null);

  // One unified, in-flight-first then time-sorted list.
  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    // Confirmed-only deposits from the indexer carry a block height but no
    // wall-clock time. Put them on the SAME ms axis as swaps / local sends by
    // converting height -> time against the chain tip; when the tip hasn't
    // loaded (or the node is unreachable) anchor to the highest block we hold.
    // The old code used the RAW block height (~9e5) as `ts`, which is ~7 orders
    // of magnitude below a real ms timestamp (~1.7e12) — so every confirmed
    // deposit sank below every swap and local send regardless of real time.
    const BLOCK_MS = 10_000;
    const nowMs = Date.now();
    const maxBlock = transfers.reduce(
      (m, it) => (it.block_height != null && it.block_height > m ? it.block_height : m),
      0,
    );
    const effTip = tipHeight ?? (maxBlock > 0 ? maxBlock : null);
    const txTime = (it: ActivityItem): number => {
      if (it.ts) {
        const t = new Date(it.ts).getTime();
        if (!Number.isNaN(t)) return t;
      }
      if (it.block_height != null && effTip != null) {
        return nowMs - Math.max(0, effTip - it.block_height) * BLOCK_MS;
      }
      return nowMs;
    };
    for (const s of swaps)
      list.push({ kind: "swap", id: `swap:${s.swap_id}`, ts: s.created_at * 1000, swap: s });
    for (const it of transfers)
      list.push({ kind: "transfer", id: `tx:${it.tx_id}`, ts: txTime(it), item: it });
    const inFlight = (it: Item) =>
      it.kind === "swap" && !SWAP_TERMINAL.has(it.swap.status);
    list.sort((a, b) => {
      const fa = inFlight(a) ? 1 : 0;
      const fb = inFlight(b) ? 1 : 0;
      if (fa !== fb) return fb - fa; // in-flight pinned to the top
      return b.ts - a.ts; // then newest first
    });
    return list;
  }, [swaps, transfers, tipHeight]);

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

  const n = transfers.length + swaps.length; // swaps + transfers on record
  const selItem = items.find((it) => it.id === selected) ?? null;

  if (transfers.length === 0 && swaps.length === 0) {
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
            onClick={() => void loadFeed()}
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
                  // Clears the local SEND log (recipient/fee detail + any
                  // dropped zombie sends). Incoming + confirmed rows are
                  // re-derived from the indexer on reload, so the on-chain
                  // history isn't lost — only the local enrichment.
                  clearHistory();
                  void loadFeed();
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
                  <th className="w-[6.75rem] py-1.5 pl-3 text-left font-normal">
                    {t("act.colTime" as MsgKey)}
                  </th>
                  <th className="py-1.5 text-left font-normal">
                    {t("act.colDesc" as MsgKey)}
                  </th>
                  <th className="w-28 py-1.5 pr-2 text-right font-normal">
                    {t("act.colAmount" as MsgKey)}
                  </th>
                  <th className="w-40 py-1.5 pr-3 text-right font-normal">
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
                      phase={derivePhase(it.swap, nowSec, tipHeight)}
                      etaSec={
                        it.swap.status === "user_locked"
                          ? refundEta(it.swap, nowSec, tipHeight)
                          : null
                      }
                      selected={selected === it.id}
                      onSelect={() => setSelected(it.id)}
                    />
                  ) : (
                    <TransferRowItem
                      key={it.id}
                      item={it.item}
                      entries={balance?.entries ?? []}
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
            <SwapDetail
              s={selItem.swap}
              phase={derivePhase(selItem.swap, nowSec, tipHeight)}
              etaSec={
                selItem.swap.status === "user_locked"
                  ? refundEta(selItem.swap, nowSec, tipHeight)
                  : null
              }
              onResume={onResumeSwap}
            />
          ) : (
            <TransferDetail item={selItem.item} entries={balance?.entries ?? []} />
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
  phase,
  etaSec,
  selected,
  onSelect,
}: {
  s: SwapRow;
  phase: SwapPhase;
  etaSec: number | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t, lang } = useT();
  const inflight = !SWAP_TERMINAL.has(s.status);
  const sell = s.direction === "exfer_to_bnb";
  const inUnit = sell ? "EXFER" : "BNB";
  const outUnit = sell ? "BNB" : "EXFER";
  const pill = swapPill(s.status);
  const created = new Date(s.created_at * 1000);

  // Unmatched: quote expired, the pool never matched — headed for auto-refund,
  // not "in progress". Refundable (or a countdown that hit zero): the HTLC
  // timeout has passed, the refund can run any moment.
  const unmatched = phase === "unmatched" || phase === "refundable";
  const etaText =
    phase === "refundable" || (etaSec != null && etaSec <= 0)
      ? t("swap.etaMoments")
      : etaSec != null
        ? formatEta(etaSec, lang)
        : t("swap.etaFewHours");

  return (
    <tr className={rowCls(selected, inflight)} onClick={onSelect}>
      <td className="w-7 py-2 pl-3 pr-1 align-middle text-neutral-500">
        <IconSwap className="mx-auto h-3.5 w-3.5" />
      </td>
      <td className="w-[6.75rem] py-2 pr-2 align-middle">
        <span className="addr-xs whitespace-nowrap text-neutral-500">{fmtStamp(created)}</span>
      </td>
      <td className="py-2 pr-2 align-middle">
        <span className="block truncate text-sm text-neutral-200">
          {sell ? t("act.soldExfer") : t("act.boughtExfer")}
        </span>
        {unmatched && (
          <span className="block truncate text-xs text-amber-300/90">
            {t("swap.cardUnmatched", { eta: etaText })}
          </span>
        )}
      </td>
      <td className="w-28 py-2 pr-2 text-right align-middle">
        {phase === "completed" ? (
          // Only a completed swap actually credited the output.
          <span className="amount text-sm text-emerald-400">
            +{fmtAmt(s.amount_out)}
            <span className="ml-0.5 text-xs font-medium text-neutral-500">{outUnit}</span>
          </span>
        ) : phase === "refunded" ? (
          // The refund returned the INPUT — show what came back, not a
          // phantom output credit.
          <span className="amount text-sm text-neutral-400">
            {fmtAmt(s.amount_in)}
            <span className="ml-0.5 text-xs font-medium text-neutral-500">{inUnit}</span>
          </span>
        ) : (
          // In flight (or failed): the expected outcome, not a credit — keep
          // it muted and unsigned.
          <span className="amount text-sm text-neutral-400">
            {fmtAmt(s.amount_out)}
            <span className="ml-0.5 text-xs font-medium text-neutral-500">{outUnit}</span>
          </span>
        )}
      </td>
      <td className="w-40 py-2 pr-3 text-right align-middle">
        {unmatched ? (
          <span className="pill pill-warn">{t("swap.unmatchedTitle")}</span>
        ) : inflight ? (
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

type Entry = WalletEntry;

/** mm-dd HH:MM for a row that has a local timestamp; "block {h}" for a
 *  confirmed-only deposit the indexer surfaced (no wall-clock time). */
function whenLabel(
  t: (k: MsgKey, vars?: Record<string, string | number>) => string,
  it: ActivityItem,
): string {
  if (it.ts) return fmtStamp(new Date(it.ts));
  if (it.block_height != null) return t("act.blockShort" as MsgKey, { h: it.block_height });
  return "";
}

/** Row description: who we received from / sent to, named when we can. */
function transferDesc(
  t: (k: MsgKey, vars?: Record<string, string | number>) => string,
  it: ActivityItem,
  entries: Entry[],
): string {
  if (it.kind === "received") {
    if (it.is_coinbase) return t("act.miningReward" as MsgKey);
    const toEntry = entries.find((e) => it.toAddresses?.includes(e.address));
    if (toEntry) return getLabel(toEntry.address) ?? t("act.received" as MsgKey);
    return t("act.received" as MsgKey);
  }
  // Sent: prefer the local-detail recipients (exact), else indexer peers.
  const recipients = it.detail?.outputs.filter((o) => !o.is_change) ?? [];
  if (recipients.length > 1)
    return t("act.recipientsMany", { n: recipients.length });
  const first = recipients[0]?.to ?? it.counterparties?.[0];
  if (first) return getLabel(first) ?? t("act.externalAddress");
  return t("act.externalAddress");
}

function TransferRowItem({
  item,
  entries,
  selected,
  onSelect,
}: {
  item: ActivityItem;
  entries: Entry[];
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useT();
  const received = item.kind === "received";
  const desc = transferDesc(t, item, entries);
  const pill = transferPill(t, item);

  return (
    <tr className={rowCls(selected, false)} onClick={onSelect}>
      <td className="w-7 py-2 pl-3 pr-1 align-middle text-neutral-500">
        {received ? (
          <IconArrowDown className="mx-auto h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <IconArrowUp className="mx-auto h-3.5 w-3.5" />
        )}
      </td>
      <td className="w-[6.75rem] py-2 pr-2 align-middle">
        <span className="addr-xs whitespace-nowrap text-neutral-500">
          {whenLabel(t, item)}
        </span>
      </td>
      <td className="py-2 pr-2 align-middle">
        <span className="block truncate text-sm text-neutral-200">{desc}</span>
      </td>
      <td className="w-28 py-2 pr-2 text-right align-middle">
        <span
          className={
            "amount text-sm " + (received ? "text-emerald-400" : "text-neutral-200")
          }
        >
          {received ? "+" : "−"}
          {formatExfer(item.amount)}
        </span>
      </td>
      <td className="w-40 py-2 pr-3 text-right align-middle">
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
  phase,
  etaSec,
  onResume,
}: {
  s: SwapRow;
  phase: SwapPhase;
  etaSec: number | null;
  onResume?: (swapId: string) => void;
}) {
  const { t, lang } = useT();
  const tx = (key: AnyKey, vars?: Record<string, string | number>) =>
    t(key as MsgKey, vars);

  const sell = s.direction === "exfer_to_bnb";
  const inUnit = sell ? "EXFER" : "BNB";
  const outUnit = sell ? "BNB" : "EXFER";
  const inflight = !SWAP_TERMINAL.has(s.status);
  const pill = swapPill(s.status);
  const created = new Date(s.created_at * 1000);

  // Unmatched/refundable: the swap isn't "locking your funds" anymore — it's
  // headed for an automatic refund. No spinner; say where this is going.
  const unmatched = phase === "unmatched" || phase === "refundable";
  const etaText =
    phase === "refundable" || (etaSec != null && etaSec <= 0)
      ? t("swap.etaMoments")
      : etaSec != null
        ? formatEta(etaSec, lang)
        : t("swap.etaFewHours");

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
        {unmatched ? (
          <span className="pill pill-warn">{t("swap.unmatchedTitle")}</span>
        ) : inflight ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-neutral-600 border-t-cyan-400" />
            <span className="text-xs text-neutral-400">{swapStatusText(t, s.status)}</span>
          </span>
        ) : (
          <span className={`pill ${pill.cls}`}>{tx(pill.key)}</span>
        )}
      </div>

      {unmatched && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-amber-200">
          <div className="text-xs leading-relaxed opacity-90">
            {t("swap.unmatchedBody", { eta: etaText })}
          </div>
          {phase === "refundable" ? (
            <div className="mt-2 text-xs font-semibold">
              {t("swap.refundingAuto")}
            </div>
          ) : (
            <div className="mt-2 font-mono text-xs font-semibold tabular-nums">
              {t("swap.autoRefundIn", { eta: etaText })}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Row label={tx("act.youSent") } value={`${fmtAmt(s.amount_in)} ${inUnit}`} />
        {/* A refund returns the INPUT — don't assert the output was received. */}
        <Row
          label={tx("act.youReceived")}
          value={
            phase === "refunded"
              ? `${fmtAmt(s.amount_in)} ${inUnit}`
              : `${fmtAmt(s.amount_out)} ${outUnit}`
          }
        />
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
  item,
  entries,
}: {
  item: ActivityItem;
  entries: Entry[];
}) {
  const { t } = useT();
  const received = item.kind === "received";
  const detail = item.detail; // rich local send record (recipients/fee/change)
  const pill = transferPill(t, item);
  const title = transferDesc(t, item, entries);
  const when = item.ts
    ? `${new Date(item.ts).toLocaleDateString()} · ${new Date(item.ts).toLocaleTimeString()}`
    : item.block_height != null
      ? t("act.blockShort" as MsgKey, { h: item.block_height })
      : "";

  // Received: senders come natively from the indexer's counterparties.
  const senders = received ? item.counterparties ?? [] : [];
  // Received: which of our addresses got credited.
  const toAddr = received ? item.toAddresses?.[0] : undefined;
  // Sent: prefer the exact local recipients; else the indexer's peer recipients.
  const localRecips = detail?.outputs.filter((o) => !o.is_change) ?? [];
  const change = detail?.outputs.find((o) => o.is_change);
  const peerRecips = received
    ? []
    : localRecips.length > 0
      ? localRecips.map((o) => o.to)
      : (item.counterparties ?? []).filter(
          (a) => !entries.some((e) => e.address === a),
        );

  return (
    <div className="card-padded space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="truncate text-sm font-semibold text-neutral-100">
          {received ? t("act.received" as MsgKey) : title}
        </div>
        <span className={`pill ${pill.cls}`}>{pill.text}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Row
          label={t("act.amount")}
          value={`${received ? "+" : "−"}${formatExfer(item.amount)}`}
        />
        {detail && <Row label={t("act.fee")} value={formatExfer(detail.fee)} />}
        {change && <Row label={t("act.change")} value={formatExfer(change.amount)} />}
        {when && (
          <Row label={t("act.swapCreated")} value={when} className="col-span-2" />
        )}
      </div>

      <div className="space-y-2 border-t border-neutral-800 pt-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {t("act.onChain")}
        </div>
        <HashLine label={t("act.txId")} value={item.tx_id} href={txUrl(item.tx_id)} />
        {received
          ? senders.map((a, i) => (
              <HashLine
                key={i}
                label={t("act.from" as MsgKey)}
                value={a}
                href={addrUrl(a)}
              />
            ))
          : peerRecips.map((a, i) => (
              <HashLine key={i} label={t("act.sentTo")} value={a} href={addrUrl(a)} />
            ))}
        {received && toAddr && (
          <HashLine label={t("act.to" as MsgKey)} value={toAddr} href={addrUrl(toAddr)} />
        )}
      </div>

      {detail && (
        <div className="addr-xs text-neutral-600">
          {t("act.ioValue", { in: detail.inputs.length, out: detail.outputs.length })} ·{" "}
          {t("act.sizeBytes", { size: detail.size })}
        </div>
      )}
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
