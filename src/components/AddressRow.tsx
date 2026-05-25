import { useEffect, useState, type MouseEvent } from "react";
import { CopyButton } from "./CopyButton";
import { ExportKeyModal } from "./ExportKeyModal";
import { getLabel, setLabel, shortAddress } from "../lib/labels";
import { hide } from "../lib/hidden";
import { formatExfer } from "../lib/rpc";

interface Props {
  address: string;
  index: number | null;
  imported: boolean;
  balance: number;
  utxoCount: number;
  truncated?: boolean;
  hidden?: boolean;
  onLabelChange?: () => void;
  onUnhide?: () => void;
}

export function AddressRow({
  address,
  index,
  imported,
  balance,
  utxoCount,
  truncated,
  hidden,
  onLabelChange,
  onUnhide,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => getLabel(address) ?? "");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [showExport, setShowExport] = useState(false);
  const label = getLabel(address);

  function commit() {
    setLabel(address, draft);
    setEditing(false);
    onLabelChange?.();
  }

  function openMenu(e: MouseEvent) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  return (
    <>
      <tr
        className={"hover:bg-neutral-900 " + (hidden ? "opacity-50" : "")}
        onContextMenu={openMenu}
      >
        <td className="px-5 py-4 font-mono text-sm text-neutral-400 tabular-nums">
          {imported ? <span className="pill pill-warn">imported</span> : index}
        </td>
        <td className="px-5 py-4">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <input
                className="input py-1.5 text-sm"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") setEditing(false);
                }}
                placeholder="e.g. deposits, savings…"
                autoFocus
              />
              <button type="button" className="btn-ghost" onClick={commit}>
                Save
              </button>
            </div>
          ) : label ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-left text-base font-medium text-neutral-100 hover:text-cyan-300"
              title="Click to rename"
            >
              {label}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-left text-sm text-neutral-500 hover:text-cyan-300"
              title="Click to label"
            >
              + label
            </button>
          )}
        </td>
        <td className="px-5 py-4">
          <div className="flex items-center gap-2">
            <code className="addr-xs">{shortAddress(address)}</code>
            <CopyButton text={address} className="btn-ghost text-xs" />
          </div>
        </td>
        <td className="px-5 py-4 text-sm text-neutral-400 tabular-nums">
          {utxoCount}
          {truncated && (
            <span
              className="ml-2 pill pill-warn"
              title="Node returned a truncated UTXO list (>1000)"
            >
              ⚠ truncated
            </span>
          )}
        </td>
        <td className="px-5 py-4 text-right">
          <div className="flex items-center justify-end gap-2">
            <div className="amount">{formatExfer(balance)}</div>
            <button
              type="button"
              onClick={(e) =>
                setMenu({ x: e.clientX, y: e.clientY })
              }
              className="rounded-md px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              title="Actions"
              aria-label="Address actions"
            >
              ⋯
            </button>
          </div>
        </td>
      </tr>

      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Export wallet.key…",
              onClick: () => {
                setMenu(null);
                setShowExport(true);
              },
            },
            {
              label: label ? "Rename label" : "Add label",
              onClick: () => {
                setMenu(null);
                setEditing(true);
              },
            },
            {
              label: "Copy address",
              onClick: () => {
                navigator.clipboard.writeText(address).catch(() => {});
                setMenu(null);
              },
            },
            hidden
              ? {
                  label: "Unhide address",
                  onClick: () => {
                    setMenu(null);
                    onUnhide?.();
                  },
                }
              : {
                  label: "Hide address",
                  danger: true,
                  onClick: () => {
                    setMenu(null);
                    if (
                      balance > 0 &&
                      !window.confirm(
                        "This address still holds funds. Hiding only removes it from the list — the key is kept and you can unhide it later. Hide anyway?",
                      )
                    ) {
                      return;
                    }
                    hide(address);
                    onLabelChange?.();
                  },
                },
          ]}
        />
      )}

      {showExport && (
        <ExportKeyModal
          address={address}
          index={index}
          onClose={() => setShowExport(false)}
        />
      )}
    </>
  );
}

function RowMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: { label: string; onClick: () => void; danger?: boolean }[];
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep the menu on-screen near the cursor.
  const style: React.CSSProperties = {
    top: Math.min(y, window.innerHeight - 8 - items.length * 40),
    left: Math.min(x, window.innerWidth - 220),
  };

  return (
    <div
      className="fixed z-50 w-52 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 py-1 shadow-xl fade-in"
      style={style}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          onClick={it.onClick}
          className={
            "block w-full px-4 py-2 text-left text-sm hover:bg-neutral-800 " +
            (it.danger ? "text-red-300" : "text-neutral-200")
          }
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
