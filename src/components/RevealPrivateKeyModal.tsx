import { useEffect, useRef, useState, type FormEvent } from "react";
import { rpc } from "../lib/rpc";
import type { WalletBalance } from "../lib/types";
import { CopyButton } from "./CopyButton";
import { getLabel, shortAddress } from "../lib/labels";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";

interface Props {
  onClose: () => void;
}

const AUTO_HIDE_MS = 30_000;

interface RevealedKey {
  address: string;
  secret_hex: string;
}

export function RevealPrivateKeyModal({ onClose }: Props) {
  const { t } = useT();
  const [addresses, setAddresses] = useState<WalletBalance["entries"]>([]);
  const [address, setAddress] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<RevealedKey | null>(null);
  const [hidden, setHidden] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    rpc<WalletBalance>("get_wallet_balance").then(
      (r) => {
        setAddresses(r.entries);
        if (r.entries.length > 0) setAddress(r.entries[0].address);
      },
      (e) => setError(humanizeError(e)),
    );
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function reveal(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await rpc<RevealedKey>("reveal_private_key", {
        address,
        passphrase: password,
      });
      setKey(res);
      setPassword("");
      timerRef.current = setTimeout(() => setHidden(true), AUTO_HIDE_MS);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <div className="card-padded w-full max-w-xl space-y-5">
        <header>
          <h2 className="text-xl font-semibold text-neutral-100">
            {t("rev.title")}
          </h2>
          <p className="mt-1 text-sm text-neutral-400">{t("rev.desc")}</p>
        </header>

        {!key ? (
          <form onSubmit={reveal} className="space-y-4">
            <div>
              <label className="label">{t("rev.addressLabel")}</label>
              <select
                className="input"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                disabled={pending || addresses.length === 0}
              >
                {addresses.length === 0 && (
                  <option value="">{t("rev.noAddresses")}</option>
                )}
                {addresses.map((e) => {
                  const label = getLabel(e.address);
                  const tag = label
                    ? `${label} — ${shortAddress(e.address)}`
                    : shortAddress(e.address);
                  return (
                    <option key={e.address} value={e.address}>
                      {tag}
                    </option>
                  );
                })}
              </select>
            </div>

            <div className="banner-warn space-y-2 text-sm">
              <div className="font-semibold text-amber-200">
                {t("rev.warnTitle")}
              </div>
              <ul className="ml-4 list-disc space-y-1 text-amber-200">
                <li>{t("rev.warn1")}</li>
                <li>{t("rev.warn2")}</li>
                <li>{t("rev.warn3")}</li>
              </ul>
              <label className="mt-2 flex items-start gap-2 text-amber-200">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>{t("rev.acknowledge")}</span>
              </label>
            </div>

            <div>
              <label className="label" htmlFor="reveal-pk-pw">
                {t("rev.passLabel")}
              </label>
              <input
                id="reveal-pk-pw"
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
              <button
                type="button"
                className="btn-secondary"
                onClick={onClose}
                disabled={pending}
              >
                {t("rev.cancel")}
              </button>
              <button
                type="submit"
                className="btn-danger"
                disabled={
                  !acknowledged || pending || !address || password === ""
                }
              >
                {pending ? t("rev.verifying") : t("rev.reveal")}
              </button>
            </div>
          </form>
        ) : (
          <RevealedKey
            address={key.address}
            secretHex={key.secret_hex}
            hidden={hidden}
            onUnhide={() => {
              setHidden(false);
              if (timerRef.current) clearTimeout(timerRef.current);
              timerRef.current = setTimeout(() => setHidden(true), AUTO_HIDE_MS);
            }}
            onClose={onClose}
          />
        )}
      </div>
    </Backdrop>
  );
}

function RevealedKey({
  address,
  secretHex,
  hidden,
  onUnhide,
  onClose,
}: {
  address: string;
  secretHex: string;
  hidden: boolean;
  onUnhide: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <div className="space-y-4">
      <div className="banner-error">{t("rev.revealedWarn")}</div>

      <div>
        <div className="label">{t("rev.addressHeader")}</div>
        <code className="addr block rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
          {address}
        </code>
      </div>

      <div>
        <div className="label">{t("rev.keyHeader")}</div>
        <div
          className={
            "rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 font-mono text-sm break-all text-red-200 " +
            (hidden ? "blur-md select-none pointer-events-none" : "")
          }
        >
          {secretHex}
        </div>
      </div>

      {hidden && (
        <div className="flex justify-center">
          <button type="button" className="btn-secondary" onClick={onUnhide}>
            {t("rev.showAgain")}
          </button>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <CopyButton text={secretHex} className="btn-secondary" />
        <button type="button" className="btn" onClick={onClose}>
          {t("rev.done")}
        </button>
      </div>

      <p className="text-xs text-neutral-400">{t("rev.autoHide")}</p>
    </div>
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
