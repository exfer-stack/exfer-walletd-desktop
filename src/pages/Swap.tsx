// Swap — EXFER ↔ BNB (BSC) cross-chain atomic swap. A thin UI over walletd's
// swap engine: swap_get_quote → swap_execute → poll swap_status. The daemon
// owns the preimage and both HTLC legs; this page is the 3-step wizard plus the
// in-wallet BNB account surface (a BSC address walletd derives from the same
// seed — m/44'/60'/0'/0/0 — so buy-side deposits have somewhere to land).
//
// Flow:
//   step 1  pick direction + from-address + amount       → Review
//   step 2  review the real quote (amount_out / rate)    → Confirm
//   step 3  progress: poll swap_status until terminal
//
// We quote on the Review click (not per keystroke) because each quote reserves
// a preimage and seals the journal — too costly to run on every input change.
//
// Everything degrades gracefully when walletd has no swap pool configured: the
// pool-info / bsc calls throw, we catch them, and the page shows a quiet
// "swap unavailable" notice instead of erroring.

import { useEffect, useMemo, useRef, useState } from "react";
import { formatExferInput, formatBalanceCompact, rpc } from "../lib/rpc";
import type {
  SwapDirection,
  SwapRec,
  PoolInfo,
  PoolInfoRaw,
  WalletEntry,
} from "../lib/types";
import { getLabel, shortAddress } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import { useWallet } from "../lib/wallet";
import { useToast } from "../lib/toast";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { useEscapeKey } from "../lib/useEscapeKey";
import {
  usePrice,
  useBnbUsd,
  usdNumber,
  getKlines,
  circulatingSupplyExfer,
  getBlockHeight,
  type MarketPrice,
  type Candle,
} from "../lib/market";
import { recordSwapUsd } from "../lib/swapPrice";
import { useBnbAsset } from "../lib/bnb";
import { BnbAccount } from "../components/BnbAccount";
import { StagedStepper, SuccessMark, ExferMark } from "../components/anim";
import { PriceChart } from "../components/PriceChart";
import { useResumeTarget } from "../lib/inflight";

// Permissive decimal: BNB carries up to 18 fractional digits, EXFER up to 8.
const AMOUNT_RE = /^\d*\.?\d*$/;

// The pool deducts a settlement-gas fee (network_fee_bnb, in BNB) from the
// output. Until a firm quote lands we don't know it, so fall back to the pool's
// default SWAP_GAS_FEE_BNB so the step-1 estimate already accounts for it and
// the client-side minimum guard works even if the field is ever missing.
const NET_FEE_BNB_FALLBACK = 0.0002;

/** Trim a human decimal string to at most `dp` fractional digits (drops
 *  trailing zeros), falling back to significant digits for values that would
 *  otherwise round to a misleading "0". */
function fmtAmt(s: string | undefined, dp = 6): string {
  if (!s) return s ?? "0";
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, dp).replace(/0+$/, "");
  if (!frac && w === "0") {
    const n = Number(s);
    if (isFinite(n) && n !== 0)
      return n.toLocaleString("en-US", {
        maximumSignificantDigits: 4,
        useGrouping: false,
      });
  }
  return frac ? `${w}.${frac}` : w;
}

/** Normalize a typed amount into a strictly daemon-parseable decimal before it
 *  goes to swap_get_quote: a leading/trailing dot (".5" / "5.") becomes "0.5" /
 *  "5", and the fraction is clamped to the token's precision (8 dp EXFER, 18 dp
 *  BNB). The live on-screen estimate tolerates these via Number(), but the quote
 *  RPC parses strictly and 400s on a leading dot or over-precision. */
function normalizeAmountInput(s: string, dp: number): string {
  let t = s.trim();
  if (t.startsWith(".")) t = "0" + t;
  if (t.endsWith(".")) t = t.slice(0, -1);
  const [w, f] = t.split(".");
  const whole = w === "" ? "0" : w;
  if (f == null) return whole;
  const frac = f.slice(0, dp).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** A tiny inline spinner (Tailwind animate-spin) for the refunding/waiting bits. */
function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

// Ordered swap lifecycle for the progress checklist. refunding/refunded/failed
// are terminal off-path states handled separately.
const STATUS_RANK: Record<string, number> = {
  quoted: 0,
  user_locked: 1,
  pool_locked: 2,
  claiming: 3,
  completed: 4,
};

export function Swap() {
  const { balance, refresh, suspendPolling } = useWallet();
  const toast = useToast();
  const { t } = useT();
  const price = usePrice();
  const bnbUsd = useBnbUsd();

  // Resume hand-off: if the nav (a badge / in-flight list) set a resumeSwapId,
  // open the progress step watching that swap. Read once on mount and clear the
  // target so a later return to the tab starts fresh. useResumeTarget() works
  // standalone (no-op when no <InflightProvider> is mounted yet), so this is a
  // safe no-op until the provider lands. Mirrors mobile SwapSheet's resumeSwapId.
  const { resumeSwapId, clearResumeTarget } = useResumeTarget();
  const resumeIdRef = useRef<string | undefined>(resumeSwapId);
  useEffect(() => {
    if (resumeSwapId) clearResumeTarget();
    // intentionally mount-only: we snapshot the id into resumeIdRef on first render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reserve the per-IP scan-rate budget while swapping, exactly like Send.
  useEffect(() => suspendPolling(), [suspendPolling]);

  // One-shot refresh on entry: polling is suspended above (rate budget), so the
  // From-picker would otherwise show whatever stale snapshot the last poll left.
  // A single refresh on mount makes the picker balances fresh the moment Swap
  // opens — and they share useWallet().balance with the Dashboard total, so the
  // two can never disagree (same object), they just both update on this refresh
  // and again when a swap completes.
  useEffect(() => {
    refresh();
    // mount-only — a fresh snapshot on entry, then suspended polling holds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [step, setStep] = useState<1 | 2 | 3>(resumeSwapId ? 3 : 1);
  const [direction, setDirection] = useState<SwapDirection>("exfer_to_bnb");
  const [from, setFrom] = useState("");
  const [amount, setAmount] = useState("");
  // Which side the user is editing. "pay" = forward (type pay → estimate the
  // receive). "receive" = reverse: the user types a desired receive amount and
  // an effect back-computes the pay `amount`, so the rest of the sheet (quote,
  // USD, Review) keeps working off `amount` as usual.
  const [recvInput, setRecvInput] = useState("");
  const [editSide, setEditSide] = useState<"pay" | "receive">("pay");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<SwapRec | null>(null);
  const [live, setLive] = useState<SwapRec | null>(null);
  const [poolInfo, setPoolInfo] = useState<PoolInfo | null>(null);
  // Gate: a high-impact trade must be explicitly confirmed before execute.
  const [showImpactConfirm, setShowImpactConfirm] = useState(false);
  // null = unknown yet; false = engine confirmed off (pool_info threw).
  const [engineOn, setEngineOn] = useState<boolean | null>(null);

  // The wallet's BSC address + balance — single poll, owned by useBnbAsset and
  // shared with the <BnbAccount> panel below. `bnbWei` drives the buy-side
  // deposit lead, the buyMax button, and the "Waiting for your BNB…" spinner.
  // The hook also fires the deposit-arrival toast.
  const bnbAsset = useBnbAsset();
  const bnbWei = bnbAsset.bnbWei;

  const sell = direction === "exfer_to_bnb";
  const sendUnit = sell ? "EXFER" : "BNB";
  const recvUnit = sell ? "BNB" : "EXFER";

  const entries = useMemo<WalletEntry[]>(
    () => (balance?.entries ?? []).filter((e) => !isHidden(e.address)),
    [balance],
  );
  // Sell locks EXFER from a funded address; buy just needs an address to
  // receive the EXFER into.
  const pickList = useMemo(
    () => (sell ? entries.filter((e) => e.balance > 0) : entries),
    [entries, sell],
  );
  const fromAddr = from || pickList[0]?.address || "";

  // Pool rate (BNB per 1 EXFER) — also the engine on/off probe.
  useEffect(() => {
    let cancelled = false;
    rpc<PoolInfoRaw>("swap_pool_info")
      .then((p) => {
        if (cancelled) return;
        setPoolInfo({
          mid: p.mid_price_bnb_per_exfer,
          feeBps: p.fee_bps,
          exferReserve: Number(p.exfer_reserve) || 0,
          bnbReserve: Number(p.bnb_reserve) || 0,
          maxSwapBps: Number(p.max_swap_bps) || 500,
        });
        setEngineOn(true);
      })
      .catch(() => {
        if (!cancelled) setEngineOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const amountValid = AMOUNT_RE.test(amount.trim()) && Number(amount) > 0;

  // Live client-side estimate of the output (the real quote happens on Review).
  // Uses the SAME constant-product formula as the pool (Uniswap-v2 with fee) —
  // NOT a flat amount×mid — so the estimate already includes slippage: a bigger
  // trade gets a visibly worse rate, matching what swap_get_quote returns. Falls
  // back to the linear mid only when the reserves aren't known yet.
  const estOut = useMemo(() => {
    if (!poolInfo || !amountValid || poolInfo.mid <= 0) return null;
    const a = Number(amount);
    if (!isFinite(a) || a <= 0) return null;
    const reserveIn = sell ? poolInfo.exferReserve : poolInfo.bnbReserve;
    const reserveOut = sell ? poolInfo.bnbReserve : poolInfo.exferReserve;
    if (reserveIn > 0 && reserveOut > 0) {
      const inWithFee = (a * (10_000 - poolInfo.feeBps)) / 10_000;
      return (inWithFee * reserveOut) / (reserveIn + inWithFee);
    }
    return sell ? a * poolInfo.mid : a / poolInfo.mid;
  }, [poolInfo, amount, amountValid, sell]);

  // The settlement-gas fee (BNB) the pool deducts. Read the live quote when we
  // have one, else the pool's default until a firm quote lands.
  const estNetFee =
    quote?.network_fee_bnb && Number(quote.network_fee_bnb) > 0
      ? Number(quote.network_fee_bnb)
      : NET_FEE_BNB_FALLBACK;

  // Net of the pool's network fee — what actually ARRIVES — so the step-1
  // "You receive" matches the review (which deducts it). Without this the form
  // showed the gross output and the review then dropped for a small swap.
  const estOutNet = useMemo(() => {
    if (estOut == null) return null;
    if (sell) return Math.max(0, estOut - estNetFee); // BNB out, minus the fee
    // Buy: the pool prices EXFER on (BNB in − fee); re-derive on the net input.
    const a = Number(amount);
    if (!poolInfo || !isFinite(a)) return estOut;
    const net = a - estNetFee;
    if (net <= 0) return 0;
    const ri = poolInfo.bnbReserve;
    const ro = poolInfo.exferReserve;
    if (ri > 0 && ro > 0) {
      const inWithFee = (net * (10_000 - poolInfo.feeBps)) / 10_000;
      return (inWithFee * ro) / (ri + inWithFee);
    }
    return net / poolInfo.mid;
  }, [estOut, sell, estNetFee, amount, poolInfo]);

  // Reverse binding: when the user types a desired RECEIVE amount, back-compute
  // the pay `amount` (constant-product inverse + the network fee). Mirrors mobile.
  useEffect(() => {
    if (editSide !== "receive" || !poolInfo) return;
    const want = Number(recvInput);
    if (!isFinite(want) || want <= 0) {
      setAmount("");
      return;
    }
    const reserveIn = sell ? poolInfo.exferReserve : poolInfo.bnbReserve;
    const reserveOut = sell ? poolInfo.bnbReserve : poolInfo.exferReserve;
    // Gross output the AMM must produce to NET `want`: a sell nets BNB (the fee
    // is taken from the BNB output), a buy receives EXFER (fee is on the BNB in).
    const grossOut = sell ? want + estNetFee : want;
    // Asking for more than the pool can ever output (or bad reserves): clear the
    // pay field rather than leaving a stale value that Review would act on.
    if (!(reserveIn > 0 && reserveOut > 0) || grossOut >= reserveOut) {
      setAmount("");
      return;
    }
    // Uniswap-v2 inverse: input needed for a desired output, incl. the fee.
    const inHuman =
      (reserveIn * grossOut) /
      ((reserveOut - grossOut) * (1 - poolInfo.feeBps / 10_000));
    const payHuman = sell ? inHuman : inHuman + estNetFee;
    // Render to the pay token's precision (8 dp EXFER / 18 dp BNB), trailing
    // zeros trimmed, no grouping. toFixed (not maximumSignificantDigits) so a
    // value never carries more decimals than the quote parser accepts; a dust
    // request that rounds below one unit clears the field instead of showing a
    // misleading "0" that silently dead-ends Review.
    const dp = sell ? 8 : 18;
    const s =
      payHuman > 0 && isFinite(payHuman)
        ? payHuman.toFixed(dp).replace(/\.?0+$/, "")
        : "";
    setAmount(Number(s) > 0 ? s : "");
  }, [editSide, recvInput, poolInfo, sell, estNetFee]);

  // ── Client-side minimum (item [6]) ──
  // A trade whose whole output is eaten by the settlement-gas fee is pointless
  // and the daemon 400s it. Mirror the pool: accept any trade whose output
  // exceeds the network fee (small buffer for the AMM/fee gap), and convert the
  // BNB floor to the INPUT unit so we can show "Min ~N {unit}" and block Review.
  const minOutBnb = estNetFee * 1.2;
  const minAmount =
    poolInfo && poolInfo.mid > 0
      ? sell
        ? minOutBnb / poolInfo.mid
        : minOutBnb
      : 0;
  const belowMin = amountValid && minAmount > 0 && Number(amount) < minAmount;

  // Effective EXFER/USD: the OTC EXFER quote, falling back to the pool mid ×
  // BNB/USD. Best-effort — null hides the ≈$ figures.
  const exferUsd =
    price?.usd ?? (poolInfo && poolInfo.mid > 0 && bnbUsd ? poolInfo.mid * bnbUsd : null);

  // Price impact = the fraction of the input-side reserve this trade consumes
  // (constant-product). We DON'T cap the amount — the user may swap whatever
  // they want and eat the slippage — but we warn when impact is high so the
  // consequence is clear. maxSwapBps (the old hard cap) is reused as the
  // "high impact" threshold.
  const priceImpact = useMemo(() => {
    if (!poolInfo || !amountValid) return 0;
    const a = Number(amount);
    if (!isFinite(a) || a <= 0) return 0;
    const inReserve = sell ? poolInfo.exferReserve : poolInfo.bnbReserve;
    if (inReserve <= 0) return 1;
    return a / (inReserve + a);
  }, [poolInfo, amount, amountValid, sell]);
  const highImpact = !!poolInfo && priceImpact * 10_000 >= poolInfo.maxSwapBps;

  const bnbZero = (() => {
    if (bnbWei == null) return false;
    try {
      return BigInt(bnbWei) === 0n;
    } catch {
      return false;
    }
  })();
  // No BSC key at all (a seedless / imported wallet): a buy has nowhere to lock
  // BNB from. Surface the same "fund" card, which renders BnbAccount's set-up
  // pane when !created — otherwise the user could type an amount, hit Review,
  // and only fail at Confirm with a raw daemon error, with no way to create a
  // BNB wallet anywhere on this page.
  const noBscKey = bnbAsset.ready && !bnbAsset.created;
  // Buy with no BNB yet (or no BNB wallet yet): lead with the deposit / set-up
  // card and de-emphasize the amount field so the order of operations reads
  // top-to-bottom (1. Add BNB → 2. Enter).
  const needsFunding = !sell && (bnbZero || noBscKey);

  // Sell Max = the funded address's spendable EXFER. Buy Max = all spendable
  // BNB, less a small gas reserve (BNB is also the gas token), capped at the
  // pool's per-swap size cap.
  // Sell Max must leave room for the EXFER lock's own network fee (paid from the
  // same UTXOs, ~69 exfers/input) — otherwise locking 100% fails with
  // "insufficient balance (amount + fee)". Reserve a small per-UTXO buffer so a
  // true Max swap always builds; the tiny remainder stays in the wallet.
  const sellMax = useMemo(() => {
    if (!sell) return 0;
    const e = pickList.find((x) => x.address === fromAddr);
    const bal = e?.balance ?? 0;
    const feeReserve = Math.max(2000, (e?.utxo_count ?? 1) * 500);
    return Math.max(0, bal - feeReserve);
  }, [sell, pickList, fromAddr]);
  // BNB balance in human units — drives the buy-side "Balance:" line.
  const bnbHuman = useMemo(() => {
    if (!bnbWei) return 0;
    try {
      return Number(BigInt(bnbWei)) / 1e18;
    } catch {
      return 0;
    }
  }, [bnbWei]);
  const buyMax = useMemo(() => {
    if (sell || !bnbWei) return 0;
    let bnbHuman = 0;
    try {
      bnbHuman = Number(BigInt(bnbWei)) / 1e18;
    } catch {
      return 0;
    }
    const GAS_RESERVE = 0.002; // ample for a BSC HTLC lock (gas is ~0.0001 BNB)
    let m = Math.max(0, bnbHuman - GAS_RESERVE);
    if (poolInfo && poolInfo.bnbReserve > 0) {
      const capBySize = poolInfo.bnbReserve * (poolInfo.maxSwapBps / 10_000);
      m = Math.min(m, capBySize);
    }
    return Math.max(0, m);
  }, [sell, bnbWei, poolInfo]);

  function reset() {
    setStep(1);
    setQuote(null);
    setLive(null);
    setAmount("");
    setRecvInput("");
    setEditSide("pay");
    setErr(null);
    // Drop the resume hand-off so finishing a resumed swap returns to a fresh
    // form rather than re-entering the progress watcher.
    resumeIdRef.current = undefined;
  }

  function switchDirection(d: SwapDirection) {
    if (d === direction) return;
    setDirection(d);
    setFrom("");
    setAmount("");
    setRecvInput("");
    setEditSide("pay");
    setErr(null);
    setQuote(null);
  }

  async function getQuote() {
    if (!amountValid) {
      setErr(t("swap.errEnterAmount"));
      return;
    }
    if (!fromAddr) {
      setErr(sell ? t("swap.noFundedAddr") : t("swap.errNoReceiveAddr"));
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const q = await rpc<SwapRec>("swap_get_quote", {
        direction,
        // Normalize ".5"/"5."/over-precision into a strict decimal the quote
        // RPC accepts (sell pays EXFER = 8 dp, buy pays BNB = 18 dp).
        amount_in: normalizeAmountInput(amount, sell ? 8 : 18),
        from: fromAddr,
      });
      setQuote(q);
      setStep(2);
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  // Tapping Confirm: a high-impact trade pops a confirmation first; everything
  // else goes straight to execute.
  function confirm() {
    if (!quote) return;
    if (highImpact) {
      setShowImpactConfirm(true);
      return;
    }
    void doExecute();
  }

  async function doExecute() {
    if (!quote) return;
    setShowImpactConfirm(false);
    setBusy(true);
    setErr(null);
    try {
      const r = await rpc<SwapRec>("swap_execute", { swap_id: quote.swap_id });
      // Snapshot the effective EXFER/USD now, so the activity record can later
      // show what this swap was worth at execution time.
      if (exferUsd != null) recordSwapUsd(quote.swap_id, exferUsd);
      setLive(r);
      setStep(3);
      toast.success(t("swap.toastStartedTitle"), t("swap.toastStartedBody"));
    } catch (e) {
      // An expired quote is recoverable: bounce back to step 1 to re-quote.
      if (/expired/i.test(String((e as { message?: unknown })?.message ?? e))) {
        setQuote(null);
        setStep(1);
        toast.error(t("swap.toastQuoteExpiredTitle"), t("swap.toastQuoteExpiredBody"));
      } else {
        setErr(humanizeError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function manualRefund() {
    const id = quote?.swap_id ?? resumeIdRef.current;
    if (!id) return;
    setBusy(true);
    try {
      const r = await rpc<SwapRec>("swap_refund", { swap_id: id });
      setLive(r);
      toast.success(t("swap.toastRefundTitle"), t("swap.toastRefundBody"));
    } catch (e) {
      toast.error(t("swap.toastRefundFailedTitle"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  // Poll status while the swap is in progress. When resuming, there's no local
  // quote — watch the handed-off swap id directly (mirrors mobile SwapSheet).
  const watchId = quote?.swap_id ?? resumeIdRef.current;
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (step !== 3 || !watchId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await rpc<SwapRec>("swap_status", { swap_id: watchId });
        if (cancelled) return;
        setLive(r);
        if (["completed", "refunded", "failed"].includes(r.status)) {
          refresh();
          return; // terminal — stop polling
        }
      } catch {
        /* transient; keep polling */
      }
      pollRef.current = window.setTimeout(tick, 2000);
    };
    tick();
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [step, watchId, refresh]);

  // On completion, gently auto-reset back to step 1 after a beat so the user
  // isn't left staring at a finished screen.
  useEffect(() => {
    if (step !== 3) return;
    if (live?.status !== "completed") return;
    const id = window.setTimeout(() => reset(), 3200);
    return () => window.clearTimeout(id);
  }, [step, live?.status]);

  // Elapsed seconds on the progress screen, for the "taking longer" hint + the
  // manual-refund escape hatch after 90s.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (step !== 3) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - t0) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [step]);

  // Pool rate metadata for the page bar (rendered once, replaces the step-1 strip).
  const poolRate =
    poolInfo && poolInfo.mid > 0
      ? `${t("swap.poolRateValue", { rate: fmtAmt(String(poolInfo.mid), 6) })} · ${t("swap.poolFeeShort", { pct: (poolInfo.feeBps / 100).toFixed(2) })}`
      : null;

  if (engineOn === false) {
    // The pool is down, but the market chart doesn't depend on it — keep it
    // visible and present the notice as a constrained, centered empty-state so
    // the wide viewport reads as purposeful rather than a void.
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-6 fade-in">
        <PageBar poolRate={null} />
        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-12 lg:col-span-8">
            <MarketHeader price={price} />
          </div>
          <div className="col-span-12 lg:col-span-4">
            <div className="lg:sticky lg:top-6">
              <div className="banner-info max-w-md text-sm leading-relaxed">
                {t("swap.unavailablePre")}
                <span className="font-medium text-cyan-50">
                  {t("swap.unavailableSettings")}
                </span>
                {t("swap.unavailablePost")}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6 fade-in">
      {/* Page bar: title left, live EXFER/USD + 24h change + pool rate right. */}
      <PageBar poolRate={poolRate} />

      {/* Two panes. The chart (left) is the SHORT column so it's the one we pin —
          it stays under the taller wizard rail as that rail scrolls, instead of
          scrolling out and leaving the left half blank. The wizard + BNB account
          (right) is the tall column and scrolls naturally. The columns must
          STRETCH (grid default — do NOT add items-start) so the left column's
          box is as tall as the right rail; that tall box is what gives the
          sticky chart room to stay pinned for the whole scroll. */}
      <div className="grid grid-cols-12 gap-6">
        {/* LEFT — market chart + stats; the dominant width goes to the chart. */}
        <div className="col-span-12 lg:col-span-8">
          <div className="lg:sticky lg:top-6">
            <MarketHeader price={price} />
          </div>
        </div>

        {/* RIGHT — the swap wizard with the BNB account as its natural filler. */}
        <div className="col-span-12 lg:col-span-4">
          <div className="space-y-4">
            {step === 1 && (
              <div className="card p-5 space-y-3.5">
                {/* Buy with no BNB yet: lead with a single-purpose "Add BNB"
                    deposit card so the order of operations reads top-to-bottom
                    (1. Add BNB → 2. Enter). Deposit-only — the withdraw/export
                    console is suppressed here (nothing to withdraw at zero) and
                    the compact account card below is hidden to avoid showing the
                    same BNB panel twice. */}
                {needsFunding && <BnbAccount asset={bnbAsset} variant="fund" waiting />}

                {/* The canonical reversible pair: a "You pay" card over a "You
                    receive" card with a circular ⇅ on the seam between them.
                    Tapping ⇅ flips direction while keeping the typed amount and
                    selected address. EXFER / BNB are token chips, not verbs. */}
                <div className="relative flex flex-col gap-1">
                  {/* You pay — de-emphasized until there's BNB to swap on buy. */}
                  <div
                    className={
                      "rounded-xl border border-neutral-800 bg-neutral-950 p-4 " +
                      (needsFunding ? "opacity-50 pointer-events-none" : "")
                    }
                  >
                    <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                      {t("swap.youSend")}
                    </span>
                    <div className="mt-1.5 flex items-center gap-3">
                      <input
                        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-2xl font-semibold tabular-nums text-neutral-100 outline-none placeholder:text-neutral-600"
                        placeholder="0.0"
                        value={amount}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "" || AMOUNT_RE.test(v)) {
                            setEditSide("pay");
                            setAmount(v);
                          }
                        }}
                        disabled={busy || needsFunding}
                        inputMode="decimal"
                      />
                      <TokenChip unit={sendUnit} />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                      <span className="text-neutral-500">
                        {t("lp.balance")}:{" "}
                        {sell
                          ? formatBalanceCompact(sellMax)
                          : `${fmtAmt(String(bnbHuman), 4)} BNB`}
                      </span>
                      {minAmount > 0 && (
                        <span
                          className={belowMin ? "text-amber-300" : "text-neutral-500"}
                        >
                          {t("swap.minAmount", {
                            n: minAmount.toLocaleString("en-US", {
                              maximumSignificantDigits: 3,
                              useGrouping: false,
                            }),
                            unit: sendUnit,
                          })}
                        </span>
                      )}
                    </div>
                    {/* 25/50/75/Max quick-fill chips off the pay-side ceiling. */}
                    <PercentChips
                      max={sell ? sellMax : buyMax}
                      onPick={(v) => {
                        setEditSide("pay");
                        setAmount(
                          // sell: v is in smallest units (exfers) and a %-chip
                          // makes it fractional — floor to an integer. Use the
                          // NON-grouped input formatter (formatExfer adds commas
                          // for ≥1,000 EXFER, which the quote parser rejects).
                          // buy: v is human BNB.
                          sell
                            ? formatExferInput(Math.floor(v))
                            : fmtAmt(String(v), 8),
                        );
                      }}
                    />
                  </div>

                  {/* Reverse — sewn onto the seam between the two cards: a
                      zero-height row so the cards stay tight, the button
                      centered ON the seam, straddling both edges. */}
                  <div className="relative z-[2] h-0">
                    <button
                      type="button"
                      aria-label="Reverse direction"
                      onClick={() =>
                        switchDirection(sell ? "bnb_to_exfer" : "exfer_to_bnb")
                      }
                      disabled={busy}
                      className="absolute left-1/2 top-1/2 grid h-[30px] w-[30px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-neutral-700 bg-neutral-800 text-neutral-200 shadow-md transition hover:border-cyan-400 hover:text-cyan-300 disabled:opacity-50"
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M7 4v14M7 4L4 7M7 4l3 3M17 20V6m0 14l3-3m-3 3l-3-3" />
                      </svg>
                    </button>
                  </div>

                  {/* You receive (est.) — editable: type a desired receive amount
                      and the pay side is back-computed. While editing the pay
                      side it shows the live net estimate. The firm quote lands on
                      Review. */}
                  <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                      {t("swap.youReceiveEst")}
                    </span>
                    <div className="mt-1.5 flex items-center gap-3">
                      <input
                        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-2xl font-semibold tabular-nums text-neutral-100 outline-none placeholder:text-neutral-600"
                        placeholder="0.0"
                        value={
                          editSide === "receive"
                            ? recvInput
                            : estOutNet != null
                              ? fmtAmt(String(estOutNet), 6)
                              : ""
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "" || AMOUNT_RE.test(v)) {
                            setEditSide("receive");
                            setRecvInput(v);
                          }
                        }}
                        disabled={busy || needsFunding}
                        inputMode="decimal"
                      />
                      <TokenChip unit={recvUnit} />
                    </div>
                  </div>
                </div>

                {/* Quote detail: ≈$ + price impact, folded into one tight block. */}
                {((exferUsd != null && estOutNet != null) || priceImpact > 0) && (
                  <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2.5">
                    {exferUsd != null && estOutNet != null && (
                      <div className="flex items-baseline justify-between text-xs">
                        <span className="text-neutral-600">{t("swap.usdValue")}</span>
                        <span className="font-mono tabular-nums text-neutral-500">
                          ≈ {usdNumber((sell ? Number(amount) : estOutNet) * exferUsd)}
                        </span>
                      </div>
                    )}
                    {priceImpact > 0 && (
                      <div className="flex items-baseline justify-between text-xs">
                        <span className="text-neutral-600">{t("swap.priceImpact")}</span>
                        <span
                          className={
                            "font-mono tabular-nums " +
                            (highImpact ? "text-amber-300" : "text-neutral-500")
                          }
                        >
                          {(priceImpact * 100).toFixed(2)}%
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* From / receive-to address — moved below the pair, as mobile
                    shows the FROM ADDRESS under the pay/receive cards. */}
                <div>
                  <label className="label">
                    {sell ? t("swap.swapFrom") : t("swap.receiveTo")}
                  </label>
                  {pickList.length === 0 ? (
                    // Boxed neutral notice occupying the picker's footprint, so
                    // the empty state isn't bare text dangling under the label.
                    <div className="mt-1.5 rounded-lg border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 text-sm text-neutral-400">
                      {sell ? t("swap.noFundedAddr") : t("swap.noAddrGenerate")}
                    </div>
                  ) : (
                    <AddrPicker
                      items={pickList}
                      value={fromAddr}
                      onChange={setFrom}
                      disabled={busy}
                    />
                  )}
                </div>

                {err && <div className="banner-error">{err}</div>}

                <button
                  type="button"
                  className="btn w-full"
                  disabled={busy || engineOn === null || !amountValid || !fromAddr || belowMin}
                  onClick={getQuote}
                >
                  {busy
                    ? t("swap.gettingQuote")
                    : engineOn === null
                      ? t("act.pillChecking")
                      : t("swap.review")}
                </button>
              </div>
            )}

            {step === 2 && quote && (
              <>
                <ReviewCard
                  quote={quote}
                  sendUnit={sendUnit}
                  recvUnit={recvUnit}
                  sell={sell}
                  priceImpact={priceImpact}
                  highImpact={highImpact}
                  exferUsd={exferUsd}
                  bnbUsd={bnbUsd}
                  busy={busy}
                  err={err}
                  onBack={() => {
                    setStep(1);
                    setQuote(null);
                    setErr(null);
                  }}
                  onConfirm={confirm}
                />
                {showImpactConfirm && (
                  <ImpactConfirmModal
                    pct={priceImpact * 100}
                    onCancel={() => setShowImpactConfirm(false)}
                    onProceed={() => void doExecute()}
                  />
                )}
              </>
            )}

            {step === 3 && (
              <ProgressCard
                live={live}
                recvUnit={recvUnit}
                elapsed={elapsed}
                busy={busy}
                onRefund={manualRefund}
                onDone={reset}
              />
            )}

            {/* The full BNB account console (deposit / withdraw / export) lives
                on the Dashboard BNB tile → modal; the swap rail no longer
                carries a second always-on copy of it. The buy-with-no-BNB
                "Add BNB" lead (above) is the only BNB surface here. */}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A branded account picker — replaces the raw native <select> (which rendered
 *  as the OS dropdown, the cheapest-looking element on the page). Shows the
 *  selected account (name + short address + balance) and expands an inline
 *  list of the same. */
function AddrPicker({
  items,
  value,
  onChange,
  disabled,
}: {
  items: WalletEntry[];
  value: string;
  onChange: (a: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sel = items.find((a) => a.address === value) ?? items[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!sel) return null;
  const label = (e: WalletEntry) => getLabel(e.address);

  const Face = ({ e }: { e: WalletEntry }) => (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-neutral-100">
          {label(e) ?? shortAddress(e.address)}
        </span>
        {label(e) && (
          <code className="addr-xs block text-neutral-500">
            {shortAddress(e.address)}
          </code>
        )}
      </span>
      <span className="amount shrink-0 text-sm text-neutral-300">
        {formatBalanceCompact(e.balance)}
      </span>
    </>
  );

  return (
    <div ref={ref} className="relative mt-1.5">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          "input flex w-full items-center gap-3 text-left disabled:opacity-50 " +
          (open ? "border-cyan-400" : "hover:border-neutral-600")
        }
      >
        <Face e={sel} />
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={
            "shrink-0 text-neutral-500 transition-transform " +
            (open ? "rotate-180" : "")
          }
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 max-h-60 overflow-y-auto rounded-xl border border-neutral-700 bg-neutral-900 p-1 shadow-xl"
        >
          {items.map((e) => {
            const active = e.address === sel.address;
            return (
              <button
                key={e.address}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(e.address);
                  setOpen(false);
                }}
                className={
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition " +
                  (active ? "bg-neutral-800" : "hover:bg-neutral-800/60")
                }
              >
                <Face e={e} />
                <span className="flex w-4 shrink-0 justify-center">
                  {active && (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.6}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-cyan-400"
                    >
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Single compact page bar: title left; live EXFER/USD + 24h change + pool rate
 *  pulled right as muted mono metadata (the only place the price/rate render). */
function PageBar({ poolRate }: { poolRate: string | null }) {
  const { t } = useT();
  // The live EXFER/USD price + 24h change now headline the chart card (big and
  // unmissable), so the page bar carries only the title and the muted pool rate
  // (EXFER↔BNB + fee) — the swap-specific metadata that has no other home.
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h1 className="text-xl font-semibold tracking-tight text-neutral-100">
        {t("swap.title")}
      </h1>
      {poolRate && (
        <div className="font-mono text-sm tabular-nums text-neutral-500">
          {poolRate}
        </div>
      )}
    </header>
  );
}

// ── Market header ──────────────────────────────────────────────────────────
// The exchange-style market surface above the swap form: live EXFER/USD + 24h
// change pill, an interval toggle, the candlestick chart, and a stats row
// (period high/low/avg + circulating supply & market cap). Ported from the
// mobile SwapTab market card. Everything degrades gracefully.

const INTERVALS: { key: string; label: string; timeVisible: boolean }[] = [
  { key: "5m", label: "5M", timeVisible: true },
  { key: "15m", label: "15M", timeVisible: true },
  { key: "1h", label: "1H", timeVisible: true },
  { key: "4h", label: "4H", timeVisible: true },
  { key: "1d", label: "1D", timeVisible: false },
  { key: "1w", label: "1W", timeVisible: false },
];

// Module-level caches so the chart + supply paint instantly on tab re-entry
// instead of popping in after their async fetches (mirrors mobile's caches).
const candlesCache: Record<string, Candle[]> = {};
let supplyCache: number | null = null;

/** A compact 24h-change pill — green up / red down / muted flat. */
function ChangePill({ pct }: { pct: number }) {
  const up = pct > 0.05;
  const down = pct < -0.05;
  const tone = up
    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
    : down
      ? "border-red-500/25 bg-red-500/10 text-red-300"
      : "border-neutral-700 bg-neutral-800/40 text-neutral-400";
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs font-semibold tabular-nums " +
        tone
      }
    >
      {up ? "▲" : down ? "▼" : "•"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/** One market-stat cell: a small muted label over a tabular value. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium text-neutral-500">{label}</span>
      <span className="font-mono text-sm font-semibold tabular-nums text-neutral-200">
        {value}
      </span>
    </div>
  );
}

function MarketHeader({ price }: { price: MarketPrice | null }) {
  const { t } = useT();
  const [interval, setIntervalKey] = useState("1d");
  const [candles, setCandles] = useState<Candle[]>(candlesCache["1d"] ?? []);
  const [loadingChart, setLoadingChart] = useState(false);
  const [supply, setSupply] = useState<number | null>(supplyCache);
  // The bar under the crosshair — when set, the price cells show THAT bar's
  // high/low/close instead of the whole-period stats (TradingView-style legend).
  const [hovered, setHovered] = useState<Candle | null>(null);

  // Circulating supply from the tip height (no supply RPC). Fetched once —
  // it barely moves (1 EXFER / 10s on ~69M). Failure just leaves mcap hidden.
  useEffect(() => {
    let cancelled = false;
    void getBlockHeight().then((h) => {
      if (cancelled || h == null) return;
      const s = circulatingSupplyExfer(h);
      supplyCache = s;
      setSupply(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Candles for the chosen interval (cached per interval, so switching back is
  // instant). An empty fetch keeps whatever we already had cached.
  useEffect(() => {
    let cancelled = false;
    if (!candlesCache[interval]) setLoadingChart(true);
    void getKlines(interval, 120).then((c) => {
      if (cancelled) return;
      if (c.length) candlesCache[interval] = c;
      setCandles(c.length ? c : (candlesCache[interval] ?? []));
      setLoadingChart(false);
    });
    return () => {
      cancelled = true;
    };
  }, [interval]);

  const exferUsd = price?.usd ?? null;
  const fp = (n: number) =>
    n >= 1
      ? n.toFixed(2)
      : n.toLocaleString("en-US", {
          maximumSignificantDigits: 4,
          useGrouping: false,
        });
  // Period high / low / average over the loaded candles (USD).
  const stats = useMemo(() => {
    if (!candles.length) return null;
    let hi = -Infinity;
    let lo = Infinity;
    let sum = 0;
    for (const c of candles) {
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
      sum += c.close;
    }
    return { hi, lo, avg: sum / candles.length };
  }, [candles]);

  const marketCap =
    supply != null && exferUsd != null ? supply * exferUsd : null;
  const compact = (n: number) =>
    n >= 1e9
      ? (n / 1e9).toFixed(2) + "B"
      : n >= 1e6
        ? (n / 1e6).toFixed(2) + "M"
        : n >= 1e3
          ? (n / 1e3).toFixed(1) + "K"
          : n.toFixed(0);

  const activeIv = INTERVALS.find((i) => i.key === interval);

  return (
    <div className="card-padded space-y-3">
      {/* Headline price — big and FIRST so the swap price is unmissable. The
          interval toggle rides the right of the same row. Hovering a candle
          swaps the headline to that bar's close (TradingView-style), else it's
          the live EXFER/USD. */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            EXFER · USD
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-semibold tabular-nums text-neutral-50">
              {hovered ? `$${fp(hovered.close)}` : exferUsd != null ? `$${fp(exferUsd)}` : "—"}
            </span>
            {!hovered && price && <ChangePill pct={price.change24h} />}
          </div>
        </div>
        <div
          className="flex gap-1 overflow-x-auto"
          style={{ scrollbarWidth: "none" }}
        >
          {INTERVALS.map((iv) => {
            const active = iv.key === interval;
            return (
              <button
                key={iv.key}
                type="button"
                onClick={() => {
                  setIntervalKey(iv.key);
                  setHovered(null);
                }}
                className={
                  "shrink-0 rounded-md px-3 py-1 text-xs font-semibold transition " +
                  (active
                    ? "bg-neutral-800 text-cyan-300"
                    : "text-neutral-500 hover:text-neutral-300")
                }
              >
                {iv.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Chart with empty / loading states — taller to use reclaimed space.
          Reset the crosshair-hover on mouse-leave too: the lightweight-charts
          crosshair doesn't always fire an empty event when the cursor exits
          sideways or on wheel-scroll, which would otherwise leave the big
          headline price stuck on a stale hovered bar instead of the live price. */}
      <div className="min-h-[280px]" onMouseLeave={() => setHovered(null)}>
        {candles.length > 0 ? (
          <PriceChart
            candles={candles}
            height={280}
            timeVisible={activeIv?.timeVisible ?? true}
            onHover={setHovered}
          />
        ) : (
          <div className="flex h-[280px] items-center justify-center text-sm text-neutral-500">
            {loadingChart ? <Spinner size={20} /> : t("swapTab.noChart")}
          </div>
        )}
      </div>

      {/* Market stats: period high/low/avg + market cap & circulating supply. */}
      {(stats || supply != null) && (
        <div className="grid grid-cols-3 gap-x-2 gap-y-3 border-t border-neutral-800 pt-3">
          {stats && (
            <Stat
              label={hovered ? t("swapTab.barHigh") : t("swapTab.high")}
              value={`$${fp(hovered ? hovered.high : stats.hi)}`}
            />
          )}
          {stats && (
            <Stat
              label={hovered ? t("swapTab.barLow") : t("swapTab.low")}
              value={`$${fp(hovered ? hovered.low : stats.lo)}`}
            />
          )}
          {stats && (
            <Stat
              label={hovered ? t("swapTab.barClose") : t("swapTab.avg")}
              value={`$${fp(hovered ? hovered.close : stats.avg)}`}
            />
          )}
          <Stat
            label={t("swapTab.mcap")}
            value={marketCap != null ? `$${compact(marketCap)}` : "—"}
          />
          <Stat
            label={t("swapTab.supply")}
            value={supply != null ? compact(supply) : "—"}
          />
        </div>
      )}
    </div>
  );
}

/** A non-interactive token chip (icon + symbol) used in the pay / receive
 *  cards. EXFER and BNB are tokens here, never verbs — the direction is owned
 *  by the ⇅ reverse button, not by which word you tap. */
function TokenChip({ unit }: { unit: "EXFER" | "BNB" }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm font-semibold text-neutral-100">
      {unit === "EXFER" ? <ExferMark size={20} /> : <BnbMark size={20} />}
      {unit}
    </span>
  );
}

/** The BNB rhombus on its gold disc — a small inline SVG so the chip carries
 *  the right brand mark without an extra asset. */
function BnbMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 126.61 126.61"
      className="block shrink-0"
      aria-hidden
    >
      <circle cx="63.3" cy="63.3" r="63.3" fill="#F0B90B" />
      <g fill="#fff" transform="translate(63.3 63.3) scale(0.62) translate(-63.3 -63.3)">
        <path d="M38.73 53.2 63.32 28.62 87.92 53.22 102.22 38.91 63.32 0 24.42 38.9z" />
        <path d="M0 63.31 14.3 49l14.31 14.31L14.3 77.61z" />
        <path d="M38.73 73.41 63.32 98l24.6-24.6 14.31 14.29-.01.01-38.9 38.91-38.91-38.88-.02-.02z" />
        <path d="M98 63.31 112.3 49l14.31 14.3-14.31 14.32z" />
        <path d="M77.83 63.3 63.32 48.78 52.59 59.51l-1.24 1.23-2.54 2.54-.02.02.02.03 14.51 14.5z" />
      </g>
    </svg>
  );
}

/** 25/50/75/Max quick-fill chips. `max` is the spendable ceiling in the pay
 *  unit; each chip sets the amount to that fraction (Max = the whole ceiling). */
function PercentChips({
  max,
  onPick,
}: {
  max: number;
  onPick: (v: number) => void;
}) {
  const { t } = useT();
  if (!(max > 0) || !isFinite(max)) return null;
  const fracs: [number, string][] = [
    [0.25, "25"],
    [0.5, "50"],
    [0.75, "75"],
  ];
  return (
    <div className="mt-2.5 flex gap-1.5">
      {fracs.map(([f, lbl]) => (
        <button
          key={lbl}
          type="button"
          className="flex-1 rounded-md bg-neutral-800/60 py-1 text-xs font-semibold text-cyan-300 transition hover:bg-neutral-800"
          onClick={() => onPick(max * f)}
        >
          {lbl}%
        </button>
      ))}
      <button
        type="button"
        className="flex-1 rounded-md bg-neutral-800/60 py-1 text-xs font-semibold text-cyan-300 transition hover:bg-neutral-800"
        onClick={() => onPick(max)}
      >
        {t("swap.maxLabel")}
      </button>
    </div>
  );
}

function ReviewCard({
  quote,
  sendUnit,
  recvUnit,
  sell,
  priceImpact,
  highImpact,
  exferUsd,
  bnbUsd,
  busy,
  err,
  onBack,
  onConfirm,
}: {
  quote: SwapRec;
  sendUnit: string;
  recvUnit: string;
  sell: boolean;
  priceImpact: number;
  highImpact: boolean;
  exferUsd: number | null;
  bnbUsd: number | null;
  busy: boolean;
  err: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  const rate =
    Number(quote.amount_in) > 0
      ? Number(quote.amount_out) / Number(quote.amount_in)
      : 0;
  // ≈$ of the EXFER leg: sell sends EXFER (amount_in), buy receives it (amount_out).
  const exferAmt = sell ? Number(quote.amount_in) : Number(quote.amount_out);
  const usd = exferUsd != null && isFinite(exferAmt) ? exferAmt * exferUsd : null;
  // Rate + impact folded onto one line; fee + BNB account onto another.
  const rateImpact =
    `1 ${sendUnit} ≈ ${fmtAmt(String(rate), 8)} ${recvUnit}` +
    (priceImpact > 0 ? ` · ${(priceImpact * 100).toFixed(2)}%` : "");
  const feeAcct =
    quote.fee_bps != null
      ? `${(quote.fee_bps / 100).toFixed(2)}%` +
        (quote.our_bsc_address
          ? ` · ${shortAddress(quote.our_bsc_address, 6, 4)}`
          : "")
      : quote.our_bsc_address
        ? shortAddress(quote.our_bsc_address, 6, 4)
        : null;
  // Settlement-gas fee the pool deducts from the output (already reflected in
  // amount_out). Disclose it — BNB + ≈USD — so the locked receive amount is
  // accounted for. Falls back to the pool default if the field is ever absent.
  const netFeeBnb =
    quote.network_fee_bnb && Number(quote.network_fee_bnb) > 0
      ? Number(quote.network_fee_bnb)
      : NET_FEE_BNB_FALLBACK;
  const netFeeUsd = bnbUsd != null ? netFeeBnb * bnbUsd : null;
  const netFeeValue =
    `${fmtAmt(String(netFeeBnb), 8)} BNB` +
    (netFeeUsd != null ? ` (≈ ${usdNumber(netFeeUsd)})` : "");
  return (
    <div className="card p-5 space-y-3.5">
      <h2 className="text-sm font-semibold text-neutral-300">
        {t("swap.reviewTitle")}
      </h2>

      <div className="space-y-3">
        <Row label={t("swap.youSend")} value={`${fmtAmt(quote.amount_in, 8)} ${sendUnit}`} />
        {/* Receive is the primary number; the HTLC locks amount_out exactly, so
            it's also the minimum received — flagged as "(locked)", not a row. */}
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-neutral-400">
            {t("swap.youReceive")}{" "}
            <span className="text-neutral-600" title={t("swap.minReceived")}>
              · {t("swap.lockedTag")}
            </span>
          </span>
          <span className="font-mono text-base font-semibold tabular-nums text-neutral-100">
            {fmtAmt(quote.amount_out, 8)} {recvUnit}
            {usd != null && (
              <span className="ml-2 text-xs font-normal text-neutral-500">
                ≈ {usdNumber(usd)}
              </span>
            )}
          </span>
        </div>
        {/* Rate + impact on one line (impact amber when high). */}
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-neutral-400">{t("swap.rate")}</span>
          <span
            className={
              "font-mono text-sm tabular-nums " +
              (highImpact ? "text-amber-300" : "text-neutral-200")
            }
          >
            {rateImpact}
          </span>
        </div>
        {/* Fee + BNB account on one line. */}
        {feeAcct && <Row label={t("swap.poolFee")} value={feeAcct} mono />}
        {/* Settlement-gas fee disclosure — already deducted from amount_out. */}
        <Row label={t("swap.networkFee")} value={netFeeValue} mono />
      </div>

      {err && <div className="banner-error">{err}</div>}

      <div className="flex gap-3">
        <button type="button" className="btn-secondary flex-1" disabled={busy} onClick={onBack}>
          {t("swap.back")}
        </button>
        <button type="button" className="btn flex-1" disabled={busy} onClick={onConfirm}>
          {busy ? t("swap.confirming") : t("swap.confirmSwap")}
        </button>
      </div>
    </div>
  );
}

function ProgressCard({
  live,
  recvUnit,
  elapsed,
  busy,
  onRefund,
  onDone,
}: {
  live: SwapRec | null;
  recvUnit: string;
  elapsed: number;
  busy: boolean;
  onRefund: () => void;
  onDone: () => void;
}) {
  const { t } = useT();
  const status = live?.status ?? "user_locked";
  const rank = STATUS_RANK[status] ?? 1;
  const terminal = ["completed", "refunded", "failed"].includes(status);

  // A "quoted" swap was never confirmed — no funds moved. Be honest instead of
  // rendering the locked-step checklist (which would imply funds are locked).
  if (status === "quoted") {
    const inUnit = live?.direction === "exfer_to_bnb" ? "EXFER" : "BNB";
    const outUnit = live?.direction === "exfer_to_bnb" ? "BNB" : "EXFER";
    const amounts = live
      ? `${fmtAmt(live.amount_in, 8)} ${inUnit} → ${fmtAmt(live.amount_out, 8)} ${outUnit}`
      : "";
    return (
      <div className="card p-5 space-y-3.5">
        <h2 className="text-sm font-semibold text-neutral-300">
          {t("swap.notConfirmedTitle")}
        </h2>
        {amounts && (
          <div className="font-mono text-sm tabular-nums text-neutral-200">
            {amounts}
          </div>
        )}
        <Banner
          kind="info"
          title={t("swap.notConfirmedTitle")}
          body={t("swap.notConfirmedResumeBody")}
        />
        <button type="button" className="btn w-full" onClick={onDone}>
          {t("swap.done")}
        </button>
      </div>
    );
  }

  const nodes = [
    { key: "locked", label: t("swap.stepLocked"), at: 1 },
    { key: "matched", label: t("swap.stepMatched"), at: 2 },
    { key: "settling", label: t("swap.stepSettling"), at: 3 },
  ];

  return (
    <div className="card p-5 space-y-3.5">
      <h2 className="text-sm font-semibold text-neutral-300">
        {t("swap.inProgressTitle")}
      </h2>

      {status === "completed" ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center pop">
          <SuccessMark size={64} />
          <div className="text-sm font-semibold text-emerald-200">
            {t("swap.completeTitle")}
          </div>
          <div className="text-xs leading-relaxed text-neutral-400">
            {t("swap.completeBody", { amt: fmtAmt(live?.amount_out, 8), unit: recvUnit })}
          </div>
        </div>
      ) : status === "refunded" ? (
        <Banner kind="info" title={t("swap.refundedTitle")} body={t("swap.refundedBody")} />
      ) : status === "failed" ? (
        <Banner kind="error" title={t("swap.failedTitle")} body={live?.error ?? t("swap.failedBody")} />
      ) : status === "refunding" ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-amber-200">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Spinner /> {t("swap.refundingTitle")}
          </div>
          <div className="mt-0.5 text-xs opacity-90">{t("swap.statusRefunding")}</div>
        </div>
      ) : (
        // Staged stepper: chevrons flow into the active (spinner) node. `rank`
        // is 1-based (user_locked=1 …), so the active node index is rank − 1.
        <div className="py-1">
          <StagedStepper
            labels={nodes.map((n) => n.label)}
            doneCount={Math.max(0, rank - 1)}
          />
        </div>
      )}

      {!terminal && status !== "refunding" && elapsed > 20 && (
        <p className="text-xs text-neutral-500">
          {t("swap.settlingHint")}
        </p>
      )}

      {terminal ? (
        <button type="button" className="btn w-full" onClick={onDone}>
          {t("swap.done")}
        </button>
      ) : (
        // Manual refund is only meaningful while the user's leg is still locked
        // (user_locked / pool_locked) and after a long wait.
        ["user_locked", "pool_locked"].includes(status) &&
        elapsed > 90 && (
          <button
            type="button"
            className="btn-secondary w-full"
            disabled={busy}
            onClick={onRefund}
          >
            {busy ? t("swap.requestingRefund") : t("swap.takingTooLong")}
          </button>
        )
      )}
    </div>
  );
}

/** High price-impact confirmation — mobile WARNS but permits, so this is a soft
 *  gate, not a hard block. */
function ImpactConfirmModal({
  pct,
  onCancel,
  onProceed,
}: {
  pct: number;
  onCancel: () => void;
  onProceed: () => void;
}) {
  const { t } = useT();
  useEscapeKey(onCancel);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-6 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="card-padded w-full max-w-md space-y-5">
        <header>
          <h2 className="text-xl font-semibold text-neutral-100">{t("swap.impactConfirmTitle")}</h2>
        </header>
        <p className="text-sm leading-relaxed text-neutral-300">
          {t("swap.impactConfirmBody", { pct: pct.toFixed(1) })}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t("swap.back")}
          </button>
          <button type="button" className="btn-danger" onClick={onProceed}>
            {t("swap.impactConfirmCta")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  mono,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-neutral-400">{label}</span>
      <span
        className={
          (mono ? "font-mono text-xs " : "font-mono ") +
          "tabular-nums " +
          (strong ? "text-base font-semibold text-neutral-100" : "text-sm text-neutral-200")
        }
      >
        {value}
      </span>
    </div>
  );
}

function Banner({
  kind,
  title,
  body,
}: {
  kind: "success" | "info" | "error";
  title: string;
  body: string;
}) {
  const tone =
    kind === "success"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
      : kind === "error"
        ? "border-red-500/25 bg-red-500/10 text-red-200"
        : "border-cyan-500/25 bg-cyan-500/10 text-cyan-200";
  return (
    <div className={"rounded-lg border px-4 py-3 " + tone}>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-0.5 text-xs opacity-90">{body}</div>
    </div>
  );
}
