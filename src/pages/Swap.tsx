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

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { rpc, formatExfer, formatBalanceCompact, revealEvmPrivateKey } from "../lib/rpc";
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
import { usePrice, useBnbUsd, usdNumber } from "../lib/market";
import { recordSwapUsd } from "../lib/swapPrice";
import { CopyButton } from "../components/CopyButton";

// Permissive decimal: BNB carries up to 18 fractional digits, EXFER up to 8.
const AMOUNT_RE = /^\d*\.?\d*$/;
const HEX40 = /^0x[0-9a-fA-F]{40}$/;

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

/** Format a smallest-unit integer string (e.g. wei) to a short human amount. */
function fmtUnits(raw: string | undefined, decimals: number, frac = 4): string {
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

/** Small QR that renders an address to a data URL (same palette as Receive). */
function MiniQr({ value, size = 160 }: { value: string; size?: number }) {
  const { t } = useT();
  const [src, setSrc] = useState("");
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: size,
      color: { dark: "#171717", light: "#ffffff" },
    })
      .then((d) => alive && setSrc(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [value, size]);
  return src ? (
    <img
      src={src}
      width={size}
      height={size}
      alt="BSC address QR"
      className="rounded-lg border border-neutral-800"
    />
  ) : (
    <div
      style={{ width: size, height: size }}
      className="flex items-center justify-center rounded-lg bg-neutral-800 text-xs text-neutral-500"
    >
      {t("swap.qrRendering")}
    </div>
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

  // Reserve the per-IP scan-rate budget while swapping, exactly like Send.
  useEffect(() => suspendPolling(), [suspendPolling]);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [direction, setDirection] = useState<SwapDirection>("exfer_to_bnb");
  const [from, setFrom] = useState("");
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<SwapRec | null>(null);
  const [live, setLive] = useState<SwapRec | null>(null);
  const [poolInfo, setPoolInfo] = useState<PoolInfo | null>(null);
  // Gate: a high-impact trade must be explicitly confirmed before execute.
  const [showImpactConfirm, setShowImpactConfirm] = useState(false);
  // null = unknown yet; false = engine confirmed off (pool_info threw).
  const [engineOn, setEngineOn] = useState<boolean | null>(null);

  // The wallet's BSC balance (wei) — drives the buy-side deposit lead, the
  // buyMax button, and the "Waiting for your BNB…" spinner. Polled on step 1.
  const [bnbWei, setBnbWei] = useState<string | null>(null);

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

  // Poll the wallet's BNB balance on the build step so the buy-side deposit
  // lead, buyMax, and "waiting for BNB" spinner stay live — and announce a fresh
  // deposit with a toast so it's never silent. (BnbAccount polls its own copy;
  // this drives the swap form.)
  const lastBnbRef = useRef<bigint | null>(null);
  useEffect(() => {
    if (step !== 1) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const b = await rpc<{ bnb_wei: string }>("bsc_get_balances");
        if (cancelled) return;
        setBnbWei(b.bnb_wei);
        const now = BigInt(b.bnb_wei);
        const prev = lastBnbRef.current;
        if (prev != null && now > prev) {
          const delta = fmtUnits((now - prev).toString(), 18, 5);
          toast.incoming(`+${delta} BNB`, t("swap.bnbReceived"));
        }
        lastBnbRef.current = now;
      } catch {
        /* engine off / no HD seed — form just hides the BNB bits */
      }
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [step, toast, t]);

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
  // Buy with no BNB yet: lead with the deposit card and de-emphasize the amount
  // field so the order of operations reads top-to-bottom (1. Add BNB → 2. Enter).
  const needsFunding = !sell && bnbZero;

  // Sell Max = the funded address's spendable EXFER. Buy Max = all spendable
  // BNB, less a small gas reserve (BNB is also the gas token), capped at the
  // pool's per-swap size cap.
  const sendBal = pickList.find((e) => e.address === fromAddr)?.balance ?? 0;
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
    setErr(null);
  }

  function switchDirection(d: SwapDirection) {
    if (d === direction) return;
    setDirection(d);
    setFrom("");
    setAmount("");
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
        amount_in: amount.trim(),
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
    const id = quote?.swap_id;
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

  // Poll status while the swap is in progress.
  const watchId = quote?.swap_id;
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

  if (engineOn === false) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
        <Header />
        <div className="card-padded text-sm text-neutral-400">
          {t("swap.unavailablePre")}
          <span className="text-neutral-200">{t("swap.unavailableSettings")}</span>
          {t("swap.unavailablePost")}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
      <Header />

      {step === 1 && (
        <>
          {/* Buy with no BNB yet: lead with the deposit card so the order of
              operations reads top-to-bottom (1. Add BNB → 2. Enter amount). */}
          {needsFunding && <BnbAccount lead waiting />}

          <div className="card-padded space-y-6">
            <DirectionToggle direction={direction} onChange={switchDirection} />

            {poolInfo && poolInfo.mid > 0 && (
              <div className="flex items-baseline justify-between rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-2.5 text-sm">
                <span className="text-neutral-400">{t("swap.poolRate")}</span>
                <span className="font-mono tabular-nums text-neutral-200">
                  {t("swap.poolRateValue", { rate: fmtAmt(String(poolInfo.mid), 8) })}
                  <span className="ml-2 text-neutral-500">
                    {t("swap.poolFeeShort", { pct: (poolInfo.feeBps / 100).toFixed(2) })}
                  </span>
                </span>
              </div>
            )}

            {/* From / receive-to address */}
            <div>
              <label className="label">{sell ? t("swap.swapFrom") : t("swap.receiveTo")}</label>
              {pickList.length === 0 ? (
                <p className="help">
                  {sell
                    ? t("swap.noFundedAddr")
                    : t("swap.noAddrGenerate")}
                </p>
              ) : (
                <div className="space-y-2" role="radiogroup" aria-label={t("swap.addressGroupLabel")}>
                  {pickList.map((e) => {
                    const label = getLabel(e.address);
                    const name =
                      label ??
                      (e.imported
                        ? t("swap.imported")
                        : t("swap.addressN", { n: e.index ?? "" }));
                    const selected = fromAddr === e.address;
                    return (
                      <button
                        key={e.address}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setFrom(e.address)}
                        disabled={busy}
                        className={
                          "flex w-full items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-left transition disabled:opacity-50 " +
                          (selected
                            ? "border-cyan-400 bg-cyan-500/10"
                            : "border-neutral-700 bg-neutral-950 hover:border-neutral-600")
                        }
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-neutral-100">
                            {name}
                          </div>
                          <code className="addr-xs text-neutral-500">
                            {shortAddress(e.address)}
                          </code>
                        </div>
                        <span
                          className="font-mono text-sm font-medium tabular-nums text-neutral-100"
                          title={formatExfer(e.balance)}
                        >
                          {formatBalanceCompact(e.balance)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Amount — de-emphasized until there's BNB to swap on the buy side. */}
            <div className={needsFunding ? "opacity-50" : ""}>
              <div className="flex items-center justify-between">
                <label className="label mb-0">
                  {needsFunding ? t("swap.amountStep") : t("swap.youSendUnit", { unit: sendUnit })}
                </label>
                {sell && sendBal > 0 && (
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() => setAmount(formatExfer(sendBal).replace(" EXFER", ""))}
                    disabled={busy}
                  >
                    {t("swap.maxLabel")}
                  </button>
                )}
                {!sell && buyMax > 0 && (
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() => setAmount(fmtAmt(String(buyMax), 8))}
                    disabled={busy}
                  >
                    {t("swap.maxLabel")}
                  </button>
                )}
              </div>
              <input
                className="input mt-1.5"
                placeholder="0.0"
                value={amount}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "" || AMOUNT_RE.test(v)) setAmount(v);
                }}
                disabled={busy}
                inputMode="decimal"
              />
              <div className="mt-2 flex items-baseline justify-between text-sm">
                <span className="text-neutral-500">{t("swap.youReceiveEst")}</span>
                <span className="font-mono tabular-nums text-neutral-200">
                  {estOut != null ? `≈ ${fmtAmt(String(estOut), 6)} ${recvUnit}` : `— ${recvUnit}`}
                </span>
              </div>
              {/* ≈$ value of the EXFER side (sell sends EXFER, buy receives it). */}
              {exferUsd != null && estOut != null && (
                <div className="mt-1 flex items-baseline justify-between text-xs">
                  <span className="text-neutral-600">{t("swap.usdValue")}</span>
                  <span className="font-mono tabular-nums text-neutral-500">
                    ≈ {usdNumber((sell ? Number(amount) : estOut) * exferUsd)}
                  </span>
                </div>
              )}
              {/* Price impact — warn (amber) when it's high, but never block. */}
              {priceImpact > 0 && (
                <div className="mt-1 flex items-baseline justify-between text-xs">
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

            {err && <div className="banner-error">{err}</div>}

            <button
              type="button"
              className="btn w-full text-base"
              disabled={busy || !amountValid || !fromAddr}
              onClick={getQuote}
            >
              {busy ? t("swap.gettingQuote") : t("swap.review")}
            </button>
          </div>

          {/* In-wallet BNB account — the buy-side deposit target + a place to
              read/withdraw BNB. When already shown as the funding lead above,
              don't render it twice. */}
          {!needsFunding && <BnbAccount lead={!sell} />}
        </>
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
    </div>
  );
}

function Header() {
  const { t } = useT();
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
        {t("swap.title")}
      </h1>
      <p className="text-base text-neutral-400">
        {t("swap.headerDesc")}
      </p>
    </header>
  );
}

function DirectionToggle({
  direction,
  onChange,
}: {
  direction: SwapDirection;
  onChange: (d: SwapDirection) => void;
}) {
  const { t } = useT();
  const opts: { id: SwapDirection; label: string }[] = [
    { id: "exfer_to_bnb", label: t("swap.sellDirection") },
    { id: "bnb_to_exfer", label: t("swap.buyDirection") },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {opts.map((o) => {
        const active = o.id === direction;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={
              "rounded-lg border px-4 py-2.5 text-sm font-medium transition " +
              (active
                ? "border-cyan-400 bg-cyan-500/10 text-cyan-200"
                : "border-neutral-700 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200")
            }
          >
            {o.label}
          </button>
        );
      })}
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
  return (
    <div className="card-padded space-y-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
        {t("swap.reviewTitle")}
      </h2>

      <div className="space-y-3">
        <Row label={t("swap.youSend")} value={`${fmtAmt(quote.amount_in, 8)} ${sendUnit}`} />
        <Row label={t("swap.youReceive")} value={`${fmtAmt(quote.amount_out, 8)} ${recvUnit}`} strong />
        {usd != null && <Row label={t("swap.usdValue")} value={`≈ ${usdNumber(usd)}`} />}
        <Row
          label={t("swap.rate")}
          value={`1 ${sendUnit} ≈ ${fmtAmt(String(rate), 8)} ${recvUnit}`}
        />
        {priceImpact > 0 && (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-neutral-400">{t("swap.priceImpact")}</span>
            <span
              className={
                "font-mono text-sm tabular-nums " +
                (highImpact ? "text-amber-300" : "text-neutral-200")
              }
            >
              {(priceImpact * 100).toFixed(2)}%
            </span>
          </div>
        )}
        {quote.fee_bps != null && (
          <Row label={t("swap.poolFee")} value={`${(quote.fee_bps / 100).toFixed(2)}%`} />
        )}
        {quote.our_bsc_address && (
          <Row label={t("swap.bnbAccount")} value={shortAddress(quote.our_bsc_address, 10, 8)} mono />
        )}
      </div>

      <p className="text-xs text-neutral-500">
        {t("swap.htlcExplain")}
      </p>

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
  const nodes = [
    { key: "locked", label: t("swap.stepLocked"), at: 1 },
    { key: "matched", label: t("swap.stepMatched"), at: 2 },
    { key: "settling", label: t("swap.stepSettling"), at: 3 },
  ];

  return (
    <div className="card-padded space-y-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
        {t("swap.inProgressTitle")}
      </h2>

      {status === "completed" ? (
        <Banner kind="success" title={t("swap.completeTitle")} body={t("swap.completeBody", { amt: fmtAmt(live?.amount_out, 8), unit: recvUnit })} />
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
        <ol className="space-y-3">
          {nodes.map((n) => {
            // In this branch status is non-terminal (the ternary above peeled
            // off completed/refunded/failed), so progress is purely rank-based.
            const done = rank >= n.at + 1;
            const current = rank === n.at;
            return (
              <li key={n.key} className="flex items-center gap-3">
                <span
                  className={
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold " +
                    (done
                      ? "bg-emerald-500/15 text-emerald-300"
                      : current
                        ? "bg-cyan-500/15 text-cyan-300"
                        : "bg-neutral-800 text-neutral-500")
                  }
                >
                  {done ? "✓" : current ? "…" : ""}
                </span>
                <span className={done || current ? "text-neutral-100" : "text-neutral-500"}>
                  {n.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {!terminal && status !== "refunding" && elapsed > 20 && (
        <p className="text-xs text-neutral-500">
          {t("swap.takingLonger")}
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

/** In-wallet BNB account on BSC: address (QR + copy), live balance, withdraw.
 *  This is the "manage your BSC address" surface — funds the buy direction.
 *  `waiting` shows a "Waiting for your BNB…" spinner when leading the buy flow
 *  with a zero balance. */
function BnbAccount({ lead, waiting = false }: { lead: boolean; waiting?: boolean }) {
  const toast = useToast();
  const { t } = useT();
  const bnbUsd = useBnbUsd();
  const [addr, setAddr] = useState<string | null>(null);
  const [bnbWei, setBnbWei] = useState<string | null>(null);
  const [open, setOpen] = useState(lead);
  const [withdrawing, setWithdrawing] = useState(false);
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [wErr, setWErr] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const lastWei = useRef<bigint | null>(null);

  // Human BNB balance + its ≈$ value (best-effort; hidden when BNB/USD absent).
  const bnbHuman = (() => {
    if (!bnbWei) return 0;
    try {
      return Number(BigInt(bnbWei)) / 1e18;
    } catch {
      return 0;
    }
  })();
  const bnbUsdValue = bnbUsd != null && bnbHuman > 0 ? bnbHuman * bnbUsd : null;
  const isZero = bnbWei != null && bnbHuman === 0;

  const load = useCallback(async () => {
    try {
      const a = await rpc<{ address: string }>("bsc_get_address");
      setAddr(a.address);
      const b = await rpc<{ bnb_wei: string }>("bsc_get_balances");
      setBnbWei(b.bnb_wei);
      const now = BigInt(b.bnb_wei);
      const prev = lastWei.current;
      if (prev != null && now > prev) {
        const delta = fmtUnits((now - prev).toString(), 18, 5);
        toast.incoming(`+${delta} BNB`, t("swap.depositReceived"));
      }
      lastWei.current = now;
    } catch {
      /* engine off / no HD seed — section stays hidden */
    }
  }, [toast, t]);

  // Poll the balance so a fresh deposit is never silent.
  useEffect(() => {
    load();
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [load]);

  async function withdraw() {
    setWErr(null);
    if (!HEX40.test(to.trim())) {
      setWErr(t("swap.errBscAddress"));
      return;
    }
    if (!(Number(amt) > 0) && amt.trim().toLowerCase() !== "max") {
      setWErr(t("swap.errEnterAmountMax"));
      return;
    }
    setWithdrawing(true);
    try {
      const r = await rpc<{ txhash: string }>("bsc_send_bnb", {
        to: to.trim(),
        amount: amt.trim(),
      });
      toast.success(t("swap.toastBnbSentTitle"), t("swap.toastBnbSentBody", { tx: shortAddress(r.txhash, 10, 8) }));
      setTo("");
      setAmt("");
      load();
    } catch (e) {
      setWErr(humanizeError(e));
    } finally {
      setWithdrawing(false);
    }
  }

  // Nothing to show until walletd hands us a derived address.
  if (!addr) return null;

  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-5 py-3 text-left"
      >
        <div>
          <div className="text-sm font-semibold text-neutral-100">{t("swap.bnbAccountTitle")}</div>
          <div className="text-xs text-neutral-500">
            {t("swap.bnbAccountSubtitle")}
          </div>
        </div>
        <span className="text-right">
          <span className="block font-mono text-sm tabular-nums text-neutral-200">
            {fmtUnits(bnbWei ?? undefined, 18, 5)} BNB
          </span>
          {bnbUsdValue != null && (
            <span className="block font-mono text-xs tabular-nums text-neutral-500">
              ≈ {usdNumber(bnbUsdValue)}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-neutral-800 px-5 py-5">
          <div className="flex flex-col items-center gap-3">
            <MiniQr value={addr} size={160} />
            <div className="flex w-full items-start gap-2">
              <code className="addr flex-1 break-all rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-center text-xs">
                {addr}
              </code>
              <CopyButton text={addr} className="btn-secondary" />
            </div>
            <p className="text-xs text-neutral-500">
              {t("swap.depositHint")}
            </p>
            {waiting && isZero && (
              <div className="flex items-center gap-2 text-xs text-neutral-400">
                <Spinner size={13} /> {t("swap.waitingBnb")}
              </div>
            )}
          </div>

          {/* Withdraw */}
          <div className="space-y-2 border-t border-neutral-800 pt-4">
            <div className="flex items-baseline justify-between">
              <div className="label mb-0">{t("swap.withdrawBnb")}</div>
              <span className="font-mono text-xs tabular-nums text-neutral-500">
                {fmtUnits(bnbWei ?? undefined, 18, 5)} BNB
              </span>
            </div>
            <div className="grid grid-cols-[1.5fr_1fr] gap-2">
              <input
                className="input font-mono text-xs"
                placeholder={t("swap.withdrawToPlaceholder")}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                disabled={withdrawing}
                autoComplete="off"
              />
              <div className="relative">
                <input
                  className="input pr-12"
                  placeholder={t("swap.withdrawAmtPlaceholder")}
                  value={amt}
                  onChange={(e) => setAmt(e.target.value)}
                  disabled={withdrawing}
                  inputMode="decimal"
                />
                <button
                  type="button"
                  className="btn-ghost absolute right-1 top-1/2 -translate-y-1/2 text-xs"
                  onClick={() => setAmt("max")}
                  disabled={withdrawing}
                >
                  {t("swap.maxLabel")}
                </button>
              </div>
            </div>
            {/* Gas-reserve + irreversible-address warning. */}
            <div className="banner-info text-xs">{t("swap.withdrawNote")}</div>
            {wErr && <div className="banner-error">{wErr}</div>}
            <button
              type="button"
              className="btn-secondary w-full"
              disabled={withdrawing}
              onClick={withdraw}
            >
              {withdrawing ? t("swap.sending") : t("swap.withdraw")}
            </button>
          </div>

          {/* Export the BSC private key for MetaMask import. */}
          <div className="border-t border-neutral-800 pt-4">
            <button
              type="button"
              className="btn-ghost w-full text-neutral-400"
              onClick={() => setExportOpen(true)}
            >
              {t("swap.exportBnbKey")}
            </button>
          </div>
        </div>
      )}

      {exportOpen && <ExportBnbKeyModal onClose={() => setExportOpen(false)} />}
    </section>
  );
}

/* The BNB (BSC/EVM) private key — passphrase-gated — so the user can import
 * their BNB address into MetaMask-style wallets ("Import account → Private
 * key"). The key is derived at m/44'/60'/0'/0/0, the standard path, so the same
 * address appears in MetaMask. Shown once and never persisted. */
function ExportBnbKeyModal({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<{ address: string; key: string } | null>(null);

  async function reveal(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (pw.length < 4) {
      setErr(t("swap.expEnterPw"));
      return;
    }
    setBusy(true);
    try {
      const res = await revealEvmPrivateKey(pw);
      setData({ address: res.address, key: res.private_key_hex });
      setPw("");
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-6 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card-padded w-full max-w-xl space-y-5">
        <header>
          <h2 className="text-xl font-semibold text-neutral-100">{t("swap.exportBnbKey")}</h2>
          <p className="mt-1 text-sm text-neutral-400">{t("swap.expDesc")}</p>
        </header>

        {!data ? (
          <form onSubmit={reveal} className="space-y-4">
            <div className="banner-warn text-sm text-amber-200">{t("swap.expWarn")}</div>
            <div>
              <label className="label" htmlFor="export-bnb-pw">
                {t("swap.walletPassword")}
              </label>
              <input
                id="export-bnb-pw"
                type="password"
                className="input"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                disabled={busy}
                autoFocus
                autoComplete="current-password"
              />
            </div>
            {err && <div className="banner-error">{err}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
                {t("swap.back")}
              </button>
              <button type="submit" className="btn-danger" disabled={busy || pw === ""}>
                {busy ? t("swap.confirming") : t("swap.expReveal")}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="banner-error">{t("swap.expRevealed")}</div>
            <div>
              <div className="label">{t("swap.bnbAddressLabel")}</div>
              <code className="addr block break-all rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs">
                {data.address}
              </code>
            </div>
            <div>
              <div className="label">{t("swap.expPrivKey")}</div>
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 font-mono text-sm break-all text-red-200">
                {data.key}
              </div>
            </div>
            <div className="banner-info text-xs">{t("swap.expMetaMask")}</div>
            <div className="flex justify-end gap-2">
              <CopyButton text={data.key} className="btn-secondary" />
              <button type="button" className="btn" onClick={onClose}>
                {t("swap.done")}
              </button>
            </div>
          </div>
        )}
      </div>
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
