// Shared in-wallet BNB (BSC) asset hook. Owns the single source of truth for
// the wallet's derived BSC address (bsc_get_address) and its live BNB balance
// (bsc_get_balances), so every consumer — the Swap panel and the Dashboard
// card — reads the same polled value instead of each spinning up its own loop.
//
// Degrades gracefully: when walletd has no HD seed / the swap engine is off,
// the RPCs throw, we swallow it, and `address` stays null so callers can hide
// the BNB surface entirely.

import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "./rpc";
import { useToast } from "./toast";
import { useT } from "./i18n";

/** Format a smallest-unit integer string (e.g. wei) to a short human amount. */
export function fmtUnits(raw: string | undefined, decimals: number, frac = 4): string {
  if (!raw) return "0";
  try {
    const n = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const fracStr = (n % base)
      .toString()
      .padStart(decimals, "0")
      .slice(0, frac)
      .replace(/0+$/, "");
    return fracStr ? `${n / base}.${fracStr}` : `${n / base}`;
  } catch {
    return "0";
  }
}

export interface BnbAsset {
  /** The wallet's derived BSC address (m/44'/60'/0'/0/0), or null until known. */
  address: string | null;
  /** Live BNB balance in wei (string), or null until first poll succeeds. */
  bnbWei: string | null;
  /** Force an immediate re-poll of address + balance. */
  refresh: () => void;
}

/**
 * useBnbAsset — single-source poll of the wallet's BSC address + BNB balance.
 *
 * Polls bsc_get_balances every 5s (and bsc_get_address once it's missing). A
 * fresh incoming deposit fires a toast so it's never silent — pass
 * `announceDeposits: false` to suppress that (e.g. a passive Dashboard card).
 */
export function useBnbAsset(opts: { announceDeposits?: boolean } = {}): BnbAsset {
  const { announceDeposits = true } = opts;
  const toast = useToast();
  const { t } = useT();
  const [address, setAddress] = useState<string | null>(null);
  const [bnbWei, setBnbWei] = useState<string | null>(null);
  const lastWei = useRef<bigint | null>(null);
  // Keep the latest address in a ref so the poll closure stays stable.
  const addrRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (!addrRef.current) {
        const a = await rpc<{ address: string }>("bsc_get_address");
        addrRef.current = a.address;
        setAddress(a.address);
      }
      const b = await rpc<{ bnb_wei: string }>("bsc_get_balances");
      setBnbWei(b.bnb_wei);
      const now = BigInt(b.bnb_wei);
      const prev = lastWei.current;
      if (announceDeposits && prev != null && now > prev) {
        const delta = fmtUnits((now - prev).toString(), 18, 5);
        toast.incoming(`+${delta} BNB`, t("swap.depositReceived"));
      }
      lastWei.current = now;
    } catch {
      /* engine off / no HD seed — caller hides the BNB surface */
    }
  }, [announceDeposits, toast, t]);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) void load();
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [load]);

  return { address, bnbWei, refresh: load };
}
