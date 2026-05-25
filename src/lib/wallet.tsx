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

interface WalletData {
  balance: WalletBalance | null;
  loading: boolean;
  error: string | null;
  /** Manual refresh — call after a send or generate so the UI updates
   *  immediately instead of waiting for the next poll tick. */
  refresh: () => Promise<void>;
}

const WalletCtx = createContext<WalletData | null>(null);

export function useWallet(): WalletData {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet must be used within <WalletProvider>");
  return ctx;
}

// Poll cadence. get_wallet_balance fans out to balance+utxo per address
// server-side; at the 6-address cap that's ~12 upstream scans/tick. A
// 45s interval keeps us comfortably under the public node's 30 scans/min
// while still feeling live.
const POLL_MS = 45_000;

export function WalletProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
        const result = await rpc<WalletBalance>("get_wallet_balance");
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

  useEffect(() => {
    load(false);
    const id = window.setInterval(() => load(true), POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <WalletCtx.Provider value={{ balance, loading, error, refresh }}>
      {children}
    </WalletCtx.Provider>
  );
}
