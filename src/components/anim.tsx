// Shared "alive" UI bits ported from the mobile wallet so the desktop swap /
// liquidity flows move the same way: a staged progress stepper whose connector
// chevrons flow into the active (spinner) node, a success disc→check→ring
// choreography, and the overlapped EXFER·BNB pair-coin hero. The animation
// classes (swap-flow / swap-node-active / success-*) live in index.css and are
// gated behind prefers-reduced-motion.

import tokenCoin from "../assets/exfer-token.png";

/** The EXFER token coin — the proper mark (a centered glyph on a black disc)
 *  with a thin white ring so it reads as a coin on the dark surface, matching
 *  the mobile wallet. Use this everywhere EXFER appears as a coin (never the
 *  bare wordmark logo). */
export function ExferMark({ size = 20 }: { size?: number }) {
  return (
    <img
      src={tokenCoin}
      alt=""
      width={size}
      height={size}
      className="block flex-none rounded-full"
      style={{ boxSizing: "border-box", border: "1px solid rgba(255,255,255,0.55)" }}
    />
  );
}

/** A small border-spinner for the active stepper node. */
function Spin({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

const Check = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 13l4 4L19 7" />
  </svg>
);
const Chevron = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/**
 * Horizontal staged progress stepper: N nodes joined by chevron connectors that
 * flow into the active stage. The node at index `doneCount` is the active
 * (spinner + pulsing ring) one; earlier nodes are done (green ✓); later are
 * muted dots. Shared by the swap and liquidity progress screens.
 */
export function StagedStepper({
  labels,
  doneCount,
}: {
  labels: string[];
  doneCount: number;
}) {
  const last = labels.length - 1;
  return (
    <div>
      <div className="flex items-center px-1">
        {labels.map((_, i) => {
          const done = i < doneCount;
          const active = i === doneCount;
          const node = (
            <div
              key={`n${i}`}
              className={
                "grid h-[30px] w-[30px] flex-none place-items-center rounded-full " +
                (done
                  ? "bg-emerald-400 text-black"
                  : active
                    ? "swap-node-active bg-cyan-500 text-black"
                    : "border border-neutral-700 bg-neutral-800 text-neutral-500")
              }
            >
              {done ? (
                <Check />
              ) : active ? (
                <Spin />
              ) : (
                <span className="h-[7px] w-[7px] rounded-full bg-neutral-600 opacity-50" />
              )}
            </div>
          );
          if (i === last) return node;
          const connDone = i + 1 < doneCount;
          const connActive = i + 1 === doneCount;
          const conn = (
            <div key={`c${i}`} className="flex h-[30px] flex-1 items-center justify-center">
              <div
                className={
                  "flex gap-px " +
                  (connActive ? "swap-flow " : "") +
                  (connDone
                    ? "text-emerald-400"
                    : connActive
                      ? "text-cyan-400"
                      : "text-neutral-600 opacity-40")
                }
              >
                <Chevron />
                <Chevron />
                <Chevron />
              </div>
            </div>
          );
          return [node, conn];
        })}
      </div>
      <div className="mt-2 flex">
        {labels.map((label, i) => (
          <span
            key={i}
            className={
              "flex-1 text-[11.5px] " +
              (i === 0 ? "text-left" : i === last ? "text-right" : "text-center") +
              " " +
              (i === doneCount
                ? "font-bold text-cyan-300"
                : i < doneCount
                  ? "font-semibold text-neutral-100"
                  : "font-medium text-neutral-500")
            }
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A success mark: a disc scales in, a checkmark strokes itself on, a ring
 *  pulses out — for swap / LP completion (replaces a plain text banner). */
export function SuccessMark({ size = 64 }: { size?: number }) {
  return (
    <span
      className="relative inline-grid place-items-center"
      style={{ width: size, height: size }}
    >
      <span className="success-ring pointer-events-none absolute inset-0 rounded-full border-2 border-emerald-400" />
      <span
        className="success-disc grid place-items-center rounded-full"
        style={{ width: size, height: size, background: "rgb(52 211 153 / 0.18)" }}
      >
        <svg
          viewBox="0 0 24 24"
          width={Math.round(size * 0.47)}
          height={Math.round(size * 0.47)}
          fill="none"
          stroke="#34d399"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path className="success-check" pathLength={1} d="M5 12.5l4.2 4.2L19 6.5" />
        </svg>
      </span>
    </span>
  );
}

/** The BNB rhombus on its gold disc (same mark as the swap token chip). */
function BnbMark({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 126.61 126.61" className="block" aria-hidden>
      <circle cx="63.3" cy="63.3" r="63.3" fill="#F0B90B" />
      <g fill="#fff" transform="translate(63.3 63.3) scale(0.62) translate(-63.3 -63.3)">
        <path d="M38.73 53.2 63.32 28.62 87.92 53.22 102.22 38.91 63.32 0 24.42 38.9z" />
        <path d="M0 63.31 14.3 49l14.31 14.31L14.3 77.61z" />
        <path d="M38.73 73.41 63.32 98l24.6-24.6 14.31 14.29-.01.01-38.9 38.91-38.91-38.88-.02-.02z" />
        <path d="M98 63.31 112.3 49l14.31 14.3-14.31 14.32z" />
        <path d="M77.83 63.3 63.32 48.78 52.59 59.51l-1.24 1.23-2.54 2.54-.02.02.02.03 14.51 14.5z" />
      </g>
    </svg>
  );
}

/** Overlapped EXFER + BNB coins — the pool's pair, the hero of the LP empty
 *  state. EXFER sits in front; both carry a soft drop shadow. */
export function PairCoins({ size = 56 }: { size?: number }) {
  const shadow = { filter: "drop-shadow(0 3px 8px rgba(0,0,0,.4))" };
  return (
    <span className="inline-flex items-center">
      <span className="relative z-[2] inline-grid" style={shadow}>
        <ExferMark size={size} />
      </span>
      <span className="relative z-[1] -ml-4 inline-grid" style={shadow}>
        <BnbMark size={size} />
      </span>
    </span>
  );
}
