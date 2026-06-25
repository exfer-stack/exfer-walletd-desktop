import type { ReactNode } from "react";
import logoUrl from "../assets/logo.png";
import { useT } from "../lib/i18n";
import { useInflight } from "../lib/inflight";

export type Tab =
  | "dashboard"
  | "agent"
  | "receive"
  | "send"
  | "swap"
  | "liquidity"
  | "activity"
  | "governance"
  | "settings";

/** Monochrome inline-SVG icons drawn with `currentColor`, so they
 * inherit the button's text color — no platform emoji rendering, no
 * stray color (the old ⚙ emoji rendered as a colored glyph). */
function Icon({ name }: { name: Tab }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "agent":
      // Speech bubble with a spark — the "AI assistant" glyph.
      return (
        <svg {...common}>
          <path d="M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4V5Z" />
          <path d="m12 7 .9 1.9 1.9.9-1.9.9L12 12.6l-.9-1.9-1.9-.9 1.9-.9L12 7Z" />
        </svg>
      );
    case "dashboard":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case "receive":
      return (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="m19 12-7 7-7-7" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="M12 19V5" />
          <path d="m5 12 7-7 7 7" />
        </svg>
      );
    case "swap":
      // Two arrows crossing — the universal "exchange / swap" glyph.
      return (
        <svg {...common}>
          <path d="M7 4v13" />
          <path d="m3.5 7.5 3.5-3.5 3.5 3.5" />
          <path d="M17 20V7" />
          <path d="m20.5 16.5-3.5 3.5-3.5-3.5" />
        </svg>
      );
    case "liquidity":
      // Stacked layers — the "pooled liquidity" glyph.
      return (
        <svg {...common}>
          <path d="m12 2 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5" />
          <path d="m3 17 9 5 9-5" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common}>
          <path d="M3 12h4l3 8 4-16 3 8h4" />
        </svg>
      );
    case "governance":
      // Ballot box with a check inside — the "vote" glyph.
      return (
        <svg {...common}>
          <rect x="3.5" y="7.5" width="17" height="13" rx="2" />
          <path d="M8 7.5V5.2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1V7.5" />
          <path d="m8.7 14 2.3 2.3 4.3-4.3" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
  }
}

interface Props {
  activeTab: Tab;
  onTabChange: (t: Tab) => void;
  children: ReactNode;
}

const TABS: { id: Tab }[] = [
  { id: "dashboard" },
  { id: "agent" },
  { id: "receive" },
  { id: "send" },
  { id: "swap" },
  { id: "liquidity" },
  { id: "activity" },
  { id: "governance" },
  { id: "settings" },
];

export function Layout({ activeTab, onTabChange, children }: Props) {
  const { t: tr } = useT();
  // Per-tab in-flight counts: swaps live on the Swap tab, LP add/remove ops on
  // the Liquidity tab. Engine off / no pool URL just yields zero (never throws).
  const inflight = useInflight();
  const badgeFor = (id: Tab): number => {
    if (id === "swap") return inflight.swaps.length;
    if (id === "liquidity") return inflight.lpOps.length;
    return 0;
  };
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-800 bg-black">
        <div className="flex items-center px-6 py-3">
          <img
            src={logoUrl}
            alt="exfer wallet"
            title="exfer wallet"
            className="mr-6 h-8 w-8 rounded-lg"
            draggable={false}
          />
          <nav className="flex items-center gap-1">
            {TABS.map((t) => {
              const active = t.id === activeTab;
              const badge = badgeFor(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onTabChange(t.id)}
                  className={
                    active
                      ? "inline-flex items-center gap-2 rounded-lg bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-300"
                      : "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
                  }
                >
                  <Icon name={t.id} />
                  {tr(`nav.${t.id}`)}
                  {badge > 0 && (
                    <span
                      className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-500 px-1 text-[10px] font-semibold leading-none text-black"
                      title={tr("nav.inflight", { n: badge })}
                    >
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="flex-1 overflow-auto bg-black">{children}</main>
    </div>
  );
}
