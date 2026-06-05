import { useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { CopyButton } from "./CopyButton";
import { ExportKeyModal } from "./ExportKeyModal";
import { RecoveryPhraseModal, DeleteAddressModal } from "./KeyringModals";
import { getLabel, setLabel, shortAddress } from "../lib/labels";
import { hide } from "../lib/hidden";
import { formatExfer, formatBalanceCompact } from "../lib/rpc";
import { useT } from "../lib/i18n";

interface Props {
  address: string;
  index: number | null;
  imported: boolean;
  balance: number;
  /** Unconfirmed incoming value (mempool), if any. */
  pendingIn?: number;
  hidden?: boolean;
  onLabelChange?: () => void;
  onUnhide?: () => void;
}

export function AddressRow({
  address,
  // `index` (legacy HD derivation index) isn't shown anymore — in the
  // keyring model every address is an independent key — but it's still
  // threaded to ExportKeyModal for the wallet.key filename default.
  index,
  balance,
  pendingIn,
  hidden,
  onLabelChange,
  onUnhide,
}: Props) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => getLabel(address) ?? "");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showPhrase, setShowPhrase] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
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
                placeholder={t("adr.labelPlaceholder")}
                autoFocus
              />
              <button type="button" className="btn-ghost" onClick={commit}>
                {t("adr.save")}
              </button>
            </div>
          ) : label ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-left text-base font-medium text-neutral-100 hover:text-cyan-300"
              title={t("adr.clickToRename")}
            >
              {label}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-left text-sm text-neutral-500 hover:text-cyan-300"
              title={t("adr.clickToLabel")}
            >
              {t("adr.addLabelInline")}
            </button>
          )}
        </td>
        <td className="px-5 py-4">
          <div className="flex items-center gap-2">
            <code className="addr-xs">{shortAddress(address)}</code>
            <CopyButton text={address} className="btn-ghost text-xs" />
          </div>
        </td>
        <td className="px-5 py-4 text-right">
          <div className="flex items-center justify-end gap-2">
            {/* `balance` is already the projected (confirmed + pending)
                amount. A quiet dot marks rows where part is unconfirmed;
                empty rows mute so the eye lands on the funded ones. */}
            {pendingIn != null && pendingIn > 0 && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-neutral-600"
                title={t("adr.pendingDot", { amt: formatExfer(pendingIn) })}
              />
            )}
            <div
              className={
                "amount whitespace-nowrap" +
                (balance === 0 ? " text-neutral-600" : "")
              }
              title={formatExfer(balance)}
            >
              {formatBalanceCompact(balance)}
            </div>
            <button
              type="button"
              onClick={(e) =>
                setMenu({ x: e.clientX, y: e.clientY })
              }
              className="rounded-md px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              title={t("adr.actions")}
              aria-label={t("adr.actionsAria")}
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
              label: t("adr.menuShowPhrase"),
              onClick: () => {
                setMenu(null);
                setShowPhrase(true);
              },
            },
            {
              label: t("adr.menuExportKey"),
              onClick: () => {
                setMenu(null);
                setShowExport(true);
              },
            },
            {
              label: label ? t("adr.menuRename") : t("adr.menuAddLabel"),
              onClick: () => {
                setMenu(null);
                setEditing(true);
              },
            },
            {
              label: t("adr.menuCopy"),
              onClick: () => {
                navigator.clipboard.writeText(address).catch(() => {});
                setMenu(null);
              },
            },
            hidden
              ? {
                  label: t("adr.menuUnhide"),
                  onClick: () => {
                    setMenu(null);
                    onUnhide?.();
                  },
                }
              : {
                  label: t("adr.menuHide"),
                  danger: true,
                  onClick: () => {
                    setMenu(null);
                    if (
                      balance > 0 &&
                      !window.confirm(t("adr.hideConfirm"))
                    ) {
                      return;
                    }
                    hide(address);
                    onLabelChange?.();
                  },
                },
            {
              label: t("adr.menuDelete"),
              danger: true,
              onClick: () => {
                setMenu(null);
                setShowDelete(true);
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

      {showPhrase && (
        <RecoveryPhraseModal
          address={address}
          onClose={() => setShowPhrase(false)}
        />
      )}

      {showDelete && (
        <DeleteAddressModal
          address={address}
          balance={balance}
          onClose={() => setShowDelete(false)}
          onDeleted={() => onLabelChange?.()}
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
    // Close on the next outside *mousedown* (not click): the click that
    // OPENED this menu is still in flight, so listening on "click" would
    // catch its own opening event and close immediately. mousedown for the
    // opening press already fired before this menu mounted.
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep the menu on-screen near the cursor.
  const style: React.CSSProperties = {
    top: Math.min(y, window.innerHeight - 8 - items.length * 40),
    left: Math.min(x, window.innerWidth - 220),
  };

  // Portal to <body>: a fixed-position menu must not live inside <tbody>
  // (invalid HTML — the browser reparents it and breaks interaction).
  return createPortal(
    <div
      className="fixed z-50 w-52 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 py-1 shadow-xl fade-in"
      style={style}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
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
    </div>,
    document.body,
  );
}
