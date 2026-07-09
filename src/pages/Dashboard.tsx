import { useEffect, useState } from "react";
import {
  rpc,
  formatExfer,
  splitBalanceCompact,
  MAX_ADDRESSES,
} from "../lib/rpc";
import type { GeneratedAddress } from "../lib/types";
import { AddressRow } from "../components/AddressRow";
import { BnbAccount } from "../components/BnbAccount";
import { EarnPanel } from "../components/EarnPanel";
import { HelpPopover } from "../components/HelpPopover";
import { Receive } from "./Receive";
import { Send } from "./Send";
import { useWallet } from "../lib/wallet";
import { useBnbAsset, fmtUnits } from "../lib/bnb";
import { usePrice, usdValue, useBnbUsd, usdNumber } from "../lib/market";
import { useToast } from "../lib/toast";
import { isHidden, unhide } from "../lib/hidden";
import { setLabel } from "../lib/labels";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { useEscapeKey } from "../lib/useEscapeKey";
import { useInflight } from "../lib/inflight";
import { getProposals, cachedProposals, type Proposal } from "../lib/governance";

/** A 24h-change pill: green ▲ up, red ▼ down, grey • flat. Best-effort — the
 *  caller only renders it when a live price (and so a change) is available. */
function ChangePill({ pct }: { pct: number }) {
  const up = pct > 0.05;
  const down = pct < -0.05;
  const cls = up
    ? "bg-emerald-500/15 text-emerald-400"
    : down
      ? "bg-red-500/15 text-red-400"
      : "bg-neutral-700/40 text-neutral-400";
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-xs font-semibold tabular-nums " +
        cls
      }
    >
      {up ? "▲" : down ? "▼" : "•"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

export function Dashboard({ onOpenSwap, onOpenGovernance }: { onOpenSwap?: () => void; onOpenGovernance?: () => void }) {
  const { balance: data, loading, error, refresh } = useWallet();
  const toast = useToast();
  const { t } = useT();
  // Live EXFER/USD for the hero ≈$, the 24h pill, and per-address ≈$. Null until
  // the first fetch (or if the pool is unreachable) — every $ readout hides then.
  const price = usePrice();
  // The wallet's BNB (BSC) holding, shown as a passive overview tile. Polls on
  // its own; announceDeposits:false so it never double-toasts with Swap.
  const bnbAsset = useBnbAsset({ announceDeposits: false });
  const bnbUsd = useBnbUsd();
  const [generating, setGenerating] = useState(false);
  // The create flow opens a tiny dialog so a new address can be named up front
  // (optional). Blank name = just create, like before.
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  // The BNB deposit/withdraw/export console lives one click away in a modal so
  // the dashboard tile stays a glanceable summary.
  const [bnbOpen, setBnbOpen] = useState(false);
  // Receive and Send are re-homed here as dashboard actions (mirroring the
  // mobile Wallet tab): each opens the full page in a self-contained overlay.
  const [sheet, setSheet] = useState<null | "receive" | "send">(null);

  // Escape closes the create-address dialog. NOT the BNB console modal: it can
  // host its OWN Escape-aware child modals (SetupBnbWalletModal's recovery-phrase
  // screen locks Escape; ExportBnbKeyModal handles its own), and a window-level
  // listener here would fire too and tear the whole BNB modal down out from under
  // them — closing an unacknowledged recovery phrase. The BNB modal keeps its ✕
  // and backdrop-click to close.
  useEscapeKey(() => {
    if (creatingOpen && !generating) setCreatingOpen(false);
  });

  const allEntries = data?.entries ?? [];
  const hiddenEntries = allEntries.filter((e) => isHidden(e.address));
  const visibleEntries = showHidden
    ? allEntries
    : allEntries.filter((e) => !isHidden(e.address));
  const visibleTotal = visibleEntries.reduce((a, e) => a + e.balance, 0);
  const visiblePendingIn = visibleEntries.reduce(
    (a, e) => a + (e.pending_received ?? 0),
    0,
  );
  const visiblePendingOut = visibleEntries.reduce(
    (a, e) => a + (e.pending_spent ?? 0),
    0,
  );
  // The headline balance folds unconfirmed credit in, so a deposit reads as
  // if it landed instantly. The pending-ness is surfaced quietly (a tooltip
  // on the number) and enforced where it matters (spending uses confirmed
  // funds only).
  const visibleProjected = visibleTotal + visiblePendingIn - visiblePendingOut;
  const hasPending = visiblePendingIn > 0 || visiblePendingOut > 0;

  // EXFER currently locked in non-terminal swaps (the sell side locks EXFER on
  // the user's chain). The headline total quietly drops while a swap is in
  // flight; this line says where the funds are so the drop isn't a mystery.
  // useInflight runs its own light swap_list/LP poll for this consumer — a
  // cheap walletd journal lookup, not a node-RPC hit, but not free either.
  const inflight = useInflight();
  const lockedExfer = inflight.swaps.reduce(
    (a, s) =>
      s.direction === "exfer_to_bnb" && isFinite(Number(s.amount_in))
        ? a + Number(s.amount_in)
        : a,
    0,
  );

  // BNB tile: human balance + its ≈$ (best-effort; hidden when BNB/USD absent).
  const bnbHuman = (() => {
    if (!bnbAsset.bnbWei) return 0;
    try {
      return Number(BigInt(bnbAsset.bnbWei)) / 1e18;
    } catch {
      return 0;
    }
  })();
  const bnbUsdValue = bnbUsd != null && bnbHuman > 0 ? bnbHuman * bnbUsd : null;

  // Each generated address is its own independent key. We let the user name it
  // in one step: generate, then save the (optional) name as the address label.
  async function generateAddress(name?: string) {
    setGenerating(true);
    try {
      const label = name?.trim() ?? "";
      const a = await rpc<GeneratedAddress>("generate_standard_address", {
        label: label || null,
      });
      if (label) setLabel(a.address, label);
      await refresh();
      toast.success(
        t("dash.addrCreatedTitle"),
        label
          ? t("na.createdNamed", { name: label })
          : t("dash.addrCreatedBody", { addr: a.address.slice(0, 10) }),
      );
      setCreatingOpen(false);
      setCreateName("");
    } catch (e) {
      toast.error(t("dash.addrCreateFailTitle"), humanizeError(e));
    } finally {
      setGenerating(false);
    }
  }

  function openCreate() {
    setCreateName("");
    setCreatingOpen(true);
  }

  const isEmpty = !loading && data !== null && data.entries.length === 0;
  const atCap = (data?.entries.length ?? 0) >= MAX_ADDRESSES;

  const split = data ? splitBalanceCompact(visibleProjected) : null;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-8 fade-in">
      {/* Summary bar — total balance + ≈$ + addr count on one band. The live
          EXFER price + 24h pill ride the rail's Market card. */}
      <section className="card flex flex-wrap items-center gap-4 px-6 py-4">
        <div className="flex items-baseline gap-4">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            {t("dash.totalBalance")}
          </span>
          <span
            className="amount-lg flex items-baseline tracking-normal"
            title={
              data
                ? t("dash.exact", { amt: formatExfer(visibleProjected) }) +
                  (hasPending
                    ? ` · ` +
                      t("dash.confirmed", { amt: formatExfer(visibleTotal) }) +
                      (visiblePendingIn > 0
                        ? ` · ` +
                          t("dash.awaiting", {
                            amt: formatExfer(visiblePendingIn),
                          })
                        : "") +
                      (visiblePendingOut > 0
                        ? ` · ` +
                          t("dash.leaving", {
                            amt: formatExfer(visiblePendingOut),
                          })
                        : "")
                    : "")
                : undefined
            }
          >
            {split ? (
              <>
                <span>{split.whole}</span>
                {split.frac && (
                  <span className="text-neutral-500">.{split.frac}</span>
                )}
                <span className="ml-2 font-sans text-base font-medium text-neutral-400">
                  EXFER
                </span>
                {/* Quiet tell that part of this isn't confirmed yet — a small
                    dot, not a badge. The tooltip carries the breakdown. */}
                {hasPending && (
                  <span
                    className="ml-2 h-1.5 w-1.5 self-center rounded-full bg-neutral-600"
                    aria-label={t("dash.pendingDot")}
                  />
                )}
              </>
            ) : (
              "—"
            )}
          </span>
          {/* ≈$ inline, muted — tracks the projected total above. */}
          {data && price && (
            <span className="font-mono text-sm tabular-nums text-neutral-500">
              ≈ {usdValue(visibleProjected, price.usd)}
            </span>
          )}
          {/* The table enumerates the addresses; this is just the count chip. */}
          <span className="rounded-md bg-neutral-800/60 px-2 py-0.5 font-mono text-xs tabular-nums text-neutral-400">
            {t("dash.addrCount", { n: visibleEntries.length })}
          </span>
        </div>
        {/* Move money — Receive / Send folded in as dashboard actions. */}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setSheet("receive")}
          >
            {t("nav.receive")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setSheet("send")}
          >
            {t("nav.send")}
          </button>
        </div>
        {/* Funds locked in an active swap — a quiet plain-text pointer so the
            headline total dropping mid-swap isn't a mystery. Click → Swap. */}
        {lockedExfer > 0 && (
          <button
            type="button"
            onClick={onOpenSwap}
            className="w-full text-left text-xs text-neutral-500 transition hover:text-neutral-300"
          >
            {t("swap.lockedLine", {
              amt: lockedExfer.toLocaleString("en-US", {
                maximumFractionDigits: 4,
              }),
            })}
          </button>
        )}
      </section>

      {/* Governance is under Settings now, so surface an OPEN proposal here —
          voting windows close, so it shouldn't be invisible until you dig. */}
      <GovernanceNudge onOpen={onOpenGovernance} />

      {error && !data && (
        <div className="banner-error flex items-center justify-between gap-3">
          <span>{humanizeError(error)}</span>
          <button type="button" onClick={refresh} className="btn-secondary">
            {t("dash.retry")}
          </button>
        </div>
      )}

      {/* Two-pane: the address list gets the width; the BNB asset + side bits
          ride a narrow rail. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        {/* Address list (the hero object) */}
        <section className="card overflow-hidden">
          <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-2.5">
            <h2 className="text-base font-semibold tracking-tight text-neutral-100">
              {t("dash.addresses")}
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={refresh}
                disabled={loading}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-800 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-50"
                title={t("dash.refresh")}
                aria-label={t("dash.refresh")}
              >
                <span
                  className={
                    "inline-block " + (loading ? "animate-spin" : "")
                  }
                >
                  ↻
                </span>
              </button>
              <button
                type="button"
                onClick={openCreate}
                disabled={generating || atCap}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-800 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-50"
                title={
                  atCap
                    ? t("dash.cappedTitle", { n: MAX_ADDRESSES })
                    : t("dash.newAddr")
                }
                aria-label={t("dash.newAddr")}
              >
                <span className={generating ? "inline-block animate-spin" : ""}>
                  {generating ? "↻" : "+"}
                </span>
              </button>
            </div>
          </header>

          {loading && !data ? (
            <SkeletonRows />
          ) : isEmpty ? (
            <div className="px-5 py-12 text-center">
              <div className="mx-auto max-w-md space-y-2">
                <div className="text-lg font-medium text-neutral-300">
                  {t("dash.emptyTitle")}
                </div>
                <p className="text-sm text-neutral-400">{t("dash.emptyBody")}</p>
                <button
                  type="button"
                  onClick={openCreate}
                  disabled={generating}
                  className="btn mt-3"
                >
                  {generating ? t("dash.generating") : t("dash.genFirst")}
                </button>
              </div>
            </div>
          ) : (
            <table className="w-full table-fixed">
              <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-400">
                <tr>
                  <th className="w-[34%] px-5 py-2 text-left">{t("dash.colLabel")}</th>
                  <th className="w-[38%] px-5 py-2 text-left">{t("dash.colAddress")}</th>
                  <th className="w-[28%] px-5 py-2 text-right">{t("dash.colBalance")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {visibleEntries.map((e) => {
                  // Projected balance: confirmed + unconfirmed credit −
                  // unconfirmed debit, so the row reads as instant too.
                  const projected =
                    e.balance +
                    (e.pending_received ?? 0) -
                    (e.pending_spent ?? 0);
                  const hidden = isHidden(e.address);
                  return (
                    <AddressRow
                      key={e.address}
                      address={e.address}
                      index={e.index}
                      imported={e.imported}
                      balance={projected}
                      pendingIn={e.pending_received}
                      hidden={hidden}
                      onLabelChange={refresh}
                      onUnhide={() => {
                        unhide(e.address);
                        refresh();
                      }}
                    />
                  );
                })}
              </tbody>
            </table>
          )}

          {hiddenEntries.length > 0 && (
            <div className="border-t border-neutral-800 px-5 py-2.5 text-xs text-neutral-400">
              {hiddenEntries.length === 1
                ? t("dash.hidden1", { n: hiddenEntries.length })
                : t("dash.hiddenN", { n: hiddenEntries.length })}{" "}
              ·{" "}
              <button
                type="button"
                onClick={() => setShowHidden((v) => !v)}
                className="font-medium text-cyan-400 hover:underline"
              >
                {showHidden ? t("dash.hideThem") : t("dash.show")}
              </button>
            </div>
          )}
        </section>

        {/* Right rail: a Market card (EXFER price + 24h) and the BNB asset as a
            compact summary tile. The full BNB console opens in a modal. */}
        <aside className="space-y-6">
          {/* Market card — gives the rail weight so it isn't a lone short tile,
              and reuses the same numeric system + ChangePill as the balance total. */}
          {price && (
            <section className="card-padded space-y-3">
              <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                {t("dash.marketTitle")}
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-neutral-500">EXFER</span>
                <span className="font-mono text-sm tabular-nums text-neutral-100">
                  {usdValue(100_000_000, price.usd)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-neutral-500">{t("dash.change24h")}</span>
                <ChangePill pct={price.change24h} />
              </div>
            </section>
          )}

          {!bnbAsset.ready ? (
            /* First poll still in flight — a skeleton so the rail never
               collapses to a blank column. Resolves to one of the two states
               below once bsc_get_address answers. */
            <section className="card-padded space-y-4" aria-hidden>
              <div className="flex items-start justify-between gap-3">
                <div className="h-4 w-20 animate-pulse rounded bg-neutral-800" />
                <div className="h-4 w-24 animate-pulse rounded bg-neutral-800" />
              </div>
              <div className="h-9 w-full animate-pulse rounded-lg bg-neutral-800" />
            </section>
          ) : bnbAsset.address ? (
            <section className="card-padded space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
                  {t("dash.bnbTileTitle")}
                  <HelpPopover title={t("bnb.helpTitle")} body={t("bnb.helpBody")} />
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm tabular-nums text-neutral-100">
                    {fmtUnits(bnbAsset.bnbWei ?? undefined, 18, 5)} BNB
                  </div>
                  {bnbUsdValue != null && (
                    <div className="font-mono text-xs tabular-nums text-neutral-500">
                      ≈ {usdNumber(bnbUsdValue)}
                    </div>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="btn-secondary w-full"
                onClick={() => setBnbOpen(true)}
              >
                {t("dash.bnbManage")}
              </button>
            </section>
          ) : (
            /* Loaded, but this wallet has no BSC key (a seedless / imported
               wallet — nothing to derive a BNB address from). Offer to set one
               up instead of sitting on a forever skeleton with no affordance. */
            <section className="card-padded space-y-3">
              <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                {t("dash.bnbTileTitle")}
              </div>
              <p className="text-xs leading-relaxed text-neutral-500">
                {t("bnb.setupBody")}
              </p>
              <button
                type="button"
                className="btn-secondary w-full"
                onClick={() => setBnbOpen(true)}
              >
                {t("bnb.notCreatedTitle")}
              </button>
            </section>
          )}
        </aside>
      </div>

      {/* Earn — the on-device CPU miner. Solo (default) or a shared pool, paid
          out to an address you pick. Native to the installed app; renders and
          degrades gracefully in the browser preview. */}
      <EarnPanel />

      {/* Receive / Send — the full pages re-homed as dashboard actions, shown in
          a self-contained full-screen overlay with a back affordance. */}
      {sheet && (
        <div className="fixed inset-0 z-50 overflow-auto bg-black fade-in">
          <div className="sticky top-0 z-10 flex items-center border-b border-neutral-800 bg-black/90 px-6 py-3 backdrop-blur">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setSheet(null)}
            >
              <span aria-hidden>←</span> {t("dash.back")}
            </button>
          </div>
          {sheet === "receive" ? <Receive /> : <Send />}
        </div>
      )}

      {/* New-address dialog — an optional name field so a fresh key can be
          labelled on creation. Blank name just creates, like before. */}
      {creatingOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/40 p-6 fade-in"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !generating)
              setCreatingOpen(false);
          }}
        >
          <div className="card-padded mt-24 w-full max-w-sm space-y-4">
            <h2 className="text-base font-semibold tracking-tight text-neutral-100">
              {t("na.title")}
            </h2>
            <p className="text-sm text-neutral-400">{t("na.info")}</p>
            <div>
              <label className="label">{t("na.nameOptional")}</label>
              <input
                className="input"
                value={createName}
                maxLength={28}
                autoFocus
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !generating)
                    generateAddress(createName);
                  if (e.key === "Escape" && !generating) setCreatingOpen(false);
                }}
                placeholder={t("na.namePlaceholder")}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setCreatingOpen(false)}
                disabled={generating}
              >
                {t("na.cancel")}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => generateAddress(createName)}
                disabled={generating}
              >
                {generating ? t("dash.generating") : t("na.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The full BNB console (deposit QR, withdraw, key export), one click
          away in a modal so the dashboard stays glanceable. */}
      {bnbOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/40 p-6 fade-in"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setBnbOpen(false);
          }}
        >
          <div className="w-full max-w-md">
            <BnbAccount asset={bnbAsset} variant="full" onClose={() => setBnbOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-neutral-800">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-2.5">
          <div className="h-4 w-6 animate-pulse rounded bg-neutral-800" />
          <div className="h-4 w-24 animate-pulse rounded bg-neutral-800" />
          <div className="h-4 flex-1 animate-pulse rounded bg-neutral-800" />
          <div className="h-4 w-28 animate-pulse rounded bg-neutral-800" />
        </div>
      ))}
    </div>
  );
}

/** Open proposals: not finalized AND now inside the voting window. */
function openProposals(list: Proposal[] | null): Proposal[] {
  if (!list) return [];
  const now = Math.floor(Date.now() / 1000);
  return list.filter((p) => p.status !== "finalized" && now >= p.window.open_time && now < p.window.close_time);
}

/** A Dashboard nudge shown ONLY when a proposal is open for voting (governance
 *  lives under Settings now, and voting windows close). Seeds from the SWR cache
 *  so it paints instantly; fully fail-silent — a vote-server error renders nothing. */
function GovernanceNudge({ onOpen }: { onOpen?: () => void }) {
  const { t } = useT();
  const [open, setOpen] = useState<Proposal[]>(() => openProposals(cachedProposals()));
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await getProposals();
        if (!cancelled) setOpen(openProposals(list));
      } catch {
        /* vote server unreachable — never surface an error on the Dashboard */
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  if (open.length === 0 || !onOpen) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="banner-info flex w-full items-center justify-between gap-3 text-left transition hover:brightness-110"
    >
      <span>{t("dash.govNudge", { n: open.length })}</span>
      <span className="shrink-0 font-medium">{t("nav.governance")} →</span>
    </button>
  );
}
