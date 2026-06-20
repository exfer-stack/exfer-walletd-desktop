// Shared UI for the per-address display-form rollout (#36): a reactive short
// address that follows the user's hex/bech32m choice, and the little toggle
// that flips it. Default is hex; clicking the toggle re-spells THIS address as
// the checksummed "xf1…" form (and back). Display-only — same bytes, same
// funds; see lib/addressDisplay.ts.

import { useAddressDisplay } from "../lib/addressDisplay";
import { shortAddress } from "../lib/labels";
import { useT } from "../lib/i18n";

/** Truncated address that re-renders when its display form is toggled. */
export function AddressText({
  address,
  head,
  tail,
  className = "addr-xs",
}: {
  address: string;
  head?: number;
  tail?: number;
  className?: string;
}) {
  const { display } = useAddressDisplay(address);
  return <code className={className}>{shortAddress(display, head, tail)}</code>;
}

/** Small pill that flips one address between hex and the bech32m "xf" form.
 *  Label shows the form you'd switch TO, so the action reads clearly. */
export function FormToggle({
  address,
  className = "",
}: {
  address: string;
  className?: string;
}) {
  const { isBech32m, toggle } = useAddressDisplay(address);
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={(e) => {
        // These toggles sit inside clickable rows / list items; don't let the
        // flip also select the row or bubble into a row context menu.
        e.stopPropagation();
        e.preventDefault();
        toggle();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className={
        "shrink-0 rounded-md border border-neutral-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400 hover:border-cyan-500/60 hover:text-cyan-300 " +
        className
      }
      title={isBech32m ? t("addr.toHexTitle") : t("addr.toBech32mTitle")}
      aria-label={isBech32m ? t("addr.toHexTitle") : t("addr.toBech32mTitle")}
    >
      {isBech32m ? t("addr.hexLabel") : t("addr.bech32mLabel")}
    </button>
  );
}
