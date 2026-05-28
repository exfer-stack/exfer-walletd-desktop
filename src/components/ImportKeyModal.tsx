import { useState, type FormEvent } from "react";
import { importWalletKey } from "../lib/rpc";
import { devmock } from "../lib/devmock";
import { useToast } from "../lib/toast";
import { shortAddress } from "../lib/labels";

interface Props {
  onClose: () => void;
  onImported?: (address: string) => void;
}

export function ImportKeyModal({ onClose, onImported }: Props) {
  const toast = useToast();
  const [path, setPath] = useState<string | null>(null);
  const [filePassword, setFilePassword] = useState("");
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickFile() {
    setError(null);
    if (devmock.isActive()) {
      // Browser dev mode has no filesystem; fabricate a placeholder so
      // the modal flow is exercisable.
      setPath("(dev-mock) wallet.key");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Exfer wallet key", extensions: ["key"] }],
      });
      if (!picked) return; // cancelled
      setPath(typeof picked === "string" ? picked : picked[0]);
    } catch (err) {
      setError(`Couldn't open file dialog: ${String(err)}`);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!path) {
      setError("Choose a wallet.key file first.");
      return;
    }
    if (!filePassword) {
      setError("Enter the wallet.key passphrase (the one you set on export).");
      return;
    }
    setPending(true);
    try {
      const address = await importWalletKey({
        path,
        filePassword,
        label: label.trim() || undefined,
      });
      toast.success(
        "Address imported",
        `Added ${shortAddress(address)} — appears in Receive and Dashboard.`,
      );
      onImported?.(address);
      onClose();
    } catch (err) {
      setError(String(err).replace(/^Error: /, ""));
    } finally {
      setPending(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <form onSubmit={onSubmit} className="card-padded w-full max-w-lg space-y-5">
        <header className="space-y-1">
          <h2 className="text-xl font-semibold text-neutral-100">
            Import wallet.key
          </h2>
          <p className="text-sm text-neutral-400">
            Add an externally-held address to this wallet by importing its
            password-encrypted <span className="font-mono">.key</span> file.
            The address is sealed at rest the same way as HD addresses
            and appears alongside them as "Imported".
          </p>
        </header>

        <div className="banner-info text-sm">
          The 24-word recovery phrase will not back this address up —
          imported keys live outside the HD tree. Keep the original{" "}
          <span className="font-mono">.key</span> file and its passphrase
          if you ever need to restore on a fresh machine.
        </div>

        <div className="space-y-2">
          <label className="label">Wallet key file</label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={pickFile}
              disabled={pending}
            >
              Choose file…
            </button>
            <span className="addr-xs flex-1 truncate text-neutral-400">
              {path ?? "no file selected"}
            </span>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="imp-file-pw">
            wallet.key passphrase
          </label>
          <input
            id="imp-file-pw"
            type="password"
            className="input"
            value={filePassword}
            onChange={(e) => setFilePassword(e.target.value)}
            disabled={pending}
            autoComplete="off"
          />
          <p className="help">
            The passphrase the file was encrypted with. If this file came
            from this app, that's the wallet password you used at export.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="imp-label">
            Label (optional)
          </label>
          <input
            id="imp-label"
            type="text"
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={pending}
            placeholder="e.g. cold-savings"
            maxLength={64}
          />
        </div>

        {error && <div className="banner-error">{error}</div>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn"
            disabled={pending || !path || !filePassword}
          >
            {pending ? "Importing…" : "Import"}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

function Backdrop({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-6 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}
