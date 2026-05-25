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
import type { WalletBalance } from "./types";
import { useToast } from "./toast";
import { osNotify } from "./notify";

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
// ({ utxos: false }) — one upstream scan per address, so at the
// 6-address cap that's ~6 scans/tick. A 20s interval (~18 scans/min)
// stays under the public node's ~30 scans/min while feeling much more
// live than the old balance+utxo poll. UTXO counts are fetched on
// demand via refreshUtxos by the pages that show them.
const POLL_MS = 20_000;

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

  const load = useCallback(
    async (isPoll: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (!isPoll) setLoading(true);
      try {
        // Balance only — UTXO counts come from refreshUtxos on demand.
        const result = await rpc<WalletBalance>("get_wallet_balance", {
          utxos: false,
        });
        setBalance(result);
        setError(null);

        const prev = lastTotal.current;
        if (prev !== null && result.total > prev) {
          const delta = result.total - prev;
          const msg = `+${formatExfer(delta)}`;
          toast.incoming("Funds received", msg);
          osNotify("exfer wallet — funds received", msg);
        }
        lastTotal.current = result.total;
      } catch (e) {
        // Don't clobber a good balance on a transient poll failure;
        // only surface the error if we have nothing to show.
        if (balance === null) setError(String(e));
      } finally {
        if (!isPoll) setLoading(false);
        inFlight.current = false;
      }
    },
    [toast, balance],
  );

  const refresh = useCallback(() => load(false), [load]);

  const refreshUtxos = useCallback(async () => {
    try {
      const r = await rpc<WalletBalance>("get_wallet_balance", {
        utxos: true,
      });
      const map: Record<string, UtxoInfo> = {};
      for (const e of r.entries) {
        if (e.utxo_count != null) {
          map[e.address] = {
            utxo_count: e.utxo_count,
            truncated: e.truncated ?? false,
          };
        }
      }
      setUtxos(map);
      // This response also carries fresh balances — adopt them and keep
      // lastTotal in sync so the next cheap poll doesn't re-toast.
      setBalance(r);
      lastTotal.current = r.total;
    } catch {
      /* on-demand; ignore transient failures */
    }
  }, []);

  useEffect(() => {
    load(false);
    const id = window.setInterval(() => load(true), POLL_MS);
    return () => window.clearInterval(id);
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
