// Liquidity (LP) — self-serve add / remove against the swap pool. Wired to the
// walletd LP proxy RPCs. Shares are an off-chain ledger (Exfer has no VM); the
// pool reports reserves and a per-share NAV, and we never touch wei — every
// LP RPC speaks human-decimal strings.
//
// Single desktop screen, two-pane:
//   LEFT  — read-only context: pool stats + your position (across every address)
//   RIGHT — action card with [Add] / [Remove] tabs; add/remove never take over
//           the screen — progress + result collapse into an inline status strip
//           at the top of the right pane while the left context stays visible.
//
// Flows:
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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { rpc, formatBalanceCompact, parseExferAmount } from "../lib/rpc";
import type { WalletEntry } from "../lib/types";
import { getLabel, shortAddress } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import { useWallet } from "../lib/wallet";
import { useToast } from "../lib/toast";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { usePrice, useBnbUsd, usdNumber } from "../lib/market";
import { addLpOp, removeLpOp } from "../lib/inflightLp";
import { useResumeTarget } from "../lib/inflight";
import { SetupBnbWalletModal } from "../components/SetupBnbWalletModal";
import { StagedStepper, PairCoins } from "../components/anim";

const FEE_RATE = 1; // exfers/byte, matches Send
// The BNB leg is swept from a per-request address that pays its own BSC gas, so
// it must clear a safe gas floor (a few × the typical 21000-gas cost). Below
// this the pool would auto-refund the deposit, so we block it up front instead.
const MIN_BNB_LEG = 0.00001;
// One precision for every BNB amount rendered on this page so columns align
// across rows (and with the BnbAccount sibling). Display-only — never used for
// the wei/amount we actually send.
const BNB_DP = 4;

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
// "stillProcessing" — the deposit poll outlived its window but nothing failed:
// it finishes (or refunds) in the background, so it must NOT render as an
// error. "sentPartial" — the EXFER leg already left the wallet when a later
// step threw: the deposit either completes or auto-returns at expiry, so the
// copy must not invite a retry (that would double-send).
type ResultKind = "added" | "refunded" | "removed" | "failed" | "stillProcessing" | "sentPartial";
// `tab` is the persistent right-pane view; `phase` overlays a transient status
// strip (progress / done) on top of it without leaving the two-pane layout.
type Tab = "add" | "remove";
type Phase = "form" | "progress" | "done";

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
  // Resume hand-off: an in-flight LP-add row elsewhere can route here with the
  // deposit id to re-poll. Read once on mount, then clear so a tab re-entry
  // doesn't re-trigger it.
  const { resumeLpAddId, clearResumeTarget } = useResumeTarget();

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

  const [tab, setTab] = useState<Tab>("add");
  const [phase, setPhase] = useState<Phase>("form");
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const [posLoaded, setPosLoaded] = useState(false);
  const [bscAddr, setBscAddr] = useState("");
  // Seedless wallets start with no BSC key (`created:false`, `address:null`).
  // The BNB leg of an add is funded from this key, so the whole Add is gated on
  // it existing — otherwise bsc_send_bnb would fail mid-deposit.
  const [bscCreated, setBscCreated] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
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

  const load = useCallback(async () => {
    try {
      const p = await rpc<PoolInfo>("lp_pool_info");
      if ((p as unknown as { error?: string })?.error || !p.genesis_done) {
        setUnavailable(true);
        return;
      }
      setPool(p);
      const [a, b] = await Promise.all([
        rpc<{ address: string | null; created: boolean }>("bsc_get_address").catch(
          () => ({ address: "", created: false }),
        ),
        rpc<{ bnb_wei: string }>("bsc_get_balances").catch(() => ({ bnb_wei: "0" })),
      ]);
      setBscAddr(a.address ?? "");
      setBscCreated(!!a.created);
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

  // Refresh the BNB balance when entering the Add tab — a cold walletd can
  // return 0 at first load, which would wrongly read as "not enough BNB".
  useEffect(() => {
    if (tab !== "add" || phase !== "form") return;
    rpc<{ bnb_wei: string }>("bsc_get_balances")
      .then((b) => {
        if (b?.bnb_wei) setBnbWei(b.bnb_wei);
      })
      .catch(() => {});
  }, [tab, phase]);

  // Resume an in-progress add: routed here from an in-flight LP row, reopen
  // straight onto THIS deposit's progress and poll it to completion (mirrors
  // mobile's LiquiditySheet). One-shot — clear the hand-off so re-entering the
  // tab doesn't replay it.
  useEffect(() => {
    if (!resumeLpAddId) return;
    const id = resumeLpAddId;
    clearResumeTarget();
    let cancelled = false;
    setTab("add");
    setPhase("progress");
    setStage(1);
    (async () => {
      try {
        const status = await pollDeposit(id);
        if (cancelled) return;
        if (status === "stillProcessing") {
          // Not terminal — leave the op tracked; it resolves in the background.
          setResult({ kind: "stillProcessing" });
          setPhase("done");
          return;
        }
        removeLpOp(id);
        await load();
        await refresh();
        if (status === "completed") {
          const pp = await rpc<Position>("lp_position", { address: exferAddr.toLowerCase() }).catch(() => null);
          setResult({ kind: "added", exfer: pp?.value_exfer, bnb: pp?.value_bnb });
        } else if (status === "failed") {
          // A resumed deposit means the EXFER already left the wallet — same
          // no-retry framing as the live flow.
          setResult({ kind: "sentPartial" });
        } else {
          setResult({ kind: "refunded" });
        }
        setPhase("done");
      } catch (e) {
        if (cancelled) return;
        setErr(humanizeError(e));
        setResult({ kind: "failed" });
        setPhase("done");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeLpAddId]);

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
  // The BNB leg is funded from the BSC key — gate the whole Add until it exists
  // (seedless wallets have none). Without it there's no BNB to send and no
  // address to sweep from, so an "add" can't complete.
  const hasBscWallet = bscCreated && !!bscAddr;
  const canAdd = hasBscWallet && amountValid && enoughExfer && enoughBnb && !belowMin;

  // Terminal deposit outcomes plus "stillProcessing": the 5-minute watch
  // window closing is NOT a failure (the pool finishes or auto-refunds in the
  // background), so the poll resolves a neutral outcome instead of rejecting
  // into the error path.
  type DepositOutcome =
    | "completed"
    | "expired"
    | "refunded"
    | "failed"
    | "stillProcessing";
  function pollDeposit(id: string): Promise<DepositOutcome> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = async () => {
        try {
          const s = await rpc<{ status: string }>("lp_deposit_status", { id });
          if (s.status === "completed") {
            setStage(2);
            return resolve("completed");
          }
          if (s.status === "expired" || s.status === "refunded" || s.status === "failed")
            return resolve(s.status);
        } catch {
          /* transient */
        }
        if (Date.now() - t0 > 5 * 60_000) return resolve("stillProcessing");
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
    setPhase("progress");
    // Once the EXFER transfer broadcasts, funds have left the wallet — a later
    // failure must NOT read as a retryable "failed" (a retry would double-send;
    // the deposit either completes or auto-returns at expiry).
    let exferSent = false;
    try {
      const intent = await rpc<{ id: string; deposit_exfer_address: string; deposit_bsc_address: string }>(
        "lp_deposit_start",
        { exfer_address: exferAddr, bsc_address: bscAddr },
      );
      // Track it so the Liquidity nav badge + global in-flight surface show it —
      // and so it survives the user leaving this page (the deposit finishes in
      // the background). Cleared the moment the deposit goes terminal below.
      addLpOp({ id: intent.id, kind: "add", exfer: amount, bnb: sig(bnbNeeded, 4), startedAt: Date.now() });
      await rpc("transfer", {
        from: exferAddr,
        outputs: [{ to: intent.deposit_exfer_address, amount: parseExferAmount(amount) }],
        fee_rate: FEE_RATE,
      });
      exferSent = true;
      await rpc("bsc_send_bnb", { to: intent.deposit_bsc_address, amount: sig(bnbNeeded, 8) });
      setStage(1);
      const status = await pollDeposit(intent.id);
      if (status === "stillProcessing") {
        // Not terminal — keep the in-flight op tracked (it resolves in the
        // background) and show the neutral strip, not a failure.
        setResult({ kind: "stillProcessing" });
        setPhase("done");
        setAmount("");
        return;
      }
      removeLpOp(intent.id);
      await load();
      await refresh();
      if (status === "completed") {
        const pp = await rpc<Position>("lp_position", { address: exferAddr.toLowerCase() }).catch(() => null);
        setResult({ kind: "added", exfer: pp?.value_exfer, bnb: pp?.value_bnb });
        toast.success(t("lp.addedTitle"), t("lp.addedBody"));
      } else if (status === "failed") {
        setResult({ kind: "sentPartial" });
      } else {
        // expired / refunded — both legs come back automatically.
        setResult({ kind: "refunded" });
        toast.info(t("lp.refundedTitle"), t("lp.refundedBody"));
      }
      setPhase("done");
      setAmount("");
    } catch (e) {
      if (exferSent) {
        // The EXFER leg is already on-chain: say so honestly (it auto-returns
        // at expiry if the deposit can't complete) instead of "failed — try
        // again".
        setResult({ kind: "sentPartial" });
      } else {
        setErr(humanizeError(e));
        setResult({ kind: "failed" });
      }
      setPhase("done");
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
      const w = await rpc<{ withdrawal_id?: string }>("lp_withdraw_self", { exfer_address: exferAddr, shares });
      // Surface it in the in-flight set while the pool pays both legs (a few
      // seconds). No per-id status endpoint for removes — it falls off by TTL.
      addLpOp({
        id: w?.withdrawal_id || `wd-${Date.now()}`,
        kind: "remove",
        exfer: owed.exfer,
        bnb: sig(Number(owed.bnb), 4),
        startedAt: Date.now(),
      });
      await load();
      await refresh();
      setResult({ kind: "removed", exfer: owed.exfer, bnb: owed.bnb });
      toast.success(t("lp.removeQueuedTitle"), t("lp.removeQueuedBody"));
      setPhase("done");
    } catch (e) {
      setErr(humanizeError(e));
      setPhase("form");
    } finally {
      setBusy(false);
    }
  }

  // Reset the right pane back to its form (used by Done + tab switches).
  function resetPane(next?: Tab) {
    setResult(null);
    setErr(null);
    setStage(0);
    setPhase("form");
    if (next) setTab(next);
  }

  const hasPosition = !!pos?.has_position;

  // ── unavailable / loading ──
  if (unavailable) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-6 fade-in">
        <Header mid={0} exferUsd={0} ready={false} />
        <div className="card-padded text-sm text-neutral-400">{t("lp.unavailable")}</div>
      </div>
    );
  }
  if (!pool) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-6 fade-in">
        <Header mid={0} exferUsd={0} ready={false} />
        <div className="card-padded text-sm text-neutral-500">{t("lp.loading")}</div>
      </div>
    );
  }

  const posValueUsd = hasPosition ? Number(pos!.value_exfer ?? 0) * exferUsd * 2 : 0;
  const maxAdd = Math.min(exferBal / 1e8, mid > 0 ? bnbHuman / mid : Infinity);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6 fade-in">
      <Header mid={mid} exferUsd={exferUsd} ready={mid > 0} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* ── LEFT RAIL — read-only context. self-start so the card sizes to
            its content instead of stretching to the (taller) action card's
            height, which left a large empty void in the no-position state. ── */}
        <div className="self-start lg:col-span-5">
          <div className="card-padded space-y-4">
            {/* Pool-wide figures (total reserves, pool value, total shares,
                provider count) and the %-of-pool share are intentionally NOT
                shown: the desktop wallet exposes only the user's OWN holdings,
                never the pool's totals or relative size. */}

            {/* Your position */}
            <div className="space-y-2">
              {hasPosition ? (
                <>
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs uppercase tracking-wide text-neutral-500">{t("lp.yourPosition")}</span>
                    <code className="addr-xs text-neutral-500">{shortAddress(exferAddr)}</code>
                  </div>
                  <div className="font-mono text-3xl font-semibold tabular-nums text-neutral-100">
                    ≈ {usdNumber(posValueUsd)}
                  </div>
                  <div className="grid grid-cols-2 gap-3 font-mono text-sm tabular-nums text-neutral-300">
                    <span>{sig(Number(pos!.value_exfer ?? 0))} EXFER</span>
                    <span className="text-right">{sig(Number(pos!.value_bnb ?? 0), BNB_DP)} BNB</span>
                  </div>
                </>
              ) : !posScanned || !posLoaded ? (
                <div className="text-sm text-neutral-500">{t("lp.loading")}</div>
              ) : (
                // Paired-coin hero — the pool's two assets overlapping, like
                // every LP pair. Gives the empty state an identity instead of a
                // lone line of text.
                <div className="flex flex-col items-center py-6 text-center pop">
                  <PairCoins size={54} />
                  <div className="mt-4 text-xs font-bold uppercase tracking-[0.07em] text-neutral-500">
                    EXFER · BNB
                  </div>
                  <div className="mt-1.5 text-base font-semibold text-neutral-100">
                    {t("lp.emptyHeading")}
                  </div>
                  <div className="mx-auto mt-1.5 max-w-[18rem] text-xs leading-relaxed text-neutral-400">
                    {t("lp.emptySub")}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── RIGHT PANE — action card ── */}
        <div className="lg:col-span-7">
          <div className="card-padded space-y-4">
            {/* Tabs */}
            <div className="inline-flex rounded-lg border border-neutral-800 bg-neutral-950 p-1 text-sm">
              <TabButton active={tab === "add"} onClick={() => resetPane("add")}>
                {t("lp.add")}
              </TabButton>
              {hasPosition && (
                <TabButton active={tab === "remove"} onClick={() => resetPane("remove")}>
                  {t("lp.remove")}
                </TabButton>
              )}
            </div>

            {/* Inline status strip (progress / done) replaces the form body. */}
            {phase === "progress" ? (
              <ProgressStrip stage={stage} labels={[t("lp.stepSend"), t("lp.stepSweep"), t("lp.stepCredit")]} />
            ) : phase === "done" && result ? (
              <DoneStrip result={result} err={err} onDone={() => resetPane(hasPosition ? undefined : "add")} />
            ) : tab === "add" && !hasBscWallet ? (
              /* ── No BSC key: the BNB leg has nowhere to come from. Surface a
                 clear "set up your BNB wallet" notice WITH a button that creates
                 / imports one right here, instead of dead-ending on text that
                 points the user off to another screen. ── */
              <div className="rounded-lg border border-neutral-800 bg-neutral-950 px-5 py-8 text-center">
                <div className="text-sm font-semibold text-neutral-100">
                  {t("bnb.notCreatedTitle")}
                </div>
                <p className="mx-auto mt-1.5 max-w-sm text-sm text-neutral-400">
                  {t("bnb.lpNeedsWallet")}
                </p>
                <button
                  type="button"
                  className="btn mx-auto mt-4"
                  onClick={() => setSetupOpen(true)}
                >
                  {t("bnb.notCreatedTitle")}
                </button>
              </div>
            ) : tab === "add" ? (
              /* ── ADD ── */
              <div className="space-y-3">
                {/* EXFER source */}
                <div>
                  <label className="label">{t("lp.fromExfer")}</label>
                  {funded.length === 0 ? (
                    // A wallet with no EXFER yet is a normal state, not an error
                    // — neutral boxed notice (matches Swap's empty-from state),
                    // not a blood-red banner.
                    <div className="rounded-lg border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 text-sm text-neutral-400">
                      {t("lp.noFunded")}
                    </div>
                  ) : (
                    <select
                      className="input cursor-pointer hover:border-neutral-600"
                      value={exferAddr}
                      onChange={(e) => setFromAddr(e.target.value)}
                      disabled={busy}
                      aria-label={t("lp.fromExfer")}
                    >
                      {funded.map((e) => {
                        const label = getLabel(e.address) ?? e.label ?? undefined;
                        const name =
                          label ?? (e.imported ? t("lp.imported") : t("lp.addressN", { n: e.index ?? "" }));
                        return (
                          <option key={e.address} value={e.address}>
                            {name} · {shortAddress(e.address)} · {formatBalanceCompact(e.balance)}
                          </option>
                        );
                      })}
                    </select>
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
                  <div className="mt-1.5 flex items-baseline justify-between text-xs">
                    <span className={amountValid && !enoughExfer ? "text-amber-300" : "text-neutral-500"}>
                      {amountValid && !enoughExfer
                        ? t("lp.needExfer")
                        : `${t("lp.balance")}: ${formatBalanceCompact(exferBal)}`}
                    </span>
                    {minExfer > 0 && (
                      <span
                        className={belowMin ? "text-amber-300" : "text-neutral-500"}
                        title={t("lp.gasNote")}
                      >
                        {t("lp.minHint", { n: sig(Math.ceil(minExfer), 2) })} ⓘ
                      </span>
                    )}
                  </div>
                </div>

                {/* Matched pair + total — one dense row */}
                <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3">
                  <label className="label mb-0">{t("lp.youAdd")}</label>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-sm tabular-nums">
                    <span className="text-neutral-100">{amountValid ? sig(amtNum) : "0"} EXFER</span>
                    <span className="text-neutral-500">+</span>
                    <span className="text-neutral-100">{amountValid ? sig(bnbNeeded, BNB_DP) : "0"} BNB</span>
                    <span className="text-neutral-500">=</span>
                    <span className="font-semibold text-neutral-100">
                      ≈ {amountValid ? usdNumber(addUsd) : "$0"}
                    </span>
                  </div>
                  <div
                    className={
                      "text-xs " + (amountValid && !enoughBnb ? "text-amber-300" : "text-neutral-500")
                    }
                  >
                    {t("lp.bnbSource", {
                      addr: bscAddr ? shortAddress(bscAddr) : "—",
                      bnb: sig(bnbHuman, BNB_DP),
                    })}
                  </div>
                </div>

                {amountValid && !enoughBnb && (
                  <div className="banner-error">{t("lp.needBnb", { bnb: sig(bnbNeeded, BNB_DP) })}</div>
                )}
                {belowMin && (
                  <div className="banner-error">{t("lp.belowMin", { n: sig(Math.ceil(minExfer), 2) })}</div>
                )}
                {err && <div className="banner-error">{err}</div>}

                <button type="button" className="btn w-full" disabled={busy || !canAdd} onClick={confirmAdd}>
                  {busy ? t("lp.working") : t("lp.addConfirm")}
                </button>
              </div>
            ) : (
              /* ── REMOVE ── */
              hasPosition && (
                <RemoveForm
                  pos={pos!}
                  withdrawPct={withdrawPct}
                  setWithdrawPct={setWithdrawPct}
                  exferAddr={exferAddr}
                  bscAddr={bscAddr}
                  busy={busy}
                  err={err}
                  onConfirm={confirmWithdraw}
                />
              )
            )}
          </div>

          {/* Other-address positions — tight list, folds picking into the pane. */}
          {posScanned && positions.length > 0 && (
            <div className="card-padded mt-4 space-y-2">
              <div className="text-xs uppercase tracking-wide text-neutral-500">{t("lp.otherPositions")}</div>
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {positions.map((p) => {
                  const active = p.address.toLowerCase() === exferAddr.toLowerCase();
                  return (
                    <button
                      key={p.address}
                      type="button"
                      onClick={() => {
                        setFromAddr(p.address);
                        setPos(p.pos);
                        setPosLoaded(true);
                        resetPane("add");
                      }}
                      className={
                        "flex w-full items-baseline justify-between gap-3 rounded px-2 py-1 text-xs transition " +
                        (active ? "bg-cyan-500/10" : "hover:bg-neutral-800/60")
                      }
                    >
                      <code className="addr-xs text-neutral-300">{shortAddress(p.address)}</code>
                      <span className="font-mono tabular-nums text-neutral-200">
                        ≈ {usdNumber(Number(p.pos.value_exfer ?? 0) * exferUsd * 2)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {setupOpen && (
        <SetupBnbWalletModal
          onClose={() => setSetupOpen(false)}
          onCreated={() => {
            // Key now exists — re-read so bscCreated/bscAddr flip and the Add
            // form unlocks without leaving this screen.
            setSetupOpen(false);
            void load();
          }}
        />
      )}
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

function Header({ mid, exferUsd, ready }: { mid: number; exferUsd: number; ready: boolean }) {
  const { t } = useT();
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h1 className="text-xl font-semibold tracking-tight text-neutral-100">{t("lp.title")}</h1>
      {ready && (
        <span className="font-mono text-xs tabular-nums text-neutral-500">
          {t("lp.midPrice", { mid: sig(mid, 6), usd: sig(exferUsd, 4) })}
        </span>
      )}
    </header>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-md px-4 py-1.5 font-medium transition " +
        (active ? "bg-cyan-500/15 text-cyan-200" : "text-neutral-400 hover:text-neutral-200")
      }
    >
      {children}
    </button>
  );
}

/** Thin inline status strip while the add deposit is in flight: 3 dots in a row. */
function ProgressStrip({ stage, labels }: { stage: number; labels: string[] }) {
  // The active node is the current `stage`; chevrons flow into it (shared with
  // the swap progress so the two read identically).
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-4">
      <StagedStepper labels={labels} doneCount={stage} />
    </div>
  );
}

/** One-line result banner with the amount inline + a Done. Tones are honest:
 *  only a CREDITED add is green; a queued withdrawal and a returned deposit are
 *  neutral (the assets arrive on their own); "still processing" and "EXFER
 *  already sent" are amber (in progress / hands-off), never the red failure. */
function DoneStrip({
  result,
  err,
  onDone,
}: {
  result: { kind: ResultKind; bnb?: string; exfer?: string };
  err: string | null;
  onDone: () => void;
}) {
  const { t } = useT();
  const k = result.kind;
  const tone =
    k === "added"
      ? "success"
      : k === "failed"
        ? "error"
        : k === "stillProcessing" || k === "sentPartial"
          ? "warn"
          : "info"; // removed (queued) / refunded
  const cls =
    tone === "success"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
      : tone === "error"
        ? "border-red-500/25 bg-red-500/10 text-red-200"
        : tone === "warn"
          ? "border-amber-500/25 bg-amber-500/10 text-amber-200"
          : "border-cyan-500/25 bg-cyan-500/10 text-cyan-200";
  const heading =
    k === "added"
      ? t("lp.addedHeading")
      : k === "removed"
        ? t("lp.withdrawQueuedTitle")
        : k === "refunded"
          ? t("lp.refundedTitle")
          : k === "stillProcessing"
            ? t("lp.stillProcessingTitle")
            : t("lp.failedHeading"); // failed + sentPartial
  const body =
    k === "removed"
      ? t("lp.withdrawQueuedBody")
      : k === "stillProcessing"
        ? t("lp.stillProcessingBody")
        : k === "sentPartial"
          ? t("lp.sentPartialBody")
          : k === "failed" && err
            ? err
            : null;
  const showAmt = (k === "added" || k === "removed") && result.exfer;
  return (
    <div className="space-y-3">
      <div className={"rounded-lg border px-4 py-3 " + cls}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-semibold">{heading}</span>
          {showAmt && (
            <span className="font-mono text-xs tabular-nums opacity-90">
              {sig(Number(result.exfer))} EXFER + {sig(Number(result.bnb), BNB_DP)} BNB
            </span>
          )}
        </div>
        {body && <div className="mt-0.5 text-xs leading-relaxed opacity-90">{body}</div>}
      </div>
      <button type="button" className="btn w-full" onClick={onDone}>
        {t("lp.done")}
      </button>
    </div>
  );
}

function RemoveForm({
  pos,
  withdrawPct,
  setWithdrawPct,
  exferAddr,
  bscAddr,
  busy,
  err,
  onConfirm,
}: {
  pos: Position;
  withdrawPct: number;
  setWithdrawPct: (n: number) => void;
  exferAddr: string;
  bscAddr: string;
  busy: boolean;
  err: string | null;
  onConfirm: () => void;
}) {
  const { t } = useT();
  const outExfer = (Number(pos.value_exfer ?? 0) * withdrawPct) / 100;
  const outBnb = (Number(pos.value_bnb ?? 0) * withdrawPct) / 100;
  return (
    <div className="space-y-3">
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
                {`${p}%`}
              </button>
            );
          })}
        </div>
      </div>

      {/* You receive back: amount line + payout addresses, one dense block. */}
      <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3">
        <label className="label mb-0">{t("lp.youReceiveBack")}</label>
        <div className="font-mono text-sm tabular-nums text-neutral-100">
          {sig(outExfer)} EXFER + {sig(outBnb, BNB_DP)} BNB
        </div>
        <div className="font-mono text-xs text-neutral-500">
          → {shortAddress(exferAddr)} / {bscAddr ? shortAddress(bscAddr) : "—"}
        </div>
      </div>

      {err && <div className="banner-error">{err}</div>}

      <button
        type="button"
        className="btn w-full"
        disabled={busy || outExfer + outBnb <= 0}
        onClick={onConfirm}
      >
        {busy
          ? t("lp.working")
          : withdrawPct >= 100
            ? t("lp.removeConfirm")
            : t("lp.removeConfirmPct", { pct: String(withdrawPct) })}
      </button>
    </div>
  );
}
