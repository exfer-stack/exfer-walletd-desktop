import { useEffect } from "react";

/** Close-on-Escape for modals / dismissible surfaces. A single window-level
 *  keydown listener so dismissal works regardless of which element is focused
 *  (the older per-input onKeyDown only fired while that field had focus). Pass
 *  the modal's close handler; it re-subscribes when that handler changes. */
export function useEscapeKey(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape]);
}
