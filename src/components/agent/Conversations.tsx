import { useEffect, useRef, useState } from "react";
import { useT, relativeTime } from "../../lib/i18n";
import type { Conversation } from "../../lib/conversationStore";

// The conversation switcher: a header title button opens this dropdown/popover
// (not a permanent sidebar — that would push the centered reading column off
// center). Each row is click-to-switch, double-click-to-rename, with a trash
// delete. Reuses the app's fixed-overlay dismissal idiom (scrim click + Escape).

export function Conversations({
  conversations,
  activeId,
  busy,
  onSelect,
  onRename,
  onDelete,
  onClose,
}: {
  conversations: Conversation[];
  activeId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editingId) setEditingId(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingId, onClose]);

  useEffect(() => {
    if (editingId) editRef.current?.select();
  }, [editingId]);

  const startRename = (c: Conversation) => {
    setEditingId(c.id);
    setDraft(c.title ?? "");
  };
  const commitRename = () => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-20" onMouseDown={onClose} data-testid="conversations">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("agent.conv.title")}
        className="card max-h-[70vh] w-full max-w-sm overflow-y-auto fade-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">{t("agent.conv.title")}</h2>
          {busy && <span className="pill pill-warn shrink-0">{t("agent.conv.switchBlocked")}</span>}
        </div>
        <ul className="divide-y divide-neutral-800/70">
          {conversations.length === 0 ? (
            <li className="px-4 py-6 text-center text-xs text-neutral-500">{t("agent.conv.empty")}</li>
          ) : (
            conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <li key={c.id}>
                  <div
                    className={`group flex items-center gap-2 px-4 py-2.5 ${active ? "bg-cyan-500/10" : "hover:bg-neutral-900/60"} ${
                      busy && !active ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                    }`}
                    onClick={() => {
                      if (editingId === c.id) return;
                      if (busy && !active) return;
                      onSelect(c.id);
                    }}
                    onDoubleClick={() => startRename(c)}
                    data-testid={`conv-row-${c.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      {editingId === c.id ? (
                        <input
                          ref={editRef}
                          className="input w-full py-1 text-sm"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename();
                            }
                          }}
                          data-testid={`conv-rename-${c.id}`}
                        />
                      ) : (
                        <>
                          <div className="truncate text-sm text-neutral-100">{c.title ?? t("agent.conv.untitled")}</div>
                          <div className="text-[11px] text-neutral-500">{relativeTime(t, c.updatedAt)}</div>
                        </>
                      )}
                    </div>
                    {editingId !== c.id && (
                      <button
                        type="button"
                        className="shrink-0 rounded p-1 text-neutral-500 opacity-0 transition hover:bg-neutral-800 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
                        aria-label={t("agent.conv.delete")}
                        title={t("agent.conv.delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(c.id);
                        }}
                        data-testid={`conv-delete-${c.id}`}
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                          <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
                          <path d="M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    )}
                  </div>
                </li>
              );
            })
          )}
        </ul>
        <div className="border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-600">{t("agent.conv.renameHint")}</div>
      </div>
    </div>
  );
}
