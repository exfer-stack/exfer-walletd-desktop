import { useState } from "react";
import {
  rpc,
  formatExfer,
  splitBalanceCompact,
  MAX_ADDRESSES,
} from "../lib/rpc";
import type { GeneratedAddress } from "../lib/types";
import { AddressRow } from "../components/AddressRow";
import { useWallet, pollIntervalMs } from "../lib/wallet";
import { useToast } from "../lib/toast";
import { isHidden, unhide } from "../lib/hidden";

export function Dashboard() {
  const { balance: data, loading, error, refresh } = useWallet();
  const toast = useToast();
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
        "Address created",
        `${a.address.slice(0, 10)}… is ready to receive.`,
      );
    } catch (e) {
      toast.error("Couldn't create address", String(e));
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
        <div className="text-sm font-medium uppercase tracking-wide text-neutral-400">
          Total balance
        </div>
        <div
          className="amount-lg mt-2 flex items-baseline tracking-normal"
          title={
            data
              ? `Exact: ${formatExfer(visibleProjected)}` +
                (hasPending
                  ? ` · ${formatExfer(visibleTotal)} confirmed` +
                    (visiblePendingIn > 0
                      ? ` · ${formatExfer(visiblePendingIn)} awaiting confirmation`
                      : "") +
                    (visiblePendingOut > 0
                      ? ` · ${formatExfer(visiblePendingOut)} leaving`
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
                  aria-label="part of this balance is awaiting confirmation"
                />
              )}
            </>
          ) : (
            "—"
          )}
        </div>
        <div className="mt-1 text-sm text-neutral-400">
          across{" "}
          <span className="font-medium text-neutral-300">
            {visibleEntries.length}
          </span>{" "}
          {visibleEntries.length === 1 ? "address" : "addresses"}
        </div>
      </section>

      {error && !data && (
        <div className="banner-error flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={refresh} className="btn-secondary">
            Retry
          </button>
        </div>
      )}

      {/* Address list */}
      <section className="card overflow-hidden">
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-base font-semibold tracking-tight text-neutral-100">
            Addresses
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refreshAll}
              disabled={loading}
              className="btn-ghost"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={generateAddress}
              disabled={generating || atCap}
              className="btn-secondary"
              title={
                atCap
                  ? `This wallet is capped at ${MAX_ADDRESSES} addresses`
                  : "Each visible address adds a poll scan — more addresses refresh a little slower. Hide ones you're not watching to keep it fast."
              }
            >
              {generating ? "Generating…" : "+ New address"}
            </button>
          </div>
        </header>

        {/* Only surface the speed tradeoff once it's actually noticeable, so
            it reads as a tip, not a nag. Hidden addresses don't count. */}
        {!atCap && visibleEntries.length >= 3 && (
          <div className="border-b border-neutral-800/60 px-5 py-2 text-xs text-neutral-600">
            Auto-refreshing about every {pollSecs}s · hide addresses you're not
            watching to refresh faster.
          </div>
        )}

        {atCap && (
          <div className="border-b border-neutral-800 bg-neutral-900/60 px-5 py-2.5 text-xs text-neutral-400">
            You've reached the {MAX_ADDRESSES}-address limit for this wallet.
            Reuse an existing address to receive — one address can take any
            number of deposits.
          </div>
        )}

        {loading && !data ? (
          <SkeletonRows />
        ) : isEmpty ? (
          <div className="px-5 py-12 text-center">
            <div className="mx-auto max-w-md space-y-2">
              <div className="text-lg font-medium text-neutral-300">
                No addresses yet
              </div>
              <p className="text-sm text-neutral-400">
                Mint your first address and you're ready to receive EXFER.
              </p>
              <button
                type="button"
                onClick={generateAddress}
                disabled={generating}
                className="btn mt-3"
              >
                {generating ? "Generating…" : "+ Generate first address"}
              </button>
            </div>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="px-5 py-2.5 text-left">Label</th>
                <th className="px-5 py-2.5 text-left">Address</th>
                <th className="px-5 py-2.5 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {visibleEntries.map((e) => (
                <AddressRow
                  key={e.address}
                  address={e.address}
                  index={e.index}
                  imported={e.imported}
                  // Projected balance: confirmed + unconfirmed credit −
                  // unconfirmed debit, so the row reads as instant too.
                  balance={
                    e.balance +
                    (e.pending_received ?? 0) -
                    (e.pending_spent ?? 0)
                  }
                  pendingIn={e.pending_received}
                  hidden={isHidden(e.address)}
                  onLabelChange={refresh}
                  onUnhide={() => {
                    unhide(e.address);
                    refresh();
                  }}
                />
              ))}
            </tbody>
          </table>
        )}

        {hiddenEntries.length > 0 && (
          <div className="border-t border-neutral-800 px-5 py-2.5 text-xs text-neutral-400">
            {hiddenEntries.length} hidden{" "}
            {hiddenEntries.length === 1 ? "address" : "addresses"} ·{" "}
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              className="font-medium text-cyan-400 hover:underline"
            >
              {showHidden ? "hide them" : "show"}
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
