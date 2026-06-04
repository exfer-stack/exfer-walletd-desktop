import { useEffect, useMemo, useState } from "react";
import { rpc, formatExfer } from "../lib/rpc";
import {
  listHistory,
  clearHistory,
  loadConfirmed,
  rememberConfirmed,
  type HistoryEntry,
} from "../lib/history";
import { getLabel, shortAddress } from "../lib/labels";
import { CopyButton } from "../components/CopyButton";
import { useT } from "../lib/i18n";

const EXPLORER = "https://explorer.exfer.dev";
const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;

/** A hash shown as: optional label, short form, copy button, and an
 *  "open in explorer" link — so the bare hex is never a dead end. */
function HashLine({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href: string;
}) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-xs text-neutral-500">{label}</span>
      <code className="addr-xs flex-1 truncate">{shortAddress(value, 10, 8)}</code>
      <CopyButton text={value} className="btn-ghost text-xs" />
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="rounded-md px-1.5 py-0.5 text-xs text-cyan-400 hover:bg-neutral-800"
        title={t("act.viewExplorer")}
      >
        ↗
      </a>
    </div>
  );
}

interface TxStatus {
  in_mempool: boolean;
  block_height?: number;
  block_id?: string;
}

export function Activity() {
  const { t } = useT();
  const [version, bump] = useState(0); // bump to force reload
  const history = useMemo(listHistory, [version]);
  // Seed from the confirmed-tx cache so already-mined transfers render as
  // "confirmed" immediately instead of flashing "checking" on every visit.
  const [statuses, setStatuses] = useState<Record<string, TxStatus | "error">>(
    () => {
      const cached = loadConfirmed();
      const seed: Record<string, TxStatus> = {};
      for (const [tx_id, c] of Object.entries(cached)) {
        seed[tx_id] = { in_mempool: false, block_height: c.block_height, block_id: c.block_id };
      }
      return seed;
    },
  );
  const [polling, setPolling] = useState(false);

  async function refreshOne(tx_id: string) {
    try {
      const r = await rpc<{
        in_mempool: boolean;
        block_height?: number;
        block_id?: string;
      }>("get_transaction", { tx_id });
      setStatuses((s) => ({
        ...s,
        [tx_id]: {
          in_mempool: r.in_mempool,
          block_height: r.block_height,
          block_id: r.block_id,
        },
      }));
      // A height is final — cache it so future visits skip the lookup.
      if (r.block_height != null) {
        rememberConfirmed(tx_id, r.block_height, r.block_id);
      }
    } catch {
      setStatuses((s) => ({ ...s, [tx_id]: "error" }));
    }
  }

  async function refreshAll(force = false) {
    setPolling(true);
    try {
      const targets = force
        ? history
        : history.filter((h) => {
            const st = statuses[h.tx_id];
            // Skip rows already known confirmed (seeded from cache).
            return !(st && st !== "error" && st.block_height != null);
          });
      await Promise.all(targets.map((h) => refreshOne(h.tx_id)));
    } finally {
      setPolling(false);
    }
  }

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-poll while any tx hasn't confirmed yet. get_transaction is a
  // point lookup (not the UTXO-scan rate-limit bucket), so a 15s cadence
  // is safe. Stops once everything is confirmed/settled.
  useEffect(() => {
    const id = window.setInterval(() => {
      const unsettled = history.filter((h) => {
        const st = statuses[h.tx_id];
        return !(st && st !== "error" && st.block_height != null);
      });
      if (unsettled.length === 0) return; // nothing to chase
      unsettled.forEach((h) => refreshOne(h.tx_id));
    }, 15_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, statuses]);

  if (history.length === 0) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
            {t("act.title")}
          </h1>
          <p className="text-base text-neutral-400">{t("act.emptyDesc")}</p>
        </header>
        <div className="card-padded text-center text-sm text-neutral-400">
          {t("act.emptyState")}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-8 fade-in">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
            {t("act.title")}
          </h1>
          <p className="text-base text-neutral-400">
            {history.length === 1
              ? t("act.countOne", { n: history.length })
              : t("act.countMany", { n: history.length })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => refreshAll(true)}
            disabled={polling}
            className="btn-ghost"
          >
            {polling ? t("act.refreshing") : t("act.refresh")}
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm(t("act.clearConfirm"))) {
                clearHistory();
                bump((v) => v + 1);
              }
            }}
            className="btn-ghost text-red-600 hover:bg-red-500/10"
          >
            {t("act.clearLog")}
          </button>
        </div>
      </header>

      <div className="space-y-3">
        {history.map((h) => (
          <ActivityCard key={h.tx_id} entry={h} status={statuses[h.tx_id]} />
        ))}
      </div>
    </div>
  );
}

function ActivityCard({
  entry,
  status,
}: {
  entry: HistoryEntry;
  status: TxStatus | "error" | undefined;
}) {
  const { t } = useT();
  const dt = new Date(entry.broadcast_at);
  const recipients = entry.outputs.filter((o) => !o.is_change);
  const change = entry.outputs.find((o) => o.is_change);

  let statusPill: { text: string; className: string };
  if (status === "error") {
    statusPill = { text: t("act.pillError"), className: "pill-warn" };
  } else if (!status) {
    statusPill = { text: t("act.pillChecking"), className: "pill-info" };
  } else if (status.block_height != null) {
    statusPill = {
      text: t("act.pillConfirmed", { h: status.block_height }),
      className: "pill-success",
    };
  } else if (status.in_mempool) {
    statusPill = { text: t("act.pillMempool"), className: "pill-info" };
  } else {
    statusPill = { text: t("act.pillNotFound"), className: "pill-warn" };
  }

  return (
    <article className="card overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-neutral-800 px-5 py-3">
        <div className="text-sm text-neutral-400">
          {dt.toLocaleDateString()} · {dt.toLocaleTimeString()}
        </div>
        <span className={`pill ${statusPill.className}`}>
          {statusPill.text}
        </span>
      </div>

      <div className="grid gap-4 p-5 md:grid-cols-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            {t("act.sentTo")}
          </div>
          <ul className="mt-2 space-y-3">
            {recipients.map((o, i) => {
              const label = getLabel(o.to);
              return (
                <li key={i} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-neutral-200">
                      {label ?? t("act.externalAddress")}
                    </span>
                    <span className="amount text-sm">
                      {formatExfer(o.amount)}
                    </span>
                  </div>
                  <HashLine label={t("act.addrLabel")} value={o.to} href={addrUrl(o.to)} />
                </li>
              );
            })}
          </ul>
        </div>
        <div className="space-y-1.5">
          <Row label={t("act.fee")} value={formatExfer(entry.fee)} />
          <Row
            label={t("act.io")}
            value={t("act.ioValue", {
              in: entry.inputs.length,
              out: entry.outputs.length,
            })}
          />
          {change && (
            <Row label={t("act.change")} value={formatExfer(change.amount)} />
          )}
          <Row label={t("act.size")} value={`${entry.size} B`} />
        </div>
      </div>

      <div className="border-t border-neutral-800 bg-neutral-900 px-5 py-3">
        <HashLine label={t("act.txId")} value={entry.tx_id} href={txUrl(entry.tx_id)} />
      </div>
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-neutral-400">{label}</span>
      <span className="amount">{value}</span>
    </div>
  );
}
