import { useState, type FormEvent } from "react";
import { importWalletKey } from "../lib/rpc";
import { devmock } from "../lib/devmock";
import { useToast } from "../lib/toast";
import { shortAddress } from "../lib/labels";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";

interface Props {
  onClose: () => void;
  onImported?: (address: string) => void;
}

export function ImportKeyModal({ onClose, onImported }: Props) {
  const toast = useToast();
  const { t } = useT();
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
      setError(t("imp.dialogError", { err: humanizeError(err) }));
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!path) {
      setError(t("imp.errNoFile"));
      return;
    }
    // Password is optional: a raw / unencrypted key file imports with it
    // blank. Only encrypted EXFK files need one (and a wrong/empty one
    // there surfaces as a decrypt error from the backend).
    setPending(true);
    try {
      const address = await importWalletKey({
        path,
        filePassword,
        label: label.trim() || undefined,
      });
      toast.success(
        t("imp.toastTitle"),
        t("imp.toastBody", { addr: shortAddress(address) }),
      );
      onImported?.(address);
      onClose();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <form onSubmit={onSubmit} className="card-padded w-full max-w-lg space-y-5">
        <header className="space-y-1">
          <h2 className="text-xl font-semibold text-neutral-100">
            {t("imp.title")}
          </h2>
          <p className="text-sm text-neutral-400">{t("imp.desc")}</p>
        </header>

        <div className="banner-info text-sm">{t("imp.banner")}</div>

        <div className="space-y-2">
          <label className="label">{t("imp.fileLabel")}</label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={pickFile}
              disabled={pending}
            >
              {t("imp.chooseFile")}
            </button>
            <span className="addr-xs flex-1 truncate text-neutral-400">
              {path ?? t("imp.noFile")}
            </span>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="imp-file-pw">
            {t("imp.passLabel")}
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
          <p className="help">{t("imp.passHelp")}</p>
        </div>

        <div>
          <label className="label" htmlFor="imp-label">
            {t("imp.labelLabel")}
          </label>
          <input
            id="imp-label"
            type="text"
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={pending}
            placeholder={t("imp.labelPlaceholder")}
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
            {t("imp.cancel")}
          </button>
          <button
            type="submit"
            className="btn"
            disabled={pending || !path}
          >
            {pending ? t("imp.importing") : t("imp.import")}
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
