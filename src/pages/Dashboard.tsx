import { Fragment, useState } from "react";
import {
  rpc,
  formatExfer,
  splitBalanceCompact,
  MAX_ADDRESSES,
} from "../lib/rpc";
import type { GeneratedAddress } from "../lib/types";
import { AddressRow } from "../components/AddressRow";
import { BnbAccount } from "../components/BnbAccount";
import { useWallet, pollIntervalMs } from "../lib/wallet";
import { useBnbAsset } from "../lib/bnb";
import { usePrice, usdValue } from "../lib/market";
import { useToast } from "../lib/toast";
import { isHidden, unhide } from "../lib/hidden";
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
  // The wallet's BNB (BSC) holding, shown as a passive overview card. Polls on
  // its own; announceDeposits:false so it never double-toasts with Swap.
  const bnbAsset = useBnbAsset({ announceDeposits: false });
  const [generating, setGenerating] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  async function refreshAll() {
    await refresh();
  }

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
  // Live auto-refresh interval. Only *visible* addresses cost a scan, so this
  // tracks the visible count and drops as you hide/remove addresses.
  const pollSecs = Math.round(pollIntervalMs(visibleEntries.length) / 1000);

  async function generateAddress() {
    setGenerating(true);
    try {
      const a = await rpc<GeneratedAddress>("generate_standard_address");
      await refreshAll();
      toast.success(
        t("dash.addrCreatedTitle"),
        t("dash.addrCreatedBody", { addr: a.address.slice(0, 10) }),
      );
    } catch (e) {
      toast.error(t("dash.addrCreateFailTitle"), humanizeError(e));
    } finally {
      setGenerating(false);
    }
  }

  const isEmpty = !loading && data !== null && data.entries.length === 0;
  const atCap = (data?.entries.length ?? 0) >= MAX_ADDRESSES;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-8 fade-in">
      {/* Hero — total balance */}
      <section className="card-padded">
        <div className="flex items-start justify-between gap-3">
          <div className="text-sm font-medium uppercase tracking-wide text-neutral-400">
            {t("dash.totalBalance")}
          </div>
          {/* Live EXFER/USD context: spot price + 24h change. Best-effort —
              hidden entirely until a price is available. */}
          {price && (
            <div className="flex items-center gap-2 text-right">
              <span className="font-mono text-sm tabular-nums text-neutral-300">
                <span className="text-neutral-500">EXFER</span>{" "}
                {usdValue(100_000_000, price.usd)}
              </span>
              <ChangePill pct={price.change24h} />
            </div>
          )}
        </div>
        <div
          className="amount-lg mt-2 flex items-baseline tracking-normal"
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
          {data ? (
            <>
              <span>{splitBalanceCompact(visibleProjected).whole}</span>
              {splitBalanceCompact(visibleProjected).frac && (
                <span className="text-neutral-500">
                  .{splitBalanceCompact(visibleProjected).frac}
                </span>
              )}
              <span className="ml-2.5 font-sans text-xl font-medium text-neutral-400">
                EXFER
              </span>
              {/* Quiet tell that part of this isn't confirmed yet — a small
                  dot, not a badge. The tooltip above carries the breakdown. */}
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
        </div>
        {/* The headline balance in USD (best-effort; hidden when price is
            null). Uses the projected total so it tracks the number above. */}
        {data && price && (
          <div className="mt-1 font-mono text-base tabular-nums text-neutral-400">
            ≈ {usdValue(visibleProjected, price.usd)}
          </div>
        )}
        <div className="mt-1 text-sm text-neutral-400">
          {t("dash.acrossPre")}{" "}
          <span className="font-medium text-neutral-300">
            {visibleEntries.length}
          </span>{" "}
          {visibleEntries.length === 1
            ? t("dash.addrUnit1")
            : t("dash.addrUnitN")}
        </div>
      </section>

      {/* BNB holding — shown on the overview so the user sees their BSC asset
          without opening Swap. Renders nothing until walletd hands us a derived
          address (engine-off / no HD seed just hides it). */}
      <BnbAccount asset={bnbAsset} variant="compact" />

      {error && !data && (
        <div className="banner-error flex items-center justify-between gap-3">
          <span>{humanizeError(error)}</span>
          <button type="button" onClick={refresh} className="btn-secondary">
            {t("dash.retry")}
          </button>
        </div>
      )}

      {/* Address list */}
      <section className="card overflow-hidden">
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-base font-semibold tracking-tight text-neutral-100">
            {t("dash.addresses")}
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refreshAll}
              disabled={loading}
              className="btn-ghost"
            >
              {loading ? t("dash.refreshing") : t("dash.refresh")}
            </button>
            <button
              type="button"
              onClick={generateAddress}
              disabled={generating || atCap}
              className="btn-secondary"
              title={
                atCap
                  ? t("dash.cappedTitle", { n: MAX_ADDRESSES })
                  : t("dash.newAddrTitle")
              }
            >
              {generating ? t("dash.generating") : t("dash.newAddr")}
            </button>
          </div>
        </header>

        {/* Only surface the speed tradeoff once it's actually noticeable, so
            it reads as a tip, not a nag. Hidden addresses don't count. */}
        {!atCap && visibleEntries.length >= 3 && (
          <div className="border-b border-neutral-800/60 px-5 py-2 text-xs text-neutral-600">
            {t("dash.autoRefreshTip", { secs: pollSecs })}
          </div>
        )}

        {atCap && (
          <div className="border-b border-neutral-800 bg-neutral-900/60 px-5 py-2.5 text-xs text-neutral-400">
            {t("dash.atCapNote", { n: MAX_ADDRESSES })}
          </div>
        )}

        {loading && !data ? (
          <SkeletonRows />
        ) : isEmpty ? (
          <div className="px-5 py-12 text-center">
            <div className="mx-auto max-w-md space-y-2">
              <div className="text-lg font-medium text-neutral-300">
                {t("dash.emptyTitle")}
              </div>
              <p className="text-sm text-neutral-400">
                {t("dash.emptyBody")}
              </p>
              <button
                type="button"
                onClick={generateAddress}
                disabled={generating}
                className="btn mt-3"
              >
                {generating ? t("dash.generating") : t("dash.genFirst")}
              </button>
            </div>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="px-5 py-2.5 text-left">{t("dash.colLabel")}</th>
                <th className="px-5 py-2.5 text-left">{t("dash.colAddress")}</th>
                <th className="px-5 py-2.5 text-right">{t("dash.colBalance")}</th>
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
                // Per-address ≈$ rides on a borderless caption row right under
                // the address row, right-aligned beneath the balance column.
                // Best-effort: only when a live price is available and the row
                // actually holds something.
                const usd =
                  price && projected > 0
                    ? usdValue(projected, price.usd)
                    : null;
                return (
                  <Fragment key={e.address}>
                    <AddressRow
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
                    {usd && (
                      <tr
                        className={
                          "!border-t-transparent " +
                          (hidden ? "opacity-50" : "")
                        }
                        aria-hidden
                      >
                        <td className="px-5 pb-3 pt-0" colSpan={2} />
                        <td className="px-5 pb-3 pt-0 text-right">
                          <span className="font-mono text-xs tabular-nums text-neutral-500">
                            ≈ {usd}
                          </span>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-neutral-800">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="h-4 w-6 animate-pulse rounded bg-neutral-800" />
          <div className="h-4 w-24 animate-pulse rounded bg-neutral-800" />
          <div className="h-4 flex-1 animate-pulse rounded bg-neutral-800" />
          <div className="h-4 w-28 animate-pulse rounded bg-neutral-800" />
        </div>
      ))}
    </div>
  );
}
