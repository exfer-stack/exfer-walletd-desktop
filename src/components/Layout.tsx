import type { ReactNode } from "react";

export type Tab = "dashboard" | "generate" | "transfer" | "settings";

interface Props {
  activeTab: Tab;
  onTabChange: (t: Tab) => void;
  children: ReactNode;
}

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "generate", label: "Generate" },
  { id: "transfer", label: "Transfer" },
  { id: "settings", label: "Settings" },
];

export function Layout({ activeTab, onTabChange, children }: Props) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-200 bg-white">
        <div className="flex items-center gap-1 px-4 py-2">
          <span className="mr-4 text-sm font-semibold text-neutral-800">
            exfer-wallet
          </span>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTabChange(t.id)}
              className={
                t.id === activeTab
                  ? "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white"
                  : "btn-ghost"
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <main className="flex-1 overflow-auto bg-neutral-50">{children}</main>
    </div>
  );
}
