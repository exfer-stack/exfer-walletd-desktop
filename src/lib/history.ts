// Persistent local log of broadcast transfers. walletd doesn't track
// per-wallet tx history, so we keep one client-side.

import type { TransferReceipt } from "./types";

const HISTORY_KEY = "exfer-walletd-desktop-history-v1";
const RECENT_RECIPS_KEY = "exfer-walletd-desktop-recents-v1";

export interface HistoryEntry {
  tx_id: string;
  fee: number;
  size: number;
  inputs: TransferReceipt["inputs"];
  outputs: TransferReceipt["outputs"];
  built_at_height: number;
  // ISO timestamp when we broadcast.
  broadcast_at: string;
}

function load(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function save(v: HistoryEntry[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(v));
}

export function listHistory(): HistoryEntry[] {
  // Newest first.
  return load().sort((a, b) =>
    a.broadcast_at < b.broadcast_at ? 1 : -1,
  );
}

export function appendHistory(receipt: TransferReceipt) {
  const entries = load();
  entries.push({
    tx_id: receipt.tx_id,
    fee: receipt.fee,
    size: receipt.size,
    inputs: receipt.inputs,
    outputs: receipt.outputs,
    built_at_height: receipt.built_at_height,
    broadcast_at: new Date().toISOString(),
  });
  save(entries);
}

export function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

// Recent recipient addresses (for the Send page's quick-pick).
const MAX_RECENT = 12;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_RECIPS_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export function listRecentRecipients(): string[] {
  return loadRecents();
}

export function rememberRecipient(address: string) {
  let v = loadRecents().filter((a) => a !== address);
  v.unshift(address);
  if (v.length > MAX_RECENT) v = v.slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_RECIPS_KEY, JSON.stringify(v));
}
