import { useState, type FormEvent } from "react";
import { submitPassword } from "../lib/rpc";

interface Props {
  onReady: () => void;
}

export function PasswordPrompt({ onReady }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setPending(true);
    try {
      const status = await submitPassword(password);
      if (status.status === "ready") {
        onReady();
      } else if (status.status === "failed") {
        setError(status.message);
      } else {
        setError("Walletd reported an unexpected state after start.");
      }
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
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            Welcome to exfer wallet
          </h1>
          <p className="text-base text-neutral-600 leading-relaxed">
            Set a password to encrypt this wallet's seed at rest. It's stored
            in your operating system's secure keychain, so you'll only enter
            it once on this machine.
          </p>
        </header>

        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="pw1">
              Password
            </label>
            <input
              id="pw1"
              type="password"
              autoFocus
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
          {pending ? "Starting walletd…" : "Continue"}
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
