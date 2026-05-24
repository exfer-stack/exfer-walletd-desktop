// Mock backend for the Vite dev server. Runs when we're loaded in a
// plain browser (no Tauri runtime). Lets us iterate on UI without
// needing the Tauri Linux prereqs (webkit2gtk etc.) and without
// touching the real chain.
//
// Persisted in localStorage under DEV_STATE_KEY so refreshes don't
// wipe the wallet.

import type {
  BootstrapStatus,
  GeneratedAddress,
  TransferReceipt,
  WalletBalance,
  WalletEntry,
} from "./types";

const DEV_STATE_KEY = "exfer-walletd-desktop-dev-state-v1";

const EXFER_UNIT = 100_000_000;

interface DevState {
  bootstrap:
    | { status: "needs_password" }
    | { status: "ready"; local_addr: string; fingerprint: string };
  nodeRpc: string;
  addresses: Array<{
    address: string;
    index: number;
    pubkey: string;
    balance: number;
    utxoCount: number;
  }>;
}

function defaultState(): DevState {
  return {
    bootstrap: { status: "needs_password" },
    nodeRpc: "http://89.127.232.155:9334",
    addresses: [],
  };
}

function loadState(): DevState {
  try {
    const raw = localStorage.getItem(DEV_STATE_KEY);
    if (!raw) return defaultState();
    return JSON.parse(raw) as DevState;
  } catch {
    return defaultState();
  }
}

function saveState(s: DevState) {
  localStorage.setItem(DEV_STATE_KEY, JSON.stringify(s));
}

// Deterministic-ish hex from index for predictable dev visuals.
function fakeHex(seed: string, length: number): string {
  // FNV-1a, expanded to length chars.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let out = "";
  while (out.length < length) {
    h = Math.imul(h ^ 0x9e3779b9, 16777619);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

export const devmock = {
  isActive(): boolean {
    // Tauri injects this on window. If absent, we're in a plain browser.
    return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__ === "undefined";
  },

  async bootstrap_status(): Promise<BootstrapStatus> {
    return loadState().bootstrap as BootstrapStatus;
  },

  async submit_password(password: string): Promise<BootstrapStatus> {
    if (!password) throw new Error("password must not be empty");
    const s = loadState();
    s.bootstrap = {
      status: "ready",
      local_addr: "127.0.0.1:54321",
      fingerprint: "sha256:dev-mock-fingerprint",
    };
    saveState(s);
    return s.bootstrap;
  },

  async get_node_rpc(): Promise<string> {
    return loadState().nodeRpc;
  },

  async set_node_rpc(url: string): Promise<BootstrapStatus> {
    const s = loadState();
    s.nodeRpc = url;
    saveState(s);
    return s.bootstrap as BootstrapStatus;
  },

  async rpc(method: string, params: unknown): Promise<unknown> {
    const s = loadState();
    if (s.bootstrap.status !== "ready") throw new Error("walletd not ready");

    switch (method) {
      case "ping":
        return { ok: true };

      case "list_addresses":
        return {
          addresses: s.addresses.map((a) => ({
            address: a.address,
            index: a.index,
            label: null,
            imported: false,
          })),
        };

      case "get_wallet_balance": {
        const entries: WalletEntry[] = s.addresses.map((a) => ({
          address: a.address,
          index: a.index,
          label: null,
          imported: false,
          balance: a.balance,
          utxo_count: a.utxoCount,
          truncated: false,
        }));
        const total = entries.reduce((acc, e) => acc + e.balance, 0);
        const out: WalletBalance = { entries, total };
        return out;
      }

      case "generate_address": {
        const index = s.addresses.length;
        const address = fakeHex(`addr-${index}`, 64);
        const pubkey = fakeHex(`pk-${index}`, 64);
        // Seed the first address with a small visible balance to make
        // the dashboard non-empty in dev.
        const balance = index === 0 ? Math.floor(0.1 * EXFER_UNIT) : 0;
        const utxoCount = balance > 0 ? 1 : 0;
        s.addresses.push({ address, index, pubkey, balance, utxoCount });
        saveState(s);
        const out: GeneratedAddress = { address, index, pubkey };
        return out;
      }

      case "transfer": {
        const p = params as {
          from: string;
          outputs: { to: string; amount: number }[];
          fee_rate?: number;
        };
        const sender = s.addresses.find((a) => a.address === p.from);
        if (!sender) throw new Error("from address not in wallet");
        const total = p.outputs.reduce((a, o) => a + o.amount, 0);
        const fee = (p.fee_rate ?? 1) * 70; // rough placeholder
        if (sender.balance < total + fee) throw new Error("insufficient balance");
        sender.balance -= total + fee;
        sender.utxoCount = sender.balance > 0 ? 1 : 0;
        for (const o of p.outputs) {
          const recip = s.addresses.find((a) => a.address === o.to);
          if (recip) {
            recip.balance += o.amount;
            recip.utxoCount += 1;
          }
        }
        saveState(s);
        const out: TransferReceipt = {
          tx_id: fakeHex(`tx-${Date.now()}`, 64),
          size: 227,
          fee,
          fee_rate: p.fee_rate ?? 1,
          inputs: [
            {
              tx_id: fakeHex(`prev-${sender.address.slice(0, 8)}`, 64),
              output_index: 0,
              value: total + fee,
            },
          ],
          outputs: p.outputs
            .map((o) => ({ to: o.to, amount: o.amount, is_change: false }))
            .concat({
              to: sender.address,
              amount: sender.balance,
              is_change: true,
            }),
          built_at_height: 631000 + Math.floor(Math.random() * 1000),
        };
        return out;
      }

      case "get_status":
        return {
          version: "dev-mock",
          uptime_secs: 0,
          wallet_count: s.addresses.length,
          in_flight_transfers: 0,
          in_flight_utxos: 0,
          upstream: { url: s.nodeRpc, mode: "dev-mock" },
        };

      case "get_balance": {
        const p = params as { address: string };
        const a = s.addresses.find((x) => x.address === p.address);
        return { address: p.address, balance: a?.balance ?? 0 };
      }

      default:
        throw new Error(`dev-mock: method ${method} not implemented`);
    }
  },

  /// Wipe local dev state. Exposed on `window.__exferDevReset` so
  /// devs can `__exferDevReset()` from the browser console.
  reset() {
    localStorage.removeItem(DEV_STATE_KEY);
  },
};

if (typeof window !== "undefined") {
  (window as unknown as { __exferDevReset?: () => void }).__exferDevReset =
    devmock.reset;
}
