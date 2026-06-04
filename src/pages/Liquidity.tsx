// Liquidity (LP) — self-serve add / remove against the swap pool. Wired to the
// walletd LP proxy RPCs. Shares are an off-chain ledger (Exfer has no VM); the
// pool reports reserves and a per-share NAV, and we never touch wei — every
// LP RPC speaks human-decimal strings.
//
// Single desktop page with three sub-views, mirroring the mobile LiquiditySheet:
//   overview  — pool stats + your position (across every wallet address)
//   add       — pick a funded EXFER address, enter EXFER, BNB auto-matched,
//               lp_deposit_start → transfer EXFER + bsc_send_bnb → poll status
//   withdraw  — 25/50/75/100% → lp_withdraw_self
//
// Degrades gracefully: if lp_pool_info throws or genesis isn't done (engine off
// or an old walletd), the page shows a quiet "unavailable" notice — no crash.
//
// Real lp_* shapes observed against live walletd (NOT wei — human decimals):
//   lp_pool_info  → { genesis_done, lp_count, operator_share_pct, total_shares,
//                     reserves:{bnb,exfer}(decimal str), nav_per_share:{...} }
//   lp_position   → { has_position, shares, pool_share_pct, value_bnb, value_exfer }
//                   (or { has_position:false, shares:"0" } when empty)
//   lp_deposit_start → { ok, id, deposit_exfer_address, deposit_bsc_address,
//                        expires_at, reserves:{bnb_units,exfer_units} }
//   lp_deposit_status → { status } | { error:"deposit not found" }
//   lp_withdraw_self  → { withdrawal_id? } | { error:"no liquidity position…" }

import { useCallback, useEffect, useMemo, useState } from "react";
import { rpc, formatExfer, formatBalanceCompact, parseExferAmount } from "../lib/rpc";
import type { WalletEntry } from "../lib/types";
import { getLabel, shortAddress } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import { useWallet } from "../lib/wallet";
import { useToast } from "../lib/toast";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { usePrice, useBnbUsd, usdNumber } from "../lib/market";

const FEE_RATE = 1; // exfers/byte, matches Send
// The BNB leg is swept from a per-request address that pays its own BSC gas, so
// it must clear a safe gas floor (a few × the typical 21000-gas cost). Below
// this the pool would auto-refund the deposit, so we block it up front instead.
const MIN_BNB_LEG = 0.00001;

interface PoolInfo {
  genesis_done: boolean;
  lp_count: number;
  operator_share_pct: number;
  total_shares: string;
  reserves: { bnb: string; exfer: string };
  nav_per_share?: { bnbPerShare: number; exferPerShare: number };
}
interface Position {
  has_position: boolean;
  shares: string;
  pool_share_pct?: number;
  value_bnb?: string;
  value_exfer?: string;
}
type ResultKind = "added" | "refunded" | "removed" | "failed";
type Step = "overview" | "add" | "withdraw" | "progress" | "done";

const AMOUNT_RE = /^\d*\.?\d*$/;

/** Short human number with significant-digit fallback so tiny values don't
 *  collapse to "0". */
function sig(n: number, d = 6): string {
  if (!isFinite(n) || n === 0) return "0";
  return n.toLocaleString("en-US", { maximumSignificantDigits: d, useGrouping: false });
}

export function Liquidity() {
  const { balance, refresh, suspendPolling } = useWallet();
  const toast = useToast();
  const { t } = useT();
  const price = usePrice();
  const bnbUsd = useBnbUsd();

  // Reserve the per-IP scan-rate budget while the LP screen polls, like Swap/Send.
  useEffect(() => suspendPolling(), [suspendPolling]);

  const entries = useMemo<WalletEntry[]>(
    () => (balance?.entries ?? []).filter((e) => !isHidden(e.address)),
    [balance],
  );
  const funded = useMemo(() => entries.filter((e) => e.balance > 0), [entries]);
  const defaultAddr = funded[0]?.address ?? entries[0]?.address ?? "";

  // The EXFER address that funds the deposit AND owns the position — selectable
  // (a wallet can hold many), defaulting to the first funded address.
  const [fromAddr, setFromAddr] = useState("");
  const exferAddr = fromAddr || defaultAddr;
  const exferBal = entries.find((e) => e.address === exferAddr)?.balance ?? 0;

  const [step, setStep] = useState<Step>("overview");
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const [posLoaded, setPosLoaded] = useState(false);
  const [bscAddr, setBscAddr] = useState("");
  const [bnbWei, setBnbWei] = useState("0");
  const [unavailable, setUnavailable] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stage, setStage] = useState(0); // 0 send, 1 sweep, 2 credit
  const [withdrawPct, setWithdrawPct] = useState(100);
  const [result, setResult] = useState<{ kind: ResultKind; bnb?: string; exfer?: string } | null>(null);
  // Every address holding a position, scanned across the whole wallet — without
  // this, a position on a non-default address reads as "no liquidity".
  const [positions, setPositions] = useState<{ address: string; pos: Position }[]>([]);
  const [posScanned, setPosScanned] = useState(false);
  const [feeOpen, setFeeOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await rpc<PoolInfo>("lp_pool_info");
      if ((p as unknown as { error?: string })?.error || !p.genesis_done) {
        setUnavailable(true);
        return;
      }
      setPool(p);
      const [a, b] = await Promise.all([
        rpc<{ address: string }>("bsc_get_address").catch(() => ({ address: "" })),
        rpc<{ bnb_wei: string }>("bsc_get_balances").catch(() => ({ bnb_wei: "0" })),
      ]);
      setBscAddr(a.address);
      setBnbWei(b.bnb_wei);
      if (exferAddr) {
        const pp = await rpc<Position>("lp_position", { address: exferAddr.toLowerCase() }).catch(() => null);
        if (pp) setPos(pp);
        setPosLoaded(true);
      }
    } catch {
      setUnavailable(true);
    }
  }, [exferAddr]);

  useEffect(() => {
    void load();
  }, [load]);

  // Scan the whole wallet for positions once the pool is up. Polling is
  // suspended while this screen is open, so `entries` is stable.
  useEffect(() => {
    if (!pool) return;
    let cancelled = false;
    (async () => {
      const all = balance?.entries ?? [];
      const found = await Promise.all(
        all.map(async (e) => {
          const p = await rpc<Position>("lp_position", { address: e.address.toLowerCase() }).catch(() => null);
          return p?.has_position ? { address: e.address, pos: p } : null;
        }),
      );
      if (!cancelled) {
        setPositions(found.filter((x): x is { address: string; pos: Position } => x != null));
        setPosScanned(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool]);

  // Refresh the BNB balance when entering Add — a cold walletd can return 0 at
  // first load, which would wrongly read as "not enough BNB".
  useEffect(() => {
    if (step !== "add") return;
    rpc<{ bnb_wei: string }>("bsc_get_balances")
      .then((b) => {
        if (b?.bnb_wei) setBnbWei(b.bnb_wei);
      })
      .catch(() => {});
  }, [step]);

  // Guard the EXFER reserve: a transient 0 reserve makes bnb/0 = Infinity, which
  // poisons every downstream number into NaN. Treat it as "unknown ratio" and
  // fall back to the OTC spot price for USD figures.
  const exferReserve = pool ? Number(pool.reserves.exfer) : 0;
  const bnbReserve = pool ? Number(pool.reserves.bnb) : 0;
  const mid = pool && exferReserve > 0 ? bnbReserve / exferReserve : 0; // BNB per EXFER
  const bnbHuman = (() => {
    try {
      return Number(BigInt(bnbWei || "0")) / 1e18;
    } catch {
      return 0;
    }
  })();
  const amtNum = Number(amount);
  const amountValid = AMOUNT_RE.test(amount.trim()) && isFinite(amtNum) && amtNum > 0;
  const bnbNeeded = mid > 0 && isFinite(amtNum) ? amtNum * mid : 0;
  const exferUsd = mid > 0 && bnbUsd ? mid * bnbUsd : price?.usd ?? 0;
  const addUsd = amountValid ? amtNum * exferUsd * 2 : 0;
  const minExfer = mid > 0 ? MIN_BNB_LEG / mid : 0; // min EXFER so the BNB leg clears gas

  // exferBal is in exfers (1e8 smallest-units); amtNum is human EXFER.
  const enoughExfer = amountValid && parseExferAmountSafe(amount) <= exferBal;
  const enoughBnb = bnbNeeded <= bnbHuman;
  const belowMin = amountValid && minExfer > 0 && amtNum < minExfer;
  const canAdd = amountValid && enoughExfer && enoughBnb && !belowMin;

  function pollDeposit(id: string): Promise<"completed" | "expired"> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = async () => {
        try {
          const s = await rpc<{ status: string }>("lp_deposit_status", { id });
          if (s.status === "completed") {
            setStage(2);
            return resolve("completed");
          }
          if (s.status === "expired") return resolve("expired");
        } catch {
          /* transient */
        }
        if (Date.now() - t0 > 5 * 60_000) return reject(new Error(t("lp.timedOut")));
        window.setTimeout(tick, 4000);
      };
      tick();
    });
  }

  async function confirmAdd() {
    if (!pool || !canAdd) return;
    setBusy(true);
    setErr(null);
    setStage(0);
    setStep("progress");
    try {
      const intent = await rpc<{ id: string; deposit_exfer_address: string; deposit_bsc_address: string }>(
        "lp_deposit_start",
        { exfer_address: exferAddr, bsc_address: bscAddr },
      );
      await rpc("transfer", {
        from: exferAddr,
        outputs: [{ to: intent.deposit_exfer_address, amount: parseExferAmount(amount) }],
        fee_rate: FEE_RATE,
      });
      await rpc("bsc_send_bnb", { to: intent.deposit_bsc_address, amount: sig(bnbNeeded, 8) });
      setStage(1);
      const status = await pollDeposit(intent.id);
      await load();
      await refresh();
      if (status === "completed") {
        const pp = await rpc<Position>("lp_position", { address: exferAddr.toLowerCase() }).catch(() => null);
        setResult({ kind: "added", exfer: pp?.value_exfer, bnb: pp?.value_bnb });
        toast.success(t("lp.addedTitle"), t("lp.addedBody"));
      } else {
        setResult({ kind: "refunded" });
        toast.info(t("lp.refundedTitle"), t("lp.refundedBody"));
      }
      setStep("done");
      setAmount("");
    } catch (e) {
      setErr(humanizeError(e));
      setResult({ kind: "failed" });
      setStep("done");
    } finally {
      setBusy(false);
    }
  }

  async function confirmWithdraw() {
    if (!pos?.has_position) return;
    const pct = withdrawPct;
    const shares = pct >= 100 ? "all" : ((BigInt(pos.shares) * BigInt(pct)) / 100n).toString();
    const owed = {
      exfer: (Number(pos.value_exfer ?? 0) * pct / 100).toString(),
      bnb: (Number(pos.value_bnb ?? 0) * pct / 100).toString(),
    };
    setBusy(true);
    setErr(null);
    try {
      await rpc<{ withdrawal_id?: string }>("lp_withdraw_self", { exfer_address: exferAddr, shares });
      await load();
      await refresh();
      setResult({ kind: "removed", exfer: owed.exfer, bnb: owed.bnb });
      toast.success(t("lp.removeQueuedTitle"), t("lp.removeQueuedBody"));
      setStep("done");
    } catch (e) {
      setErr(humanizeError(e));
      setStep("withdraw");
    } finally {
      setBusy(false);
    }
  }

  // ── unavailable ──
  if (unavailable) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
        <Header />
        <div className="card-padded text-sm text-neutral-400">{t("lp.unavailable")}</div>
      </div>
    );
  }
  if (!pool) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
        <Header />
        <div className="card-padded text-sm text-neutral-500">{t("lp.loading")}</div>
      </div>
    );
  }

  // ── progress (staged) ──
  if (step === "progress") {
    const labels = [t("lp.stepSend"), t("lp.stepSweep"), t("lp.stepCredit")];
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
        <Header />
        <div className="card-padded space-y-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
            {t("lp.progressHeading")}
          </h2>
          <ol className="space-y-3">
            {labels.map((label, i) => {
              const done = stage > i;
              const current = stage === i;
              return (
                <li key={label} className="flex items-center gap-3">
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
                  <span className={done || current ? "text-neutral-100" : "text-neutral-500"}>{label}</span>
                </li>
              );
            })}
          </ol>
          <p className="text-xs text-neutral-500">{t("lp.progressHint")}</p>
        </div>
      </div>
    );
  }

  // ── result ──
  if (step === "done" && result) {
    const k = result.kind;
    const tone =
      k === "added" || k === "removed"
        ? "success"
        : k === "refunded"
          ? "info"
          : "error";
    const heading =
      k === "added"
        ? t("lp.addedHeading")
        : k === "removed"
          ? t("lp.removedHeading")
          : k === "refunded"
            ? t("lp.refundedTitle")
            : t("lp.failedHeading");
    const body =
      k === "added"
        ? t("lp.addedDoneBody")
        : k === "removed"
          ? t("lp.removeQueuedBody")
          : k === "refunded"
            ? t("lp.refundedBody")
            : err || t("lp.failedBody");
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
        <Header />
        <div className="card-padded space-y-5">
          <ResultBanner tone={tone} title={heading} body={body} />
          {(k === "added" || k === "removed") && result.exfer && (
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-neutral-400">{k === "added" ? t("lp.youProvided") : t("lp.youReceivedBack")}</span>
              <span className="font-mono tabular-nums text-neutral-200">
                {sig(Number(result.exfer))} EXFER + {sig(Number(result.bnb), 4)} BNB
              </span>
            </div>
          )}
          <button
            type="button"
            className="btn w-full"
            onClick={() => {
              setResult(null);
              setStep("overview");
            }}
          >
            {t("lp.done")}
          </button>
        </div>
      </div>
    );
  }

  // ── add ──
  if (step === "add") {
    const maxAdd = Math.min(exferBal / 1e8, mid > 0 ? bnbHuman / mid : Infinity);
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
        <Header />
        <div className="card-padded space-y-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">{t("lp.addTitle")}</h2>

          {/* EXFER source: user sees AND chooses which wallet funds the deposit. */}
          <div>
            <label className="label">{t("lp.fromExfer")}</label>
            {funded.length === 0 ? (
              <div className="banner-error">{t("lp.noFunded")}</div>
            ) : (
              <div className="space-y-2" role="radiogroup" aria-label={t("lp.fromExfer")}>
                {funded.map((e) => {
                  const label = getLabel(e.address) ?? e.label ?? undefined;
                  const name = label ?? (e.imported ? t("lp.imported") : t("lp.addressN", { n: e.index ?? "" }));
                  const selected = exferAddr === e.address;
                  return (
                    <button
                      key={e.address}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setFromAddr(e.address)}
                      disabled={busy}
                      className={
                        "flex w-full items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-left transition disabled:opacity-50 " +
                        (selected
                          ? "border-cyan-400 bg-cyan-500/10"
                          : "border-neutral-700 bg-neutral-950 hover:border-neutral-600")
                      }
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-neutral-100">{name}</div>
                        <code className="addr-xs text-neutral-500">{shortAddress(e.address)}</code>
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

          {/* EXFER amount */}
          <div>
            <div className="flex items-center justify-between">
              <label className="label mb-0">{t("lp.addExferAmount")}</label>
              {isFinite(maxAdd) && maxAdd > 0 && (
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => setAmount(sig(maxAdd))}
                  disabled={busy}
                >
                  {t("lp.max")}
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
              <span className={amountValid && !enoughExfer ? "text-amber-300" : "text-neutral-500"}>
                {amountValid && !enoughExfer
                  ? t("lp.needExfer")
                  : `${t("lp.balance")}: ${formatBalanceCompact(exferBal)}`}
              </span>
              {minExfer > 0 && (
                <span className={belowMin ? "text-amber-300" : "text-neutral-500"}>
                  {t("lp.minHint", { n: sig(Math.ceil(minExfer), 2) })}
                </span>
              )}
            </div>
          </div>

          {/* Matched pair + total */}
          <div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3">
            <PairRow unit="EXFER" amount={amountValid ? sig(amtNum) : "0"} />
            <div className="h-px bg-neutral-800" />
            <PairRow unit="BNB" amount={amountValid ? sig(bnbNeeded, 4) : "0"} />
            <div className="h-px bg-neutral-800" />
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-neutral-400">{t("lp.total")}</span>
              <span className="font-mono tabular-nums font-semibold text-neutral-100">
                ≈ {amountValid ? usdNumber(addUsd) : "$0"}
              </span>
            </div>
          </div>
          <p className="text-xs text-neutral-500">{t("lp.matchRatio")}</p>

          {/* BNB source: the single in-wallet BSC address. */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3">
            <div className="min-w-0">
              <div className="text-xs text-neutral-500">{t("lp.bnbFrom")}</div>
              <code className="addr-xs text-neutral-300">{bscAddr ? shortAddress(bscAddr, 10, 8) : "—"}</code>
            </div>
            <span
              className={
                "font-mono text-sm tabular-nums " +
                (amountValid && !enoughBnb ? "text-amber-300" : "text-neutral-300")
              }
            >
              {sig(bnbHuman, 4)} BNB
            </span>
          </div>

          {amountValid && !enoughBnb && (
            <div className="banner-error">{t("lp.needBnb", { bnb: sig(bnbNeeded, 4) })}</div>
          )}
          {belowMin && <div className="banner-error">{t("lp.belowMin", { n: sig(Math.ceil(minExfer), 2) })}</div>}
          <p className="text-xs text-neutral-500">{t("lp.gasNote")}</p>
          {err && <div className="banner-error">{err}</div>}

          <div className="flex gap-3">
            <button
              type="button"
              className="btn-secondary flex-1"
              disabled={busy}
              onClick={() => {
                setStep("overview");
                setErr(null);
              }}
            >
              {t("lp.back")}
            </button>
            <button type="button" className="btn flex-1" disabled={busy || !canAdd} onClick={confirmAdd}>
              {busy ? t("lp.working") : t("lp.addConfirm")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── withdraw ──
  if (step === "withdraw" && pos?.has_position) {
    const outExfer = (Number(pos.value_exfer ?? 0) * withdrawPct) / 100;
    const outBnb = (Number(pos.value_bnb ?? 0) * withdrawPct) / 100;
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
        <Header />
        <div className="card-padded space-y-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">{t("lp.removeTitle")}</h2>

          {/* Partial withdrawal */}
          <div>
            <label className="label">{t("lp.removeAmount")}</label>
            <div className="grid grid-cols-4 gap-2">
              {[25, 50, 75, 100].map((p) => {
                const active = withdrawPct === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setWithdrawPct(p)}
                    disabled={busy}
                    className={
                      "rounded-lg border px-3 py-2 text-sm font-medium transition disabled:opacity-50 " +
                      (active
                        ? "border-cyan-400 bg-cyan-500/10 text-cyan-200"
                        : "border-neutral-700 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200")
                    }
                  >
                    {p === 100 ? t("lp.all") : `${p}%`}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3">
            <div className="label mb-0">{t("lp.youReceiveBack")}</div>
            <PairRow unit="EXFER" amount={sig(outExfer)} />
            <div className="h-px bg-neutral-800" />
            <PairRow unit="BNB" amount={sig(outBnb, 4)} />
          </div>

          {/* Where the money lands. */}
          <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3">
            <div className="text-xs text-neutral-500">{t("lp.payoutTo")}</div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-300">EXFER</span>
              <code className="addr-xs text-neutral-400">{shortAddress(exferAddr)}</code>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-300">BNB</span>
              <code className="addr-xs text-neutral-400">{bscAddr ? shortAddress(bscAddr) : "—"}</code>
            </div>
          </div>

          <p className="text-xs text-neutral-500">{t("lp.removeNote")}</p>
          {err && <div className="banner-error">{err}</div>}

          <div className="flex gap-3">
            <button
              type="button"
              className="btn-secondary flex-1"
              disabled={busy}
              onClick={() => {
                setStep("overview");
                setErr(null);
              }}
            >
              {t("lp.back")}
            </button>
            <button type="button" className="btn flex-1" disabled={busy} onClick={confirmWithdraw}>
              {busy ? t("lp.working") : withdrawPct >= 100 ? t("lp.removeConfirm") : t("lp.removeConfirmPct", { pct: String(withdrawPct) })}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── overview ──
  const posValueUsd = pos?.has_position ? Number(pos.value_exfer ?? 0) * exferUsd * 2 : 0;
  const others = positions.filter((p) => p.address.toLowerCase() !== exferAddr.toLowerCase());
  const poolUsd = exferReserve * exferUsd * 2;
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8 fade-in">
      <Header />

      {/* Pool stats */}
      <div className="card-padded space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">{t("lp.poolTitle")}</h2>
        <div className="grid grid-cols-2 gap-4">
          <Stat label={t("lp.poolValue")} value={`≈ ${usdNumber(poolUsd)}`} />
          <Stat label={t("lp.providers")} value={String(pool.lp_count)} />
          <Stat label={t("lp.reserveExfer")} value={`${sig(exferReserve)} EXFER`} />
          <Stat label={t("lp.reserveBnb")} value={`${sig(bnbReserve, 6)} BNB`} />
        </div>
        <div className="flex items-baseline justify-between border-t border-neutral-800 pt-3 text-sm">
          <span className="text-neutral-500">{t("lp.totalShares")}</span>
          <span className="font-mono tabular-nums text-neutral-300">{pool.total_shares}</span>
        </div>
      </div>

      {/* Your position */}
      {pos?.has_position ? (
        <div className="card-padded space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">{t("lp.yourPosition")}</h2>
            <code className="addr-xs text-neutral-500">{shortAddress(exferAddr)}</code>
          </div>
          <div className="font-mono text-3xl font-semibold tabular-nums text-neutral-100">
            ≈ {usdNumber(posValueUsd)}
          </div>
          <div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3">
            <PairRow unit="EXFER" amount={sig(Number(pos.value_exfer ?? 0))} />
            <div className="h-px bg-neutral-800" />
            <PairRow unit="BNB" amount={sig(Number(pos.value_bnb ?? 0), 4)} />
          </div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-neutral-500">{t("lp.poolShare")}</span>
            <span className="font-mono tabular-nums text-neutral-300">{sig(pos.pool_share_pct ?? 0, 3)}% {t("lp.ofPool")}</span>
          </div>
        </div>
      ) : !posScanned || !posLoaded ? (
        <div className="card-padded text-sm text-neutral-500">{t("lp.loading")}</div>
      ) : positions.length > 0 ? (
        <div className="card-padded space-y-1">
          <div className="text-sm font-semibold text-neutral-100">{t("lp.posElsewhereHeading")}</div>
          <div className="text-xs text-neutral-500">{t("lp.posElsewhereSub")}</div>
        </div>
      ) : (
        <div className="card-padded space-y-1">
          <div className="text-sm font-semibold text-neutral-100">{t("lp.emptyHeading")}</div>
          <div className="text-xs text-neutral-500">{t("lp.emptySub")}</div>
        </div>
      )}

      {/* Positions on other addresses */}
      {others.length > 0 && (
        <div className="card-padded space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">{t("lp.otherPositions")}</h2>
          <div className="space-y-2">
            {others.map((p) => (
              <button
                key={p.address}
                type="button"
                onClick={() => {
                  setFromAddr(p.address);
                  setPos(p.pos);
                  setPosLoaded(true);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-neutral-700 bg-neutral-950 px-3.5 py-2.5 text-left transition hover:border-neutral-600"
              >
                <div className="min-w-0">
                  <code className="addr-xs text-neutral-300">{shortAddress(p.address)}</code>
                  <div className="text-xs text-neutral-500">
                    {sig(p.pos.pool_share_pct ?? 0, 3)}% {t("lp.ofPool")}
                  </div>
                </div>
                <span className="font-mono text-sm font-medium tabular-nums text-neutral-100">
                  ≈ {usdNumber(Number(p.pos.value_exfer ?? 0) * exferUsd * 2)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          type="button"
          className="btn flex-1"
          onClick={() => {
            setErr(null);
            setAmount("");
            setStep("add");
          }}
        >
          {t("lp.add")}
        </button>
        {pos?.has_position && (
          <button
            type="button"
            className="btn-secondary flex-1"
            onClick={() => {
              setErr(null);
              setWithdrawPct(100);
              setStep("withdraw");
            }}
          >
            {t("lp.remove")}
          </button>
        )}
      </div>

      {/* Fee explainer */}
      <div>
        <button
          type="button"
          onClick={() => setFeeOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300"
        >
          {t("lp.feeChip")}
          <span className="inline-grid h-3.5 w-3.5 place-items-center rounded-full border border-neutral-600 text-[9px] font-bold leading-none">
            ?
          </span>
        </button>
        {feeOpen && <p className="mt-2 text-xs text-neutral-400">{t("lp.feeInfo")}</p>}
      </div>
    </div>
  );
}

/** Safe parse — never throws while typing (returns +Infinity so it reads as
 *  "more than balance" until the input is a valid decimal). */
function parseExferAmountSafe(s: string): number {
  try {
    return parseExferAmount(s);
  } catch {
    return Infinity;
  }
}

function Header() {
  const { t } = useT();
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">{t("lp.title")}</h1>
      <p className="text-base text-neutral-400">{t("lp.headerDesc")}</p>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="font-mono text-sm tabular-nums text-neutral-100">{value}</div>
    </div>
  );
}

/** One row of a token pair: unit name · right-aligned amount. */
function PairRow({ unit, amount }: { unit: string; amount: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-sm font-medium text-neutral-300">{unit}</span>
      <span className="font-mono text-sm font-medium tabular-nums text-neutral-100">{amount}</span>
    </div>
  );
}

function ResultBanner({ tone, title, body }: { tone: "success" | "info" | "error"; title: string; body: string }) {
  const cls =
    tone === "success"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
      : tone === "error"
        ? "border-red-500/25 bg-red-500/10 text-red-200"
        : "border-cyan-500/25 bg-cyan-500/10 text-cyan-200";
  return (
    <div className={"rounded-lg border px-4 py-3 " + cls}>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-0.5 text-xs opacity-90">{body}</div>
    </div>
  );
}
