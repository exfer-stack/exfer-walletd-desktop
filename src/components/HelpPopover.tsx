// A tiny "?" affordance that toggles a small explanatory popover. Used to move
// long, always-on helper paragraphs (where does this address come from? how do
// I import it into MetaMask?) off the surface and behind a one-click reveal, so
// the default view stays low on reading cost. Strings are passed in already
// translated — the component is i18n-agnostic and reusable anywhere.
//
// The panel is rendered through a portal to <body> with fixed positioning, for
// two reasons that bit us when it lived inline as an absolutely-positioned
// child: (1) host cards use `overflow-hidden` (and the BNB console opens inside
// a centred modal), which clipped the panel to a few characters per line; a
// portal escapes every `overflow` ancestor. (2) An `uppercase` ancestor (e.g.
// the Dashboard tile label) made `text-transform` cascade into the panel and
// SHOUT the whole paragraph — a body at <body> root inherits none of that. The
// panel also flips left / clamps to the viewport so it never runs off-screen.

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const PANEL_W = 256; // w-64
const MARGIN = 8; // keep this far from any viewport edge
const GAP = 6; // gap between the trigger and the panel

export function HelpPopover({
  title,
  body,
  label = "?",
}: {
  title: string;
  body: string;
  /** Accessible label for the trigger (defaults to the glyph). */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measure once the panel is open (and on the layout pass, so the trigger has
  // its final box). Position below the trigger; flip above when there's no room
  // beneath, and clamp horizontally so the fixed-width panel stays on-screen.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    let left = r.left;
    if (left + PANEL_W > window.innerWidth - MARGIN) {
      left = window.innerWidth - MARGIN - PANEL_W;
    }
    if (left < MARGIN) left = MARGIN;
    // ~150px is a safe estimate for the tallest help body; flip up near the bottom.
    const top =
      r.bottom + GAP + 150 > window.innerHeight - MARGIN
        ? Math.max(MARGIN, r.top - GAP - 150)
        : r.bottom + GAP;
    setPos({ top, left });
  }, [open]);

  return (
    <span className="inline-flex align-middle">
      <button
        ref={triggerRef}
        type="button"
        aria-label={title}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="grid h-[15px] w-[15px] place-items-center rounded-full border border-neutral-600 text-[10px] font-semibold normal-case leading-none text-neutral-400 transition hover:border-cyan-400 hover:text-cyan-300"
      >
        {label}
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            {/* Click-away scrim — closes on any outside click. */}
            <div
              className="fixed inset-0 z-[60]"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            />
            <div
              role="dialog"
              style={{ top: pos.top, left: pos.left, width: PANEL_W }}
              className="fixed z-[61] rounded-lg border border-neutral-700 bg-neutral-900 p-3 text-left normal-case shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-1 text-xs font-semibold text-neutral-100">{title}</div>
              <div className="text-xs leading-relaxed text-neutral-400">{body}</div>
            </div>
          </>,
          document.body,
        )}
    </span>
  );
}
