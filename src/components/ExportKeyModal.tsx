import { useState, type FormEvent } from "react";
import { exportWalletKey } from "../lib/rpc";
import { devmock } from "../lib/devmock";
import { useToast } from "../lib/toast";
import { shortAddress } from "../lib/labels";

interface Props {
  address: string;
  index: number | null;
  onClose: () => void;
}

export function ExportKeyModal({ address, index, onClose }: Props) {
  const toast = useToast();
  const [walletPassword, setWalletPassword] = useState("");
  const [exportPassword, setExportPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (exportPassword.length < 6) {
      setError("File password must be at least 6 characters.");
      return;
    }
    if (exportPassword !== confirm) {
      setError("File passwords don't match.");
      return;
    }

    // Pick a destination path via the OS save dialog (Tauri). In browser
    // dev mode there's no dialog/filesystem, so use a placeholder.
    let dest = `${index != null ? `address-${index}` : "imported"}.key`;
    if (!devmock.isActive()) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const picked = await save({
          defaultPath: dest,
          filters: [{ name: "Exfer wallet key", extensions: ["key"] }],
        });
        if (!picked) return; // user cancelled
        dest = picked;
      } catch (err) {
        setError(`Couldn't open save dialog: ${String(err)}`);
        return;
      }
    }

    setPending(true);
    try {
      await exportWalletKey({
        address,
        walletPassword,
        exportPassword,
        dest,
      });
      toast.success(
        "wallet.key exported",
        "Import it on exfer.dev → Import wallet.key, using the file password you just set.",
      );
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <form onSubmit={onSubmit} className="card-padded w-full max-w-lg space-y-5">
        <header className="space-y-1">
          <h2 className="text-xl font-semibold text-neutral-100">
            Export wallet.key
          </h2>
          <p className="text-sm text-neutral-400">
            A password-encrypted key file for{" "}
            <span className="font-mono text-neutral-300">
              {index != null ? `Address ${index}` : "this address"}
            </span>{" "}
            (<span className="font-mono">{shortAddress(address)}</span>).
            Importable on exfer.dev and the Exfer CLI.
          </p>
        </header>

        <div className="banner-warn space-y-1 text-sm">
          <div className="font-semibold">Two passwords, on purpose</div>
          <p>
            Your <strong>wallet password</strong> unlocks the key here. The{" "}
            <strong>file password</strong> encrypts the exported{" "}
            <span className="font-mono">.key</span> — you'll type it again on
            exfer.dev to import. They can differ.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="exp-wallet-pw">
            Your wallet password
          </label>
          <input
            id="exp-wallet-pw"
            type="password"
            className="input"
            value={walletPassword}
            onChange={(e) => setWalletPassword(e.target.value)}
            disabled={pending}
            autoComplete="current-password"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="exp-file-pw">
              File password
            </label>
            <input
              id="exp-file-pw"
              type="password"
              className="input"
              value={exportPassword}
              onChange={(e) => setExportPassword(e.target.value)}
              disabled={pending}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="label" htmlFor="exp-file-pw2">
              Confirm file password
            </label>
            <input
              id="exp-file-pw2"
              type="password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={pending}
              autoComplete="new-password"
            />
          </div>
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
            disabled={pending || !walletPassword || !exportPassword}
          >
            {pending ? "Exporting…" : "Choose location & export"}
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
