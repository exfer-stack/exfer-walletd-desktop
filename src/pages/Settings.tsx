import { useEffect, useState, type FormEvent } from "react";
import { getNodeRpc, setNodeRpc } from "../lib/rpc";
import type { BootstrapStatus } from "../lib/types";

interface Props {
  onRestart: (status: BootstrapStatus) => void;
}

export function Settings({ onRestart }: Props) {
  const [current, setCurrent] = useState<string>("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    getNodeRpc().then((v) => {
      setCurrent(v);
      setValue(v);
    });
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setPending(true);
    try {
      const status = await setNodeRpc(value);
      setCurrent(value);
      setInfo("Saved — walletd reconnected to the new node.");
      onRestart(status);
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4 p-6">
      <h2 className="text-lg font-semibold">Settings</h2>

      <form onSubmit={onSubmit} className="card p-4 space-y-3 max-w-2xl">
        <div>
          <label className="label">Exfer node RPC URL</label>
          <input
            className="input font-mono text-xs"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={pending}
          />
          <p className="mt-1 text-xs text-neutral-500">
            One URL, or several comma-separated (round-robin + failover).
            Currently in use:{" "}
            <code className="font-mono">{current || "(loading)"}</code>
          </p>
        </div>

        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {info && (
          <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">
            {info}
          </div>
        )}

        <button
          type="submit"
          className="btn"
          disabled={pending || value.trim() === current.trim()}
        >
          {pending ? "Restarting walletd…" : "Save & reconnect"}
        </button>
      </form>
    </div>
  );
}
