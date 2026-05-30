import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
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
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!password) {
      setError("Enter your wallet password.");
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
      // The wallet password both unlocks the key here AND encrypts the
      // exported .key — one secret, so it's the same passphrase you type
      // on exfer.dev when importing.
      await exportWalletKey({
        address,
        walletPassword: password,
        exportPassword: password,
        dest,
      });
      toast.success(
        "wallet.key exported",
        "On exfer.dev → Import wallet.key, enter your wallet password as the wallet.key passphrase.",
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

        <div className="banner-info text-sm">
          The file is encrypted with{" "}
          <strong>your wallet password</strong>. When you import it on
          exfer.dev, enter that same password as the “wallet.key
          passphrase”.
        </div>

        <div>
          <label className="label" htmlFor="exp-wallet-pw">
            Your wallet password
          </label>
          <input
            id="exp-wallet-pw"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
            autoComplete="current-password"
            autoFocus
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
            disabled={pending || !password}
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
  // Portal to <body>: rendered from inside a table row, so a bare overlay
  // div would be invalid HTML nested in <tbody>.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-6 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
