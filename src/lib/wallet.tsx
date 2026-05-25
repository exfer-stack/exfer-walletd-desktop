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
}

const WalletCtx = createContext<WalletData | null>(null);

export function useWallet(): WalletData {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet must be used within <WalletProvider>");
  return ctx;
}

// Poll cadence. The background poll asks for balances only
// ({ utxos: false }) and scans only the visible (non-hidden) addresses,
// so it's one upstream scan per visible address. We pace the interval
// to that count — ~5s per visible address — so a single-address wallet
// refreshes every 5s while a full 6-address wallet stays at 20s, both
// under the public node's ~30 scans/min. UTXO counts and hidden-address
// balances are fetched on demand, not polled.
const MS_PER_ADDRESS = 5_000;
const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 20_000;

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
        const params: Record<string, unknown> = { utxos: false };
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
        setBalance({ entries, total });
        setError(null);

        const prev = lastTotal.current;
        if (prev !== null && total > prev) {
          const msg = `+${formatExfer(total - prev)}`;
          toast.incoming("Funds received", msg);
          osNotify("exfer wallet — funds received", msg);
        }
        lastTotal.current = total;
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
      const m = visibleAddrs().length || 1;
      const delay = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, m * MS_PER_ADDRESS));
      timer = window.setTimeout(run, delay);
    };
    const run = async () => {
      await load(true);
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

  return (
    <WalletCtx.Provider
      value={{ balance, loading, error, refresh, utxos, refreshUtxos }}
    >
      {children}
    </WalletCtx.Provider>
  );
}
