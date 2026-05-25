import { useEffect, useRef, useState, type FormEvent } from "react";
import { rpc } from "../lib/rpc";
import { CopyButton } from "./CopyButton";

interface Props {
  onClose: () => void;
}

const AUTO_HIDE_MS = 30_000;

export function RevealMnemonicModal({ onClose }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
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
      const res = await rpc<{ mnemonic: string[] }>("reveal_mnemonic", {
        passphrase: password,
      });
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
          <h2 className="text-xl font-semibold text-neutral-900">
            Recovery phrase
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            Anyone who sees these 24 words can re-create every key this
            wallet derives. Treat them like cash.
          </p>
        </header>

        {!words ? (
          <form onSubmit={reveal} className="space-y-4">
            <div className="banner-warn space-y-2 text-sm">
              <div className="font-semibold text-amber-900">
                Before you continue
              </div>
              <ul className="ml-4 list-disc space-y-1 text-amber-900">
                <li>Make sure nobody is looking at your screen.</li>
                <li>
                  Walletd uses a non-standard derivation path. The
                  words are valid BIP-39 but won't restore in MetaMask /
                  Sparrow / Electrum. They restore <em>this</em> wallet.
                </li>
                <li>
                  Never paste these into a website, chat, or email.
                </li>
              </ul>
              <label className="mt-2 flex items-start gap-2 text-amber-900">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>I understand. Show me my recovery phrase.</span>
              </label>
            </div>

            <div>
              <label className="label" htmlFor="reveal-pw">
                Your wallet password
              </label>
              <input
                id="reveal-pw"
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
                Cancel
              </button>
              <button
                type="submit"
                className="btn-danger"
                disabled={!acknowledged || pending || password === ""}
              >
                {pending ? "Verifying…" : "Reveal phrase"}
              </button>
            </div>
          </form>
        ) : (
          <RevealedWords
            words={words}
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

function RevealedWords({
  words,
  hidden,
  onUnhide,
  onClose,
}: {
  words: string[];
  hidden: boolean;
  onUnhide: () => void;
  onClose: () => void;
}) {
  const joined = words.join(" ");
  return (
    <div className="space-y-4">
      <div className="banner-error">
        These 24 words are equivalent to total control of every key.
        Write them down on paper. Do <strong>not</strong> screenshot
        them and do <strong>not</strong> save the screenshot to the
        cloud.
      </div>

      <div
        className={
          "grid grid-cols-3 gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 " +
          (hidden ? "blur-md select-none pointer-events-none" : "")
        }
      >
        {words.map((w, i) => (
          <div
            key={i}
            className="flex items-baseline gap-2 rounded-md bg-white px-2.5 py-1.5"
          >
            <span className="w-6 text-right text-xs text-neutral-400 tabular-nums">
              {i + 1}.
            </span>
            <span className="mono text-sm font-medium text-neutral-900">
              {w}
            </span>
          </div>
        ))}
      </div>

      {hidden && (
        <div className="flex justify-center">
          <button type="button" className="btn-secondary" onClick={onUnhide}>
            Show again
          </button>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <CopyButton text={joined} className="btn-secondary" />
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </div>

      <p className="text-xs text-neutral-500">
        Auto-hides after 30 seconds. Closing this dialog clears the
        words from memory.
      </p>
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
