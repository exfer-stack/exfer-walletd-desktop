import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { rpc, formatExfer } from "./rpc";
import type { WalletBalance, WalletEntry } from "./types";
import { useToast } from "./toast";
import { osNotify } from "./notify";
import { isHidden } from "./hidden";

export interface UtxoInfo {
  utxo_count: number;
  truncated: boolean;
}

interface WalletData {
  balance: WalletBalance | null;
  loading: boolean;
  error: string | null;
  /** Manual refresh — call after a send or generate so the UI updates
   *  immediately instead of waiting for the next poll tick. */
  refresh: () => Promise<void>;
  /** Per-address UTXO counts, keyed by address. Empty until something
   *  calls refreshUtxos — the background poll skips UTXO scans to stay
   *  cheap, so counts are fetched on demand by the pages that show them. */
  utxos: Record<string, UtxoInfo>;
  /** Fetch UTXO counts (one extra upstream scan per address). Pages that
   *  display counts call this on mount and after mutating actions. */
  refreshUtxos: () => Promise<void>;
  /** Suspend the background balance poll (and SSE-triggered refreshes) and
   *  return a release fn. While suspended, simulate_transfer / transfer get
   *  the full per-IP scan-rate budget instead of competing with the poll — the
   *  public node caps balance/utxo queries per minute, and a poll running
   *  through a send is what tips a normal transfer over the edge ("network is
   *  busy"). Ref-counted, so nested/overlapping suspends are safe. The Send
   *  screen calls this on mount. */
  suspendPolling: () => () => void;
}

const WalletCtx = createContext<WalletData | null>(null);

export function useWallet(): WalletData {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet must be used within <WalletProvider>");
  return ctx;
}

// Poll cadence. The background poll asks for balance + pending
// ({ utxos: false, pending: true }) over the visible (non-hidden)
// addresses. With walletd's batched reads (v1.9.3+) the balances come
// back in ONE node scan (get_balances) regardless of address count, so a
// poll costs `1 + N` node scans (the +N is the per-address mempool, which
// has no batch form yet). The node caps balance/utxo queries at 30/min/IP,
// and the poll is NOT the only consumer — a send fires simulate_transfer on
// each edit plus the transfer, Activity fans out a mempool scan per address,
// and every SSE reconnect triggers a refresh. The old ~27/min pacing left
// almost no headroom, so a normal send tipped the budget over and failed with
// "Rate limit exceeded". We now pace one scan every ~10s, holding the steady
// poll near ~6/min for a 1–2 address wallet and leaving the rest of the budget
// for the actions the user takes. Deposits still surface instantly via the SSE
// push; the poll is just the fallback. UTXO counts and hidden-address balances
// are fetched on demand, not polled.
const MS_PER_SCAN = 10_000;
const MIN_POLL_MS = 15_000;
const MAX_POLL_MS = 60_000;

/** The current auto-refresh interval for `visibleCount` visible addresses.
 *  Exported so the UI can show the live rate and explain that more visible
 *  addresses (and only visible ones — hidden cost nothing) slow it down. */
export function pollIntervalMs(visibleCount: number): number {
  const m = visibleCount || 1;
  // 1 batched get_balances + m per-address mempool scans.
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, (m + 1) * MS_PER_SCAN));
}

// Sort matches the daemon: index asc, imported/unindexed last, then address.
function byIndex(a: WalletEntry, b: WalletEntry): number {
  if (a.index != null && b.index != null) return a.index - b.index;
  if (a.index != null) return -1;
  if (b.index != null) return 1;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [utxos, setUtxos] = useState<Record<string, UtxoInfo>>({});
  // Track the last-seen total so we can detect deposits. `null` until the
  // first successful read so we don't toast the initial balance.
  const lastTotal = useRef<number | null>(null);
  const inFlight = useRef(false);
  // All known entries (including hidden, kept at their last-seen balance).
  // Used to compute the visible poll set and to merge poll results without
  // dropping hidden rows. A ref so the stable poll loop sees current data.
  const entriesRef = useRef<WalletEntry[]>([]);
  const loadedRef = useRef(false);

  // Visible = managed minus hidden. Empty until the first full load.
  const visibleAddrs = useCallback(
    () =>
      entriesRef.current
        .filter((e) => !isHidden(e.address))
        .map((e) => e.address),
    [],
  );

  const load = useCallback(
    async (isPoll: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (!isPoll) setLoading(true);
      try {
        // Full loads (manual refresh / mount) scan every managed address.
        // Polls scan only visible addresses — skip the ones the user hid.
        const known = entriesRef.current;
        const useFilter = isPoll && known.length > 0;
        const params: Record<string, unknown> = { utxos: false, pending: true };
        if (useFilter) params.addresses = visibleAddrs();

        const result = await rpc<WalletBalance>("get_wallet_balance", params);

        // On a filtered poll, merge fresh visible balances over the known
        // set so hidden rows survive (at their last-seen balance). A full
        // load replaces the set outright.
        let entries: WalletEntry[];
        if (useFilter) {
          const byAddr = new Map(known.map((e) => [e.address, e]));
          for (const e of result.entries) byAddr.set(e.address, e);
          entries = [...byAddr.values()].sort(byIndex);
        } else {
          entries = [...result.entries].sort(byIndex);
        }
        entriesRef.current = entries;
        loadedRef.current = true;

        const total = entries.reduce((acc, e) => acc + e.balance, 0);
        // Projected = confirmed + unconfirmed credit − unconfirmed debit.
        // pending_supported is false only if some entry came back without
        // the pending fields (upstream too old); then projected == total.
        const pendingSupported = entries.every(
          (e) => e.pending_received !== undefined,
        );
        const projected = entries.reduce(
          (acc, e) =>
            acc + e.balance + (e.pending_received ?? 0) - (e.pending_spent ?? 0),
          0,
        );
        setBalance({ entries, total, projected, pending_supported: pendingSupported });
        setError(null);

        // Detect incoming funds on PROJECTED, not confirmed total: a
        // deposit shows up the moment it lands in the mempool (seconds
        // after the sender broadcasts), and when it later confirms,
        // pending_received → balance leaves projected unchanged, so we
        // don't double-notify.
        const prev = lastTotal.current;
        if (prev !== null && projected > prev) {
          // Lead with the amount — it reads as money that just landed, not a
          // status update. The balance already reflects it (feels instant).
          const amount = formatExfer(projected - prev);
          toast.incoming(`+${amount}`, "Received");
          osNotify("Deposit received", `+${amount}`);
        }
        lastTotal.current = projected;
      } catch (e) {
        // Don't clobber a good balance on a transient poll failure;
        // only surface the error if we have nothing to show.
        if (!loadedRef.current) setError(String(e));
      } finally {
        if (!isPoll) setLoading(false);
        inFlight.current = false;
      }
    },
    [toast, visibleAddrs],
  );

  const refresh = useCallback(() => load(false), [load]);

  // Ref-counted poll suspension. >0 means the background poll + SSE-triggered
  // refreshes are paused (e.g. while the Send screen is open) so user-initiated
  // simulate/transfer scans get the full per-IP rate-limit budget.
  const suspendCount = useRef(0);
  const suspendPolling = useCallback(() => {
    suspendCount.current += 1;
    return () => {
      suspendCount.current = Math.max(0, suspendCount.current - 1);
    };
  }, []);

  const refreshUtxos = useCallback(async () => {
    try {
      // Only the visible addresses — no point scanning hidden ones.
      const addrs = loadedRef.current ? visibleAddrs() : undefined;
      const r = await rpc<WalletBalance>("get_wallet_balance", {
        utxos: true,
        ...(addrs ? { addresses: addrs } : {}),
      });
      setUtxos((prev) => {
        const next = { ...prev };
        for (const e of r.entries) {
          if (e.utxo_count != null) {
            next[e.address] = {
              utxo_count: e.utxo_count,
              truncated: e.truncated ?? false,
            };
          }
        }
        return next;
      });
    } catch {
      /* on-demand; ignore transient failures */
    }
  }, [visibleAddrs]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const schedule = () => {
      // Recomputed every cycle from the *visible* count, so hiding/removing
      // an address speeds the next poll up automatically.
      const delay = pollIntervalMs(visibleAddrs().length);
      timer = window.setTimeout(run, delay);
    };
    const run = async () => {
      // Skip the scan while suspended (Send screen open), but keep the loop
      // alive so it resumes on the next tick once the suspend is released.
      if (!suspendCount.current) await load(true);
      if (!cancelled) schedule();
    };
    // Initial full load, then begin the paced poll loop.
    load(false).finally(() => {
      if (!cancelled) schedule();
    });
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 2 SSE push: when the embedded walletd's SseClient gets a
  // script_changed / tip / resync nudge from the upstream node, the
  // Rust supervisor emits a "wallet-nudge" Tauri event. Listening
  // here means the balance refreshes the instant the mempool sees an
  // incoming tx, rather than waiting for the next poll tick (was up
  // to ~15 s for a 6-address wallet — now bounded by node→walletd RTT,
  // typically <100 ms).
  //
  // Falls back to polling silently when the node doesn't speak SSE
  // (pre-1.12): the walletd SseClient never connects, no nudges arrive,
  // and this listener is a no-op. The existing setTimeout loop above
  // covers the gap unchanged.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let lastRefreshAt = 0;
    // Coalesce: a tx touching N owned addresses fires N script_changed
    // events. We only need one refresh per burst. 250ms is fast enough
    // that "instant" still feels instant, and keeps us out of the
    // rate-limiter even if a block confirms 50 owned txs at once.
    const COALESCE_MS = 250;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        unlisten = await listen("wallet-nudge", () => {
          // Honor the same suspension as the poll: a nudge mid-send must not
          // spend scan budget the transfer needs.
          if (suspendCount.current) return;
          const now = Date.now();
          if (now - lastRefreshAt < COALESCE_MS) return;
          lastRefreshAt = now;
          // Fire-and-forget; load(true) is the same path the poll uses.
          load(true).catch(() => {
            /* transient; next poll covers it */
          });
        });
      } catch {
        // @tauri-apps/api/event missing (e.g. running under vite dev
        // without the Tauri shell) — just stay on polling.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <WalletCtx.Provider
      value={{ balance, loading, error, refresh, utxos, refreshUtxos, suspendPolling }}
    >
      {children}
    </WalletCtx.Provider>
  );
}
