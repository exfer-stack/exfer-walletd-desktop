import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info" | "incoming";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastApi {
  push: (t: Omit<Toast, "id">, ttlMs?: number) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  incoming: (title: string, message?: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const DEFAULT_TTL = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id">, ttlMs: number = DEFAULT_TTL) => {
      const id = ++seq.current;
      setToasts((ts) => [...ts, { ...t, id }]);
      // incoming deposits linger a touch longer
      const ttl = t.kind === "incoming" ? Math.max(ttlMs, 7000) : ttlMs;
      window.setTimeout(() => remove(id), ttl);
    },
    [remove],
  );

  const api: ToastApi = {
    push,
    success: (title, message) => push({ kind: "success", title, message }),
    error: (title, message) => push({ kind: "error", title, message }, 8000),
    info: (title, message) => push({ kind: "info", title, message }),
    incoming: (title, message) => push({ kind: "incoming", title, message }),
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <ToastHost toasts={toasts} onClose={remove} />
    </ToastCtx.Provider>
  );
}

function ToastHost({
  toasts,
  onClose,
}: {
  toasts: Toast[];
  onClose: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onClose={() => onClose(t.id)} />
      ))}
    </div>
  );
}

const KIND_STYLE: Record<
  ToastKind,
  { ring: string; icon: ReactNode; iconWrap: string; title: string }
> = {
  success: {
    ring: "border-emerald-500/25",
    iconWrap: "bg-emerald-500/15 text-emerald-300",
    icon: <span aria-hidden>✓</span>,
    title: "text-neutral-100",
  },
  error: {
    ring: "border-red-500/30",
    iconWrap: "bg-red-500/15 text-red-300",
    icon: <span aria-hidden>!</span>,
    title: "text-neutral-100",
  },
  info: {
    ring: "border-cyan-500/25",
    iconWrap: "bg-cyan-500/15 text-cyan-300",
    icon: <span aria-hidden>i</span>,
    title: "text-neutral-100",
  },
  incoming: {
    ring: "border-emerald-500/30",
    iconWrap: "bg-emerald-500/15 text-emerald-300",
    icon: <span aria-hidden>↓</span>,
    // The amount is the message — render it as money: emerald, mono, tabular.
    title: "font-mono tabular-nums tracking-tight text-emerald-300",
  },
};

function ToastCard({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const s = KIND_STYLE[toast.kind];
  return (
    <div
      className={
        "pointer-events-auto flex items-start gap-3 rounded-xl border bg-neutral-950 px-4 py-3 shadow-lg fade-in " +
        s.ring
      }
      role="status"
    >
      <div
        className={
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold " +
          s.iconWrap
        }
      >
        {s.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className={"text-sm font-semibold " + s.title}>{toast.title}</div>
        {toast.message && (
          <div className="mt-0.5 break-words text-xs text-neutral-400">
            {toast.message}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 rounded-md px-1 text-neutral-500 hover:text-neutral-200"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
