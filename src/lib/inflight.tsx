// Global in-flight tracking layer for the desktop wallet.
//
// One place to ask "is anything still settling?" — non-terminal cross-chain
// swaps (polled from walletd's swap_list) plus locally-tracked LP add/remove
// ops (the inflightLp localStorage store). A nav badge, the swap screen, or a
// "leaving — you have an in-flight op" guard can all read the same source.
//
// Everything degrades gracefully: swap_list throws when walletd was started
// without a swap pool URL (engine off) — that just yields zero swaps, never an
// error. The LP store is purely local and always readable.
//
// swapStatusText() is ported from the mobile SwapTab so the in-flight surfaces
// share one status vocabulary (namespace swapst.*).

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { rpc } from "./rpc";
import type { MsgKey } from "./i18n";
import {
  getLpOps,
  removeLpOp,
  onLpOpsChange,
  type LpOp,
} from "./inflightLp";

// New status keys aren't in the dictionary yet (merged later); cast at the call
// site like the rest of the desktop UI does for not-yet-landed keys.
type AnyKey = MsgKey | string;

/** A swap still working its way through the HTLC dance. Subset of the
 *  swap_list row the in-flight surfaces need (verified against live walletd). */
export interface InflightSwap {
  swap_id: string;
  direction: "exfer_to_bnb" | "bnb_to_exfer";
  status: string;
  amount_in: string;
  amount_out: string;
}

/** Re-exported so consumers can type LP ops without reaching into inflightLp. */
export type { LpOp };

// Statuses that mean the swap is done (any other status is still in flight).
// "quoted" / "expired" are terminal here: a bare quote that lapsed never locked
// funds, so it's not something the user is waiting on.
const TERMINAL_SWAP = new Set([
  "quoted",
  "expired",
  "completed",
  "refunded",
  "failed",
]);

// LP deposit terminal statuses (lp_deposit_status → { status }). Matches the
// desktop Liquidity flow's poll vocabulary plus the refund/fail strays.
const TERMINAL_DEP = new Set([
  "completed",
  "expired",
  "refunded",
  "failed",
]);

/** Map a raw swap status to a stable label key. Ported from the mobile
 *  SwapTab status map so every in-flight surface speaks the same vocabulary.
 *  Pass a `t` (from useT) — unknown statuses fall back to the raw string. */
export function swapStatusText(
  t: (k: MsgKey) => string,
  status: string,
): string {
  const map: Record<string, AnyKey> = {
    quoted: "swapst.quoted",
    user_locked: "swapst.userLocked",
    pool_locked: "swapst.poolLocked",
    claiming: "swapst.claiming",
    completed: "swapst.completed",
    refunding: "swapst.refunding",
    refunded: "swapst.refunded",
    failed: "swapst.failed",
  };
  const key = map[status];
  return key ? t(key as MsgKey) : status;
}

// ---------------------------------------------------------------------------
// Resume targets
//
// When the user taps an in-flight item (a nav badge dropdown, the swap screen),
// the nav sets a "resume target" so the destination page can reopen the right
// flow (resume that swap / reopen that LP deposit). It's in-memory only — a
// transient hand-off, not persisted.
// ---------------------------------------------------------------------------

export interface ResumeTarget {
  resumeSwapId?: string;
  resumeLpAddId?: string;
  /** Set when the Dashboard governance nudge routes to Settings, so Settings
   *  auto-opens the voting overlay instead of leaving the user to find it. */
  openGovernance?: boolean;
}

interface ResumeCtx extends ResumeTarget {
  setResumeTarget: (t: ResumeTarget) => void;
  clearResumeTarget: () => void;
}

const ResumeContext = createContext<ResumeCtx>({
  setResumeTarget: () => {},
  clearResumeTarget: () => {},
});

/** Wrap the app (or the swap/nav subtree) to share a resume hand-off. */
export function InflightProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ResumeTarget>({});
  const value: ResumeCtx = {
    ...target,
    setResumeTarget: (t) => setTarget(t),
    clearResumeTarget: () => setTarget({}),
  };
  return (
    <ResumeContext.Provider value={value}>{children}</ResumeContext.Provider>
  );
}

/** Read/set the current resume target. The nav sets it; the destination page
 *  reads it on mount and clears it once it's consumed the hand-off. */
export function useResumeTarget(): ResumeCtx {
  return useContext(ResumeContext);
}

// ---------------------------------------------------------------------------
// useInflight — the aggregate
// ---------------------------------------------------------------------------

export interface Inflight {
  /** Non-terminal cross-chain swaps. */
  swaps: InflightSwap[];
  /** Locally-tracked LP add/remove ops still in flight. */
  lpOps: LpOp[];
  /** swaps.length + lpOps.length — convenient for a badge count. */
  total: number;
}

const EMPTY: Inflight = { swaps: [], lpOps: [], total: 0 };

/**
 * Poll walletd for non-terminal swaps and read the local LP store, returning
 * the combined in-flight set. Refreshes on a ~7s timer plus on window focus /
 * tab visibility and on any LP-store change, so a finished item drops promptly
 * rather than lingering as a stale spinner.
 *
 * @param pollMs  swap_list poll interval (default 7000ms). Ignored if <= 0,
 *                in which case it only refreshes on focus / store changes.
 */
export function useInflight(pollMs = 7000): Inflight {
  const [swaps, setSwaps] = useState<InflightSwap[]>([]);
  const [lpOps, setLpOps] = useState<LpOp[]>(getLpOps);
  // Guard against overlapping refreshes (a slow poll + a focus event).
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        // Swaps — engine-off / unreachable just clears the list.
        try {
          const all = await rpc<InflightSwap[]>("swap_list");
          if (!cancelled) {
            setSwaps((all ?? []).filter((s) => !TERMINAL_SWAP.has(s.status)));
          }
        } catch {
          if (!cancelled) setSwaps([]);
        }

        // LP adds — drop any whose deposit has gone terminal (a cheap walletd
        // DB lookup, not a node-RPC hit). Removes have no status endpoint and
        // fall off by the store's TTL.
        for (const op of getLpOps()) {
          if (op.kind !== "add") continue;
          try {
            const s = await rpc<{ status?: string }>("lp_deposit_status", {
              id: op.id,
            });
            if (s?.status && TERMINAL_DEP.has(s.status)) removeLpOp(op.id);
          } catch {
            /* leave it; the TTL backstop will clear a stray */
          }
        }
        if (!cancelled) setLpOps(getLpOps());
      } finally {
        busy.current = false;
      }
    };

    void refresh();

    const id =
      pollMs > 0 ? window.setInterval(() => void refresh(), pollMs) : 0;
    const onWake = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    const unsub = onLpOpsChange(() => {
      if (!cancelled) setLpOps(getLpOps());
    });

    return () => {
      cancelled = true;
      if (id) window.clearInterval(id);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
      unsub();
    };
  }, [pollMs]);

  if (swaps.length === 0 && lpOps.length === 0) return EMPTY;
  return { swaps, lpOps, total: swaps.length + lpOps.length };
}
