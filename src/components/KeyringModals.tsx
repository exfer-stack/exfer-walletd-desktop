// Keyring-model lifecycle modals: per-address recovery phrase, address
// deletion, and whole-wallet encrypted-vault backup / restore.
//
// These replace the HD-seed-era "one mnemonic for the whole wallet" mental
// model: every address is its own key, so backup is either a single sealed
// vault file (all keys) or a per-address recovery phrase / private key.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { rpc, exportVaultFile, importVaultFile } from "../lib/rpc";
import { devmock } from "../lib/devmock";
import { useToast } from "../lib/toast";
import { CopyButton } from "./CopyButton";
import { shortAddress } from "../lib/labels";

const AUTO_HIDE_MS = 30_000;

// ---------------------------------------------------------------------------
// Shared backdrop
// ---------------------------------------------------------------------------

function Backdrop({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Portal to <body>: these modals are rendered from inside table rows
  // (<tbody>), where a bare <div> is invalid HTML and the browser reparents
  // it. A portal keeps the overlay a valid, top-level child of <body>.
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

// ---------------------------------------------------------------------------
// Per-address recovery phrase (this address's OWN 24 words)
// ---------------------------------------------------------------------------

export function RecoveryPhraseModal({
  address,
  onClose,
}: {
  address: string;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [words, setWords] = useState<string[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function reveal(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await rpc<{ address: string; mnemonic: string[] }>(
        "reveal_address_mnemonic",
        { address, passphrase: password },
      );
      setWords(res.mnemonic);
      setPassword("");
      timerRef.current = setTimeout(() => setHidden(true), AUTO_HIDE_MS);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <div className="card-padded w-full max-w-xl space-y-5">
        <header>
          <h2 className="text-xl font-semibold text-neutral-100">
            Recovery phrase for this address
          </h2>
          <p className="mt-1 text-sm text-neutral-400">
            This address's own 24 words (<span className="font-mono">{shortAddress(address)}</span>).
            They restore <strong>just this one address</strong> — not the
            whole wallet. Anyone who reads them can spend what it holds.
          </p>
        </header>

        {!words ? (
          <form onSubmit={reveal} className="space-y-4">
            <div className="banner-warn space-y-1 text-sm text-amber-200">
              <div className="font-semibold">Before you continue</div>
              <ul className="ml-4 list-disc space-y-1">
                <li>Make sure nobody can see your screen.</li>
                <li>Write them on paper; never paste them into a website or chat.</li>
              </ul>
            </div>
            <div>
              <label className="label" htmlFor="rec-pw">
                Your wallet password
              </label>
              <input
                id="rec-pw"
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={pending}
                autoComplete="current-password"
              />
            </div>
            {error && <div className="banner-error">{error}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={pending}>
                Cancel
              </button>
              <button type="submit" className="btn-danger" disabled={pending || password === ""}>
                {pending ? "Verifying…" : "Show recovery phrase"}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="banner-error text-sm">
              Write these down on paper. Do <strong>not</strong> screenshot them.
            </div>
            <ol
              className={
                "grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 sm:grid-cols-3 " +
                (hidden ? "blur-md select-none pointer-events-none" : "")
              }
            >
              {words.map((w, i) => (
                <li key={i} className="flex gap-2 font-mono text-sm">
                  <span className="w-5 text-right text-neutral-600">{i + 1}.</span>
                  <span className="text-neutral-100">{w}</span>
                </li>
              ))}
            </ol>
            {hidden && (
              <div className="flex justify-center">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setHidden(false);
                    if (timerRef.current) clearTimeout(timerRef.current);
                    timerRef.current = setTimeout(() => setHidden(true), AUTO_HIDE_MS);
                  }}
                >
                  Show again
                </button>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <CopyButton text={words.join(" ")} className="btn-secondary" />
              <button type="button" className="btn" onClick={onClose}>
                Done
              </button>
            </div>
            <p className="text-xs text-neutral-400">
              Auto-hides after 30 seconds. Closing this dialog clears them from memory.
            </p>
          </div>
        )}
      </div>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Delete an address (destructive — erases the key)
// ---------------------------------------------------------------------------

export function DeleteAddressModal({
  address,
  balance,
  onClose,
  onDeleted,
}: {
  address: string;
  balance: number;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const funded = balance > 0;
  const [password, setPassword] = useState("");
  const [force, setForce] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await rpc("delete_address", {
        address,
        passphrase: password,
        force: funded ? force : false,
      });
      toast.success("Address deleted", `${shortAddress(address)} was removed from this wallet.`);
      onDeleted();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <form onSubmit={onSubmit} className="card-padded w-full max-w-lg space-y-5">
        <header>
          <h2 className="text-xl font-semibold text-neutral-100">Delete address</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Permanently remove <span className="font-mono">{shortAddress(address)}</span> and
            erase its key from this wallet. This <strong>cannot be undone</strong> unless you
            have backed the key up (recovery phrase, private key, or vault).
          </p>
        </header>

        {funded && (
          <div className="banner-error space-y-2 text-sm">
            <div className="font-semibold">This address still holds funds.</div>
            <p>
              Deleting it strands those funds unless you've backed the key up. Sweep it
              to another address first if you can.
            </p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              <span>I understand the funds will be unrecoverable. Delete anyway.</span>
            </label>
          </div>
        )}

        <div>
          <label className="label" htmlFor="del-pw">
            Your wallet password
          </label>
          <input
            id="del-pw"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
            autoComplete="current-password"
          />
        </div>

        {error && <div className="banner-error">{error}</div>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn-danger"
            disabled={pending || password === "" || (funded && !force)}
          >
            {pending ? "Deleting…" : "Delete address"}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Vault backup (export the whole keyring as one encrypted file)
// ---------------------------------------------------------------------------

export function VaultBackupModal({ onClose }: { onClose: () => void }) {
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

    let dest = "exfer-wallet-backup.vault";
    if (!devmock.isActive()) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const picked = await save({
          defaultPath: dest,
          filters: [{ name: "Exfer wallet vault", extensions: ["vault"] }],
        });
        if (!picked) return; // cancelled
        dest = picked;
      } catch (err) {
        setError(`Couldn't open save dialog: ${String(err)}`);
        return;
      }
    }

    setPending(true);
    try {
      await exportVaultFile({ walletPassword: password, dest });
      toast.success(
        "Backup saved",
        "One encrypted file holds every address. Restore it with this same password.",
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
        <header>
          <h2 className="text-xl font-semibold text-neutral-100">Back up wallet</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Save every address in this wallet to one encrypted{" "}
            <span className="font-mono">.vault</span> file. No seed phrase to copy —
            this single file is the whole backup.
          </p>
        </header>

        <div className="banner-info text-sm">
          The file is encrypted with <strong>your wallet password</strong>. You'll need
          that same password to restore it. Keep both the file and the password safe.
        </div>

        <div>
          <label className="label" htmlFor="vault-pw">
            Your wallet password
          </label>
          <input
            id="vault-pw"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
            autoComplete="current-password"
          />
        </div>

        {error && <div className="banner-error">{error}</div>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={pending || password === ""}>
            {pending ? "Saving…" : "Save backup file"}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Vault restore (import a .vault file into this wallet)
// ---------------------------------------------------------------------------

export function VaultRestoreModal({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  onRestored: () => void;
}) {
  const toast = useToast();
  const [path, setPath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickFile() {
    setError(null);
    if (devmock.isActive()) {
      setPath("dev-mock-backup.vault");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [{ name: "Exfer wallet vault", extensions: ["vault"] }],
      });
      if (typeof picked === "string") setPath(picked);
    } catch (err) {
      setError(`Couldn't open file dialog: ${String(err)}`);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!path) {
      setError("Choose a backup file first.");
      return;
    }
    setPending(true);
    try {
      const count = await importVaultFile({ path, filePassword: password });
      toast.success(
        "Backup restored",
        count === 0
          ? "Every address in the file was already in this wallet."
          : `${count} address${count === 1 ? "" : "es"} restored.`,
      );
      onRestored();
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
        <header>
          <h2 className="text-xl font-semibold text-neutral-100">Restore from backup</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Load addresses from a <span className="font-mono">.vault</span> file. Enter
            the password the backup was created with. Addresses already in this wallet
            are skipped.
          </p>
        </header>

        <div>
          <label className="label">Backup file</label>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary" onClick={pickFile} disabled={pending}>
              Choose file…
            </button>
            <span className="truncate text-sm text-neutral-400">
              {path ?? "no file selected"}
            </span>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="restore-pw">
            Backup password
          </label>
          <input
            id="restore-pw"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
            autoComplete="current-password"
          />
        </div>

        {error && <div className="banner-error">{error}</div>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={pending || !path || password === ""}>
            {pending ? "Restoring…" : "Restore"}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}
