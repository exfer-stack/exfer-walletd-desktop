// Derived swap UI phase — the honest state machine over walletd's raw swap
// status. The raw `user_locked` status covers two very different realities:
// "the pool is about to match us" (normal, seconds) and "the quote expired and
// the pool never matched — the HTLC will auto-refund at its timeout" (hours).
// Rendering both as a progress stepper is how a stuck swap once showed
// "settling, we'll notify you" forever. derivePhase() splits them apart so the
// UI can show an unmatched panel with a real destination (auto-refund at T)
// instead of a stuck progress bar.
//
// Pure functions only — no RPC, no React. Callers supply `nowSec` and the
// current EXFER chain height (null when unknown; the copy then degrades to
// "a few hours").

import type { Lang } from "./i18n";

/** Grace after quote expiry before we call a swap "unmatched" — mirrors the
 *  pool's reported-lock confirmation grace (15 min). */
export const GRACE_SEC = 15 * 60;

/** EXFER block time (seconds) — used to turn a timeout HEIGHT into an ETA. */
const EXFER_BLOCK_SEC = 10;

export type SwapPhase =
  | "loading"
  | "matching"
  | "settling"
  | "unmatched"
  | "refundable"
  | "refunding"
  | "completed"
  | "refunded"
  | "failed";

/** The SwapRecord fields the phase derivation reads — structural, so both the
 *  full SwapRec (swap_status) and the lighter swap_list rows qualify. */
export interface SwapPhaseRec {
  status: string;
  direction: "exfer_to_bnb" | "bnb_to_exfer";
  /** Quote validity deadline (unix sec). */
  expires_at?: number | null;
  /** Sell side: EXFER HTLC timeout height (lock is on the EXFER chain). */
  exfer_timeout_height?: number | null;
  /** Buy side: BSC HTLC timeout (unix sec; lock is on BSC). */
  bsc_timeout_sec?: number | null;
}

/**
 * Seconds until the user's HTLC lock becomes refundable, or null when unknown
 * (no chain height yet for a sell, or the record predates these fields).
 * Negative/zero means the timeout has passed — the refund can run now.
 */
export function refundEta(
  rec: SwapPhaseRec,
  nowSec: number,
  chainHeight: number | null,
): number | null {
  if (rec.direction === "exfer_to_bnb") {
    // Sell: the user's lock is on EXFER; the timeout is a block height.
    if (chainHeight == null || rec.exfer_timeout_height == null) return null;
    return (rec.exfer_timeout_height - chainHeight) * EXFER_BLOCK_SEC;
  }
  // Buy: the user's lock is on BSC; the timeout is wall-clock seconds.
  if (rec.bsc_timeout_sec == null) return null;
  return rec.bsc_timeout_sec - nowSec;
}

/** Map a raw swap record to the UI phase. `rec == null` = still loading. */
export function derivePhase(
  rec: SwapPhaseRec | null,
  nowSec: number,
  chainHeight: number | null,
): SwapPhase {
  if (rec == null) return "loading";
  switch (rec.status) {
    case "completed":
    case "refunded":
    case "failed":
    case "refunding":
      return rec.status;
    case "pool_locked":
    case "claiming":
      return "settling";
    case "user_locked": {
      // Within the quote window (+ grace) the pool may still match us.
      if (rec.expires_at == null || nowSec <= rec.expires_at + GRACE_SEC)
        return "matching";
      const eta = refundEta(rec, nowSec, chainHeight);
      if (eta != null && eta <= 0) return "refundable";
      return "unmatched"; // eta unknown or still counting down
    }
    default:
      // "quoted" (rarely visible here) and anything unrecognized: treat as
      // matching rather than inventing a state.
      return "matching";
  }
}

/** Compact human ETA: "~3 h 50 min" EN / "约 3 小时 50 分" ZH. Clamps below
 *  one minute up to "~1 min" so a live countdown never reads "0". */
export function formatEta(sec: number, lang: Lang): string {
  const s = Math.max(0, sec);
  let h = Math.floor(s / 3600);
  let m = Math.round((s % 3600) / 60);
  if (m === 60) {
    h += 1;
    m = 0;
  }
  if (lang === "zh") {
    if (h > 0) return m > 0 ? `约 ${h} 小时 ${m} 分` : `约 ${h} 小时`;
    return `约 ${Math.max(1, m)} 分钟`;
  }
  if (h > 0) return m > 0 ? `~${h} h ${m} min` : `~${h} h`;
  return `~${Math.max(1, m)} min`;
}
