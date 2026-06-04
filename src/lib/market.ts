// EXFER spot price (USD) + BNB/USD anchor, ported from the mobile wallet.
// The displayed EXFER price is the pool's own exchange rate sampled into candles
// server-side (swap_price_klines); today's candle close is the current price.
// BNB/USD comes from Binance (Rust get_bnb_price in the app, /__bnbusd vite
// proxy in browser dev). All USD is best-effort: any fetch failure resolves to
// the last cached value, or null, and callers render without USD.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { devmock } from "./devmock";
import { rpc } from "./rpc";

export interface MarketPrice {
  /** USD per 1 EXFER. */
  usd: number;
  /** 24h change in percent (close vs. previous daily close). */
  change24h: number;
}

const EXFER_UNIT = 100_000_000; // 1 EXFER = 1e8 exfers

const CACHE_KEY = "exfer-walletd-desktop-price-cache-v1";

function readCachedPrice(): MarketPrice | null {
  try {
    const o = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (o && typeof o.usd === "number" && o.usd > 0) {
      return { usd: o.usd, change24h: typeof o.change24h === "number" ? o.change24h : 0 };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function getMarketPrice(): Promise<MarketPrice | null> {
  try {
    const res = await rpc<{ items?: { c: number | string }[] }>("swap_price_klines", {
      interval: "1d",
      limit: 2,
    });
    const items = res?.items;
    if (!Array.isArray(items) || items.length === 0) return readCachedPrice();
    const usd = Number(items[items.length - 1].c);
    if (!isFinite(usd) || usd <= 0) return readCachedPrice();
    const prev = items.length >= 2 ? Number(items[items.length - 2].c) : usd;
    const change24h = isFinite(prev) && prev > 0 ? ((usd - prev) / prev) * 100 : 0;
    const p = { usd, change24h };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(p));
    } catch {
      /* ignore */
    }
    return p;
  } catch {
    return readCachedPrice();
  }
}

/** Live EXFER price. `null` until the first successful fetch (stays at the last
 *  good value if a later refresh fails). Refreshes every 60s. */
export function usePrice(): MarketPrice | null {
  const [price, setPrice] = useState<MarketPrice | null>(readCachedPrice);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      getMarketPrice().then((p) => {
        if (alive && p) setPrice(p);
      });
    void tick();
    const id = window.setInterval(tick, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return price;
}

// ── BNB/USD spot ─────────────────────────────────────────────────────────
const BNB_CACHE_KEY = "exfer-walletd-desktop-bnbusd-cache-v1";

function readCachedBnbUsd(): number | null {
  try {
    const v = Number(JSON.parse(localStorage.getItem(BNB_CACHE_KEY) || "null"));
    return isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function getBnbUsd(): Promise<number | null> {
  try {
    let raw: string;
    if (devmock.isActive()) {
      const r = await fetch("/__bnbusd/api/v3/ticker/price?symbol=BNBUSDT");
      if (!r.ok) return null;
      raw = await r.text();
    } else {
      raw = await invoke<string>("get_bnb_price");
    }
    const price = Number((JSON.parse(raw) as { price?: string }).price);
    if (!isFinite(price) || price <= 0) return null;
    try {
      localStorage.setItem(BNB_CACHE_KEY, JSON.stringify(price));
    } catch {
      /* ignore */
    }
    return price;
  } catch {
    return null;
  }
}

/** Live BNB/USD spot. Seeded from cache, refreshes every 60s. */
export function useBnbUsd(): number | null {
  const [v, setV] = useState<number | null>(readCachedBnbUsd);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      getBnbUsd().then((p) => {
        if (alive && p) setV(p);
      });
    void tick();
    const id = window.setInterval(tick, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return v;
}

/** Format an exfer-denominated amount as its USD value, compactly. */
export function usdValue(exfers: number, usd: number): string {
  const v = (exfers / EXFER_UNIT) * usd;
  if (v <= 0) return "$0";
  if (v < 0.0001) return "$<0.0001";
  if (v < 1) return "$" + v.toFixed(4);
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a plain USD number compactly (for non-exfer amounts, e.g. BNB value). */
export function usdNumber(v: number): string {
  if (!isFinite(v) || v <= 0) return "$0";
  if (v < 0.0001) return "$<0.0001";
  if (v < 1) return "$" + v.toFixed(4);
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
