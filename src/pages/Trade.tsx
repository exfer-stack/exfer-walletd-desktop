import { useEffect, useState } from "react";
import { Swap } from "./Swap";
import { Liquidity } from "./Liquidity";
import { useT } from "../lib/i18n";
import { useResumeTarget, useInflight } from "../lib/inflight";

type Seg = "swap" | "liquidity";

/** Trade — one tab hosting the former Swap and Liquidity surfaces as two
 *  segments. Swap is the default. The active segment is mounted on its own so
 *  each page keeps the exact mount/unmount lifecycle it had as a top-level tab
 *  (an in-flight swap resumes via Activity, as before). */
export function Trade() {
  const { t } = useT();
  // Resuming a swap (from Activity / an in-flight row) primes resumeSwapId and
  // routes here — make sure the Swap segment is showing so the mounted Swap
  // page picks it up. Swap itself clears the target on mount.
  const { resumeSwapId } = useResumeTarget();
  const [seg, setSeg] = useState<Seg>("swap");
  useEffect(() => {
    if (resumeSwapId) setSeg("swap");
  }, [resumeSwapId]);

  // Per-segment in-flight counts, mirrored from the old per-tab badges.
  const inflight = useInflight();
  const badge: Record<Seg, number> = {
    swap: inflight.swaps.length,
    liquidity: inflight.lpOps.length,
  };

  return (
    <div className="flex h-full flex-col">
      {/* Segment strip — centered, matching the pages' content width. */}
      <div className="mx-auto w-full max-w-5xl px-8 pt-6">
        <div className="inline-flex overflow-hidden rounded-lg border border-neutral-700">
          {(["swap", "liquidity"] as const).map((s) => {
            const active = s === seg;
            const n = badge[s];
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSeg(s)}
                className={
                  "inline-flex items-center gap-2 px-5 py-2 text-sm font-medium transition " +
                  (active
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-200")
                }
              >
                {s === "swap" ? t("nav.swap") : t("nav.liquidity")}
                {n > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-500 px-1 text-[10px] font-semibold leading-none text-black">
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1">
        {seg === "swap" ? <Swap /> : <Liquidity />}
      </div>
    </div>
  );
}
