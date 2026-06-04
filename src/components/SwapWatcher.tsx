// Global swap-completion watcher. Mounted once under WalletProvider (so it
// survives tab switches and a closed Swap tab), it polls the swap journal and,
// when any swap reaches a terminal state, fires an in-app toast + a best-effort
// OS notification — so a finished swap is announced even if the user moved off
// the Swap tab.
//
// The first poll establishes a baseline (no toasts for swaps that were already
// terminal when the app opened); only transitions after that announce.
//
// swap_list throws when walletd was started without a swap pool URL — caught
// and treated as "engine off": the watcher is a silent no-op.

import { useEffect, useRef } from "react";
import { rpc } from "../lib/rpc";
import type { SwapLite } from "../lib/types";
import { useToast } from "../lib/toast";
import { useWallet } from "../lib/wallet";
import { osNotify } from "../lib/notify";
import { tStatic } from "../lib/i18n";

const TERMINAL = new Set(["completed", "refunded", "failed"]);

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
      if (!baseline) return; // first poll: baseline only, no toasts

      for (const s of list) {
        const before = baseline.get(s.swap_id);
        if (before !== undefined && before !== s.status && TERMINAL.has(s.status)) {
          announce(s);
        }
      }
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
