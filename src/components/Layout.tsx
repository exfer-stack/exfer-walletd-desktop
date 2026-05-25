import type { ReactNode } from "react";
import logoUrl from "../assets/logo.png";

export type Tab =
  | "dashboard"
  | "receive"
  | "send"
  | "activity"
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
    case "activity":
      return (
        <svg {...common}>
          <path d="M3 12h4l3 8 4-16 3 8h4" />
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

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "receive", label: "Receive" },
  { id: "send", label: "Send" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
];

export function Layout({ activeTab, onTabChange, children }: Props) {
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
                  {t.label}
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
