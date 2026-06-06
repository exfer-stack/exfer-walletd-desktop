// Global swap-completion watcher. Mounted once under WalletProvider (so it
// survives tab switches and a closed Swap tab), it polls the swap journal and,
// when any swap reaches a terminal state, fires an in-app toast + a best-effort
// OS notification — so a finished swap is announced even if the user moved off
// the Swap tab.
//
// Last-seen statuses are persisted in localStorage, so the FIRST poll after a
// restart diffs against what the user last saw and announces transitions that
// happened while the app was closed (a swap that completed/refunded overnight
// is no longer silently swallowed by the old baseline-only first poll).
//
// It also nudges — once per swap — when a swap goes unmatched (still
// user_locked past the quote expiry + grace): funds are safe, auto-refund in
// {eta}. The announced set is persisted alongside the statuses.
//
// swap_list throws when walletd was started without a swap pool URL — caught
// and treated as "engine off": the watcher is a silent no-op.

import { useEffect, useRef } from "react";
import { rpc } from "../lib/rpc";
import type { SwapLite } from "../lib/types";
import { useToast } from "../lib/toast";
import { useWallet } from "../lib/wallet";
import { osNotify } from "../lib/notify";
import { tStatic, readLang } from "../lib/i18n";
import { getBlockHeight } from "../lib/market";
import { GRACE_SEC, refundEta, formatEta } from "../lib/swapPhase";

const TERMINAL = new Set(["completed", "refunded", "failed"]);

// Persisted watcher state: last-seen status per swap (terminal entries pruned
// once announced) + the set of swaps already nudged about being unmatched.
const STORE_KEY = "exfer-walletd-desktop-swapwatch-v1";
interface WatchStore {
  statuses: Record<string, string>;
  nudged: string[];
}

function readStore(): WatchStore {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null") as
      | Partial<WatchStore>
      | null;
    return {
      statuses:
        raw && typeof raw.statuses === "object" && raw.statuses != null
          ? raw.statuses
          : {},
      nudged: Array.isArray(raw?.nudged) ? raw!.nudged.filter((x) => typeof x === "string") : [],
    };
  } catch {
    return { statuses: {}, nudged: [] };
  }
}

function writeStore(s: WatchStore) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* best effort */
  }
}

/** Significant-digit format for a decimal string (tiny BNB amounts must not
 *  read as "0"). */
function fmtAmt(s: string): string {
  const n = Number(s);
  if (!isFinite(n) || n === 0) return s;
  return n.toLocaleString("en-US", {
    maximumSignificantDigits: 6,
    useGrouping: false,
  });
}

export function SwapWatcher() {
  const toast = useToast();
  const { refresh } = useWallet();
  const prev = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const announce = (s: SwapLite) => {
      const outUnit = s.direction === "exfer_to_bnb" ? "BNB" : "EXFER";
      if (s.status === "completed") {
        const title = tStatic("swap.watcherCompletedTitle");
        const body = tStatic("swap.watcherCompletedBody", {
          amt: fmtAmt(s.amount_out),
          unit: outUnit,
        });
        toast.success(title, body);
        osNotify(title, body);
        refresh();
      } else if (s.status === "refunded") {
        const title = tStatic("swap.watcherRefundedTitle");
        const body = tStatic("swap.watcherRefundedBody");
        toast.info(title, body);
        osNotify(title, body);
        refresh();
      } else if (s.status === "failed") {
        const title = tStatic("swap.watcherFailedTitle");
        const body = tStatic("swap.watcherFailedBody");
        toast.error(title, body);
        osNotify(title, body);
      }
    };

    // One-time "swap not matched yet" nudge. The EXFER tip height is fetched
    // lazily right here (a once-per-swap event, not per poll) so a sell-side
    // timeout HEIGHT can become an ETA; failure just degrades to "a few hours".
    const nudge = async (s: SwapLite) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const height =
        s.direction === "exfer_to_bnb" ? await getBlockHeight() : null;
      if (cancelled) return;
      const eta = refundEta(s, nowSec, height);
      const etaText =
        eta != null && eta > 0
          ? formatEta(eta, readLang())
          : tStatic("swap.etaFewHours");
      const title = tStatic("swap.nudgeTitle");
      const body = tStatic("swap.nudgeBody", { eta: etaText });
      toast.info(title, body);
      osNotify(title, body);
    };

    const tick = async () => {
      let list: SwapLite[];
      try {
        list = await rpc<SwapLite[]>("swap_list");
      } catch {
        return; // engine off / transient
      }
      if (cancelled) return;
      const now = new Map(list.map((s) => [s.swap_id, s.status]));
      const baseline = prev.current;
      prev.current = now;
      const store = readStore();

      // The in-memory baseline (subsequent polls) or, on the FIRST poll after
      // startup, the persisted statuses — so a transition that happened while
      // the app was closed (completed / refunded overnight) still announces.
      const before = baseline ?? new Map(Object.entries(store.statuses));

      for (const s of list) {
        const was = before.get(s.swap_id);
        if (was === undefined || was === s.status || !TERMINAL.has(s.status)) continue;
        // A quote the user previewed but never confirmed simply expires
        // (quoted → failed/expired on older daemons): no funds moved, so it is
        // NOT a swap failure and must not pop a scary "transaction failed" toast.
        // Only announce a failure for a swap that actually went in-flight.
        if (s.status === "failed" && was === "quoted") continue;
        announce(s);
      }

      // Nudge — once per swap — when it sits unmatched: still user_locked past
      // the quote expiry + the pool's confirmation grace.
      const nowSec = Math.floor(Date.now() / 1000);
      for (const s of list) {
        if (s.status !== "user_locked") continue;
        if (s.expires_at == null || nowSec <= s.expires_at + GRACE_SEC) continue;
        if (store.nudged.includes(s.swap_id)) continue;
        store.nudged.push(s.swap_id);
        void nudge(s);
      }

      // Persist: keep only non-terminal statuses (terminal entries are pruned
      // once announced above) and only nudge marks for swaps still listed.
      const liveIds = new Set(list.map((s) => s.swap_id));
      writeStore({
        statuses: Object.fromEntries(
          list.filter((s) => !TERMINAL.has(s.status)).map((s) => [s.swap_id, s.status]),
        ),
        nudged: store.nudged.filter((id) => liveIds.has(id) && !TERMINAL.has(now.get(id) ?? "")),
      });
    };

    tick();
    const id = window.setInterval(tick, 6000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [toast, refresh]);

  return null;
}
