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
      setError("password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("passwords do not match");
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
        setError("walletd reported an unexpected state after start");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={onSubmit} className="card w-full max-w-md p-6 space-y-5">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">Welcome to exfer-wallet</h1>
          <p className="text-sm text-neutral-600">
            Set a password to encrypt this wallet's seed at rest. You'll need
            it every time you reinstall or move this app to a new machine.
          </p>
        </header>

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
          />
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
          />
        </div>

        {error && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <button type="submit" className="btn w-full" disabled={pending}>
          {pending ? "Starting walletd…" : "Continue"}
        </button>

        <p className="text-xs text-neutral-500">
          Forgetting this password means losing every key this wallet holds.
          Back up the password somewhere safe before going further.
        </p>
      </form>
    </div>
  );
}
