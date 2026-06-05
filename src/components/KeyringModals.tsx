// Keyring-model lifecycle modals: address deletion and whole-wallet
// encrypted-vault backup / restore. (The desktop does NOT expose recovery
// phrases — backup is the sealed vault file or a per-address PRIVATE KEY only.)

import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { rpc, exportVaultFile, importVaultFile } from "../lib/rpc";
import { devmock } from "../lib/devmock";
import { useToast } from "../lib/toast";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { shortAddress } from "../lib/labels";
import { useEscapeKey } from "../lib/useEscapeKey";

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
  useEscapeKey(onClose);
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
// Delete an address (destructive — erases the key)
// ---------------------------------------------------------------------------

interface LpPosition {
  has_position: boolean;
  shares: string;
  pool_share_pct: number;
  value_bnb: string;
  value_exfer: string;
}

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
  const { t } = useT();
  const toast = useToast();
  const funded = balance > 0;
  const [password, setPassword] = useState("");
  const [force, setForce] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // LP shares are off-chain and invisible to walletd's on-chain funds guard, so
  // a "balance 0" address can still own a position. Probe it on open and block
  // the (irreversible) delete behind an explicit acknowledgement.
  const [lp, setLp] = useState<LpPosition | null>(null);
  const [lpAck, setLpAck] = useState(false);
  // Until the probe resolves we don't know whether this address owns LP shares,
  // so the delete must stay blocked. A FAILED probe is treated as "might have
  // LP" (fail closed): block + warn, never allow.
  const [lpChecked, setLpChecked] = useState(false);
  const [lpProbeFailed, setLpProbeFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLpChecked(false);
    setLpProbeFailed(false);
    rpc<LpPosition>("lp_position", { address: address.toLowerCase() })
      .then((p) => {
        if (cancelled) return;
        if (p?.has_position && p.shares !== "0") setLp(p);
        setLpChecked(true);
      })
      .catch((e) => {
        if (cancelled) return;
        // "swap not configured" means there's no LP subsystem at all, so no
        // shares can exist — treat it as a clean "no LP" and allow the delete.
        // Any OTHER error (pool unreachable, etc.) is a real probe failure: we
        // can't rule out an LP position, so fail closed (block + warn).
        const msg = String((e as { message?: unknown })?.message ?? e);
        if (!/swap not configured|swap engine|set --swap-pool/i.test(msg)) {
          setLpProbeFailed(true);
        }
        setLpChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);
  const hasLp = lp != null;
  // Blocked while the probe is in flight, while a confirmed LP position is
  // unacknowledged, or whenever the probe failed (can't rule LP out).
  const lpBlocks = !lpChecked || lpProbeFailed || (hasLp && !lpAck);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (lpBlocks) return;
    setError(null);
    setPending(true);
    try {
      // Pass force when overriding either guard: the on-chain funds checkbox, or
      // the off-chain LP acknowledgement (the backend now rejects deleting an
      // address that still owns LP shares unless force is set).
      await rpc("delete_address", {
        address,
        passphrase: password,
        force: (funded && force) || (hasLp && lpAck),
      });
      toast.success(t("kr.delDone"), t("kr.delDoneBody", { addr: shortAddress(address) }));
      onDeleted();
      onClose();
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <form onSubmit={onSubmit} className="card-padded w-full max-w-lg space-y-5">
        <header>
          <h2 className="text-xl font-semibold text-neutral-100">{t("kr.delHeading")}</h2>
          <p className="mt-1 text-sm text-neutral-400">
            {t("kr.delDescPre")}<span className="font-mono">{shortAddress(address)}</span>
            {t("kr.delDescPost")}
          </p>
        </header>

        {funded && (
          <div className="banner-error space-y-2 text-sm">
            <div className="font-semibold">{t("kr.delFundedTitle")}</div>
            <p>{t("kr.delFundedBody")}</p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              <span>{t("kr.delForceAck")}</span>
            </label>
          </div>
        )}

        {lpProbeFailed && <div className="banner-error text-sm">{t("err.network")}</div>}

        {hasLp && (
          <div className="banner-error space-y-2 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={lpAck}
                onChange={(e) => setLpAck(e.target.checked)}
              />
              <span>
                {t("kr.delLpWarn", {
                  exfer: Number(lp!.value_exfer).toLocaleString("en-US", {
                    maximumSignificantDigits: 6,
                    useGrouping: false,
                  }),
                  bnb: Number(lp!.value_bnb).toLocaleString("en-US", {
                    maximumSignificantDigits: 4,
                    useGrouping: false,
                  }),
                })}
              </span>
            </label>
          </div>
        )}

        <div>
          <label className="label" htmlFor="del-pw">
            {t("kr.walletPassword")}
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
            {t("kr.cancel")}
          </button>
          <button
            type="submit"
            className="btn-danger"
            disabled={pending || password === "" || (funded && !force) || lpBlocks}
          >
            {pending ? t("kr.deleting") : t("kr.delHeading")}
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
