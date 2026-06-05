import { useState } from "react";
import {
  rpc,
  formatExfer,
  splitBalanceCompact,
  MAX_ADDRESSES,
} from "../lib/rpc";
import type { GeneratedAddress } from "../lib/types";
import { AddressRow } from "../components/AddressRow";
import { BnbAccount } from "../components/BnbAccount";
import { useWallet } from "../lib/wallet";
import { useBnbAsset, fmtUnits } from "../lib/bnb";
import { usePrice, usdValue, useBnbUsd, usdNumber } from "../lib/market";
import { useToast } from "../lib/toast";
import { isHidden, unhide } from "../lib/hidden";
import { setLabel } from "../lib/labels";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";

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

export function Dashboard() {
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
      </section>

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

          {bnbAsset.address ? (
            <section className="card-padded space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  {t("dash.bnbTileTitle")}
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
            /* No derived BSC address yet (first poll / key still deriving):
               a skeleton tile so the rail never collapses to a blank column. */
            <section className="card-padded space-y-4" aria-hidden>
              <div className="flex items-start justify-between gap-3">
                <div className="h-4 w-20 animate-pulse rounded bg-neutral-800" />
                <div className="h-4 w-24 animate-pulse rounded bg-neutral-800" />
              </div>
              <div className="h-9 w-full animate-pulse rounded-lg bg-neutral-800" />
            </section>
          )}
        </aside>
      </div>

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
          <div className="w-full max-w-md space-y-3">
            <div className="flex justify-end">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setBnbOpen(false)}
              >
                {t("dash.bnbClose")}
              </button>
            </div>
            <BnbAccount asset={bnbAsset} variant="full" lead />
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
