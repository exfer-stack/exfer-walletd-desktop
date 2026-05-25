import { useState, type FormEvent } from "react";
import { submitPassword, restoreFromMnemonic } from "../lib/rpc";
import wordmarkUrl from "../assets/wordmark.png";

interface Props {
  onReady: () => void;
}

type Mode = "create" | "restore";

export function PasswordPrompt({ onReady }: Props) {
  const [mode, setMode] = useState<Mode>("create");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [phrase, setPhrase] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleStatus(status: Awaited<ReturnType<typeof submitPassword>>) {
    if (status.status === "ready") onReady();
    else if (status.status === "failed") setError(status.message);
    else setError("Walletd reported an unexpected state after start.");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (mode === "restore") {
      const words = phrase.trim().split(/\s+/).filter(Boolean);
      if (words.length !== 24) {
        setError(`Recovery phrase must be 24 words (you entered ${words.length}).`);
        return;
      }
    }

    setPending(true);
    try {
      const status =
        mode === "create"
          ? await submitPassword(password)
          : await restoreFromMnemonic(phrase.trim(), password);
      handleStatus(status);
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-8">
      <form
        onSubmit={onSubmit}
        className="card-padded w-full max-w-lg space-y-6 fade-in"
      >
        <div className="flex justify-center">
          <img
            src={wordmarkUrl}
            alt="EXFER"
            className="h-16 w-auto select-none"
            draggable={false}
          />
        </div>

        {/* Create / Restore toggle */}
        <div className="flex rounded-lg border border-neutral-800 bg-neutral-900 p-1 text-sm">
          {(["create", "restore"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              disabled={pending}
              className={
                "flex-1 rounded-md px-3 py-1.5 font-medium transition " +
                (mode === m
                  ? "bg-cyan-500 text-black"
                  : "text-neutral-400 hover:text-neutral-100")
              }
            >
              {m === "create" ? "New wallet" : "Restore from phrase"}
            </button>
          ))}
        </div>

        <header className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-50">
            {mode === "create" ? "Welcome to your wallet" : "Restore your wallet"}
          </h1>
          <p className="text-base text-neutral-400 leading-relaxed">
            {mode === "create"
              ? "Set a password to encrypt this wallet's seed at rest. It's saved in your OS keychain, so you only enter it once on this machine."
              : "Enter your 24-word recovery phrase and choose a new password for this machine. Your addresses re-derive automatically."}
          </p>
        </header>

        {mode === "restore" && (
          <div>
            <label className="label" htmlFor="phrase">
              Recovery phrase (24 words)
            </label>
            <textarea
              id="phrase"
              className="input h-24 resize-none font-mono text-sm"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              disabled={pending}
              placeholder="word1 word2 word3 … word24"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="help">
              Only restores a wallet created by exfer-wallet (same HD
              derivation). Words are separated by single spaces.
            </p>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="pw1">
              {mode === "create" ? "Password" : "New password for this machine"}
            </label>
            <input
              id="pw1"
              type="password"
              autoFocus={mode === "create"}
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={pending}
              autoComplete="new-password"
            />
            <p className="help">
              At least 8 characters. Mix letters, numbers, and symbols.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="pw2">
              Confirm password
            </label>
            <input
              id="pw2"
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

        <button type="submit" className="btn w-full" disabled={pending}>
          {pending
            ? mode === "create"
              ? "Starting walletd…"
              : "Restoring…"
            : mode === "create"
              ? "Continue"
              : "Restore wallet"}
        </button>

        <div className="banner-warn text-xs">
          <span className="font-semibold">Important — back this up.</span>{" "}
          Forgetting this password means every wallet in this app is gone.
          We never see it; we can't help you recover it.
        </div>
      </form>
    </div>
  );
}
