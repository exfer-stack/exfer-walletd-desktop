// Shared UI for the per-address display-form rollout (#36): a reactive short
// address that follows the user's hex/bech32m choice, and the little toggle
// that flips it. Default is hex; clicking the toggle re-spells THIS address as
// the checksummed "xf1…" form (and back). Display-only — same bytes, same
// funds; see lib/addressDisplay.ts.

import { useEffect, useRef, useState } from "react";
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

/** Small "?" next to the toggle that opens a short popover explaining what the
 *  two address forms are, what the toggle does, and why the same address has
 *  two spellings. Click to open; outside-click or Escape closes. */
export function FormInfo() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((o) => !o);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-neutral-600 text-[10px] font-semibold text-neutral-400 hover:border-cyan-500/60 hover:text-cyan-300"
        aria-label={t("addr.formInfoAria")}
        title={t("addr.formInfoAria")}
      >
        ?
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-50 w-72 rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-left shadow-xl fade-in">
          <div className="mb-1 text-sm font-medium text-neutral-100">
            {t("addr.formInfoTitle")}
          </div>
          <p className="text-xs leading-relaxed text-neutral-400">
            {t("addr.formInfoBody")}
          </p>
        </div>
      )}
    </span>
  );
}
