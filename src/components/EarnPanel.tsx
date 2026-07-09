import { useEffect, useRef, useState } from "react";
import { useWallet } from "../lib/wallet";
import { useT } from "../lib/i18n";
import { useToast } from "../lib/toast";
import { isHidden } from "../lib/hidden";
import { getLabel, shortAddress } from "../lib/labels";
import { inTauri } from "../lib/agentHost";
import { humanizeError } from "../lib/errors";

// Shape returned by the native `mine_status` Tauri command. The miner is a
// desktop-native capability (Rust); in the browser dev preview the commands
// are unavailable, so this panel renders fully and degrades gracefully.
interface MineStatus {
  running: boolean;
  pool: string | null;
  address: string | null;
  threads: number;
  hashrate_hs: number;
  authorized: boolean;
  jobs: number;
  submitted: number;
  accepted: number;
  rejected: number;
  uptime_seconds: number;
}

// Argon2id is memory-hard; the native miner documents a 1-4 thread range, so we
// cap the picker there to keep RAM use sane.
const MAX_THREADS = 4;

// ninjaraider EXFER pools (solo :44915 = the native DEFAULT_SOLO_POOL, pplns
// :44913). Solo mining reports status.pool == SOLO_POOL, so we can tell a
// run's mode apart from its reported pool.
const SOLO_POOL = "ssl://ninjaraider.com:44915";
const DEFAULT_POOL = "ssl://ninjaraider.com:44913";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args ?? {});
}

/** Compact a hashrate in H/s to a human string (kH/s, MH/s, …). */
function fmtHashrate(hs: number): string {
  if (!Number.isFinite(hs) || hs <= 0) return "0 H/s";
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s"];
  let v = hs;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)} ${units[i]}`;
}

/** Seconds → a compact "1h 2m" / "3m 4s" uptime string. */
function fmtUptime(s: number): string {
  const sec = Math.max(0, Math.floor(s));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

/** The Earn / mining panel: Solo (default) vs Pool, mine-to address, thread
 *  count, Start/Stop with a confirm, and live status polled from mine_status.
 *  Lives on the Dashboard; mirrors the mobile Earn panel. */
export function EarnPanel() {
  const { t } = useT();
  const toast = useToast();
  const { balance } = useWallet();
  const native = inTauri();

  const addresses = (balance?.entries ?? []).filter((e) => !isHidden(e.address));

  const [mode, setMode] = useState<"solo" | "pool">("solo");
  const [poolUrl, setPoolUrl] = useState(DEFAULT_POOL);
  const [address, setAddress] = useState("");
  const [threads, setThreads] = useState(1);
  const [status, setStatus] = useState<MineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "start" | "stop">(null);
  const syncedFromRun = useRef(false);

  // Default the payout address to the first visible address once balances load.
  useEffect(() => {
    if (!address && addresses.length > 0) setAddress(addresses[0].address);
  }, [addresses, address]);

  // Poll the native miner status. Native-only: in the browser preview the
  // command throws, so we never mount the poll there (the panel shows a note).
  useEffect(() => {
    if (!native) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await invoke<MineStatus>("mine_status");
        if (alive) setStatus(s);
      } catch {
        /* miner not initialized yet — leave last-known status */
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [native]);

  const running = status?.running ?? false;

  // Reflect a run started elsewhere (e.g. from the agent chat) in the controls,
  // so the panel isn't confidently wrong about mode / threads / payout address
  // while those controls are locked. One-shot per run; resets on stop.
  useEffect(() => {
    if (running && !syncedFromRun.current) {
      syncedFromRun.current = true;
      const p = status?.pool ?? null;
      if (p) {
        setMode(p === SOLO_POOL ? "solo" : "pool");
        if (p !== SOLO_POOL) setPoolUrl(p);
      }
      if (status?.address) setAddress(status.address);
      if (status?.threads) setThreads(Math.min(MAX_THREADS, Math.max(1, status.threads)));
    }
    if (!running) syncedFromRun.current = false;
  }, [running, status?.pool, status?.address, status?.threads]);

  // Escape closes the Start/Stop confirm dialog (parity with the other dialogs).
  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setConfirm(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, busy]);

  const poolMissing = mode === "pool" && poolUrl.trim().length === 0;
  const canStart = native && !busy && !running && !!address && !poolMissing;
  // The pool actually in use: the live one while running, else what Start will send.
  const resolvedPool = running ? (status?.pool ?? SOLO_POOL) : mode === "solo" ? SOLO_POOL : poolUrl.trim() || DEFAULT_POOL;
  const isSolo = resolvedPool === SOLO_POOL;

  async function doStart() {
    setConfirm(null);
    setBusy(true);
    try {
      await invoke("mine_start", {
        address,
        pool: mode === "pool" ? poolUrl.trim() : null,
        threads,
      });
      toast.success(t("earn.started"), shortAddress(address));
      try {
        setStatus(await invoke<MineStatus>("mine_status"));
      } catch {
        /* status catches up on the next poll */
      }
    } catch (e) {
      toast.error(t("earn.startFailed"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function doStop() {
    setConfirm(null);
    setBusy(true);
    try {
      await invoke("mine_stop");
      toast.success(t("earn.stoppedToast"), "");
      try {
        setStatus(await invoke<MineStatus>("mine_status"));
      } catch {
        /* status catches up on the next poll */
      }
    } catch (e) {
      toast.error(t("earn.stopFailed"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const addrLabel = (a: string) => getLabel(a) ?? shortAddress(a);

  return (
    <section className="card-padded space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold tracking-tight text-neutral-100">
            {t("earn.title")}
          </h2>
          <span className={running ? "pill pill-success" : "pill pill-info"}>
            {running ? t("earn.running") : t("earn.stopped")}
          </span>
        </div>
        {running && (
          <span className="font-mono text-sm tabular-nums text-neutral-300">
            {fmtHashrate(status?.hashrate_hs ?? 0)}
          </span>
        )}
      </header>

      <p className="text-sm text-neutral-400">{t("earn.subtitle")}</p>

      {!native && <div className="banner-info">{t("earn.nativeOnly")}</div>}

      <div className="grid gap-5 md:grid-cols-2">
        {/* Controls */}
        <div className="space-y-4">
          {/* Solo vs Pool */}
          <div>
            <div className="label">{t("earn.mode")}</div>
            <div className="inline-flex overflow-hidden rounded-lg border border-neutral-700" role="group">
              {(["solo", "pool"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={running || busy}
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  className={
                    "px-4 py-1.5 text-sm transition disabled:opacity-50 " +
                    (mode === m
                      ? "bg-neutral-800 text-neutral-100"
                      : "text-neutral-400 hover:text-neutral-200")
                  }
                >
                  {m === "solo" ? t("earn.mode.solo") : t("earn.mode.pool")}
                </button>
              ))}
            </div>
            <p className="help">
              {mode === "solo" ? t("earn.mode.soloHint") : t("earn.mode.poolHint")}
            </p>
          </div>

          {mode === "pool" && (
            <div>
              <label className="label">{t("earn.poolUrl")}</label>
              <input
                className="input font-mono text-sm"
                value={poolUrl}
                onChange={(e) => setPoolUrl(e.target.value)}
                disabled={running || busy}
                placeholder={t("earn.poolPlaceholder")}
                spellCheck={false}
              />
            </div>
          )}

          <div>
            <label className="label">{t("earn.mineTo")}</label>
            {addresses.length === 0 ? (
              <p className="help text-amber-400/90">{t("earn.needAddress")}</p>
            ) : (
              <select
                className="input"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                disabled={running || busy}
              >
                {addresses.map((e) => (
                  <option key={e.address} value={e.address}>
                    {addrLabel(e.address)}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="label">
              {t("earn.threads")} · {threads}
            </label>
            <input
              type="range"
              min={1}
              max={MAX_THREADS}
              step={1}
              value={threads}
              onChange={(e) => setThreads(Number(e.target.value))}
              disabled={running || busy}
              className="w-full accent-cyan-500"
            />
            <p className="help">{t("earn.threadsHint")}</p>
          </div>

          {running ? (
            <button
              type="button"
              className="btn-danger w-full"
              disabled={busy}
              onClick={() => setConfirm("stop")}
            >
              {busy ? t("earn.stopping") : t("earn.stop")}
            </button>
          ) : (
            <div className="space-y-1">
              <button
                type="button"
                className="btn w-full"
                disabled={!canStart}
                onClick={() => setConfirm("start")}
              >
                {busy ? t("earn.starting") : t("earn.start")}
              </button>
              {native && poolMissing && <p className="help text-amber-400/90">{t("earn.poolMissingHint")}</p>}
            </div>
          )}
        </div>

        {/* Live status */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Stat label={t("earn.hashrate")} value={fmtHashrate(status?.hashrate_hs ?? 0)} />
            <Stat label={t("earn.uptime")} value={fmtUptime(status?.uptime_seconds ?? 0)} />
            <Stat label={t("earn.accepted")} value={String(status?.accepted ?? 0)} />
            <Stat label={t("earn.rejected")} value={String(status?.rejected ?? 0)} />
            <Stat label={t("earn.submitted")} value={String(status?.submitted ?? 0)} />
            <Stat label={t("earn.jobs")} value={String(status?.jobs ?? 0)} />
          </dl>
          <div className="mt-3 flex items-center justify-between border-t border-neutral-800 pt-3">
            <span className="text-xs text-neutral-500">
              {isSolo ? t("earn.mode.solo") : t("earn.pool")}
            </span>
            {/* Only signal pool authorization while a run is live — an amber
                "Not authorized" pill on an idle/preview panel reads as a fault. */}
            {running && (
              <span className={"pill " + (status?.authorized ? "pill-success" : "pill-warn")}>
                {status?.authorized ? t("earn.authorized") : t("earn.notAuthorized")}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Start / Stop confirmation */}
      {confirm && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/40 p-6 fade-in"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setConfirm(null);
          }}
        >
          <div className="card-padded mt-24 w-full max-w-sm space-y-4">
            <h2 className="text-base font-semibold tracking-tight text-neutral-100">
              {confirm === "start"
                ? t("earn.confirmStartTitle")
                : t("earn.confirmStopTitle")}
            </h2>
            <p className="text-sm text-neutral-400">
              {confirm === "stop"
                ? t("earn.confirmStopBody")
                : mode === "pool"
                  ? t("earn.confirmStartPool", {
                      addr: shortAddress(address),
                      pool: poolUrl.trim(),
                    })
                  : t("earn.confirmStartSolo", { addr: shortAddress(address) })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirm(null)}
                disabled={busy}
              >
                {t("earn.cancel")}
              </button>
              <button
                type="button"
                className={confirm === "stop" ? "btn-danger" : "btn"}
                onClick={confirm === "start" ? doStart : doStop}
                disabled={busy}
              >
                {confirm === "start" ? t("earn.confirmStart") : t("earn.confirmStop")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="font-mono tabular-nums text-neutral-100">{value}</dd>
    </div>
  );
}
