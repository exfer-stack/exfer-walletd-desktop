import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { getLabel, setLabel, shortAddress } from "../lib/labels";
import { formatExfer } from "../lib/rpc";

interface Props {
  address: string;
  index: number | null;
  imported: boolean;
  balance: number;
  utxoCount: number;
  truncated?: boolean;
  onLabelChange?: () => void;
}

export function AddressRow({
  address,
  index,
  imported,
  balance,
  utxoCount,
  truncated,
  onLabelChange,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => getLabel(address) ?? "");
  const label = getLabel(address);

  function commit() {
    setLabel(address, draft);
    setEditing(false);
    onLabelChange?.();
  }

  return (
    <tr className="hover:bg-neutral-50">
      <td className="px-5 py-4 font-mono text-sm text-neutral-500 tabular-nums">
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
            className="text-left text-base font-medium text-neutral-900 hover:text-indigo-700"
            title="Click to rename"
          >
            {label}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-left text-sm text-neutral-400 hover:text-indigo-700"
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
      <td className="px-5 py-4 text-sm text-neutral-600 tabular-nums">
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
        <div className="amount">{formatExfer(balance)}</div>
      </td>
    </tr>
  );
}
