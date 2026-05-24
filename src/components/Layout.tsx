import type { ReactNode } from "react";

export type Tab =
  | "dashboard"
  | "receive"
  | "send"
  | "activity"
  | "settings";

interface Props {
  activeTab: Tab;
  onTabChange: (t: Tab) => void;
  children: ReactNode;
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "◇" },
  { id: "receive", label: "Receive", icon: "↓" },
  { id: "send", label: "Send", icon: "↑" },
  { id: "activity", label: "Activity", icon: "≡" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

export function Layout({ activeTab, onTabChange, children }: Props) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-200 bg-white">
        <div className="flex items-center px-6 py-3">
          <div className="mr-8 flex items-baseline gap-2">
            <span className="text-lg font-semibold tracking-tight text-neutral-900">
              exfer
            </span>
            <span className="text-sm font-medium text-neutral-400">wallet</span>
          </div>
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
                      ? "inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
                      : "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
                  }
                >
                  <span aria-hidden className="text-base leading-none">
                    {t.icon}
                  </span>
                  {t.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="flex-1 overflow-auto bg-neutral-50">{children}</main>
    </div>
  );
}
