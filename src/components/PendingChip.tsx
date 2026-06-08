// A tiny, compact "more is on the way" indicator. Shown only when an
// address (or a set of addresses) has unconfirmed incoming funds sitting in
// the mempool — i.e. `pending_received` (net of `pending_spent`) > 0.
//
// It is PURELY informational: spendable / voting power everywhere still uses
// confirmed balance. This just tells the user a deposit is on its way, matching
// the Dashboard headline (which folds pending in) so the per-address screens
// don't look stale by comparison.
//
// Deliberately text-light: a small clock glyph + "+{amount}" only. The short
// "confirming" word lives in the tooltip, so the chip can't blow out the tight
// layouts (Receive header, Swap/LP balance lines, Governance power card) or
// strain the zh width.

import { formatBalanceCompact } from "../lib/rpc";
import { useT } from "../lib/i18n";

/** Net pending received (exfers) for a chip — pending_received − pending_spent,
 *  floored at 0 so an outgoing-only pending state shows nothing. */
export function netPending(e: {
  pending_received?: number;
  pending_spent?: number;
}): number {
  return Math.max(0, (e.pending_received ?? 0) - (e.pending_spent ?? 0));
}

export function PendingChip({
  amount,
  className,
}: {
  /** Net pending received, in exfers. Chip renders only when > 0. */
  amount: number;
  className?: string;
}) {
  const { t } = useT();
  if (!(amount > 0)) return null;
  const pretty = formatBalanceCompact(amount).replace(" EXFER", "");
  return (
    <span
      className={
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-xs tabular-nums text-amber-400/90" +
        (className ? ` ${className}` : "")
      }
      title={`+${formatBalanceCompact(amount)} ${t("pend.confirming")}`}
    >
      {/* Small clock glyph (lucide path, currentColor) — same stroke idiom as
          the app's other inline icons. */}
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
      +{pretty}
    </span>
  );
}
