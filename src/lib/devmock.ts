// Browser-side fallback when we're not running inside a Tauri webview.
//
// Two modes, selected by Vite env vars set in `.env.local`:
//
// 1. Real walletd dev (preferred for end-to-end testing). Set
//    VITE_USE_REAL_WALLETD=true and the three VITE_WALLETD_TOKEN_*
//    vars; we route `rpc()` through `fetch('/__walletd', …)` which
//    Vite's dev-server proxy forwards to the actual daemon. CORS is a
//    non-issue because the browser sees same-origin.
//
// 2. In-memory mock (default). Synthesises responses locally so the UI
//    layout can be exercised without any backend at all. Persisted in
//    localStorage under DEV_STATE_KEY so refreshes don't wipe state.

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

const REAL_BASE = "/__walletd";

function useRealWalletd(): boolean {
  return import.meta.env.VITE_USE_REAL_WALLETD === "true";
}

function realToken(scope: "read" | "manage" | "spend"): string {
  const key = `VITE_WALLETD_TOKEN_${scope.toUpperCase()}` as
    | "VITE_WALLETD_TOKEN_READ"
    | "VITE_WALLETD_TOKEN_MANAGE"
    | "VITE_WALLETD_TOKEN_SPEND";
  const v = import.meta.env[key];
  if (!v) {
    throw new Error(
      `Real-walletd mode: env var ${key} is missing from .env.local`,
    );
  }
  return v as string;
}

function scopeFor(method: string): "read" | "manage" | "spend" {
  if (method === "transfer" || method === "send_raw_transaction" || method === "sign_message") return "spend";
  if (method === "generate_address" || method === "abandon_transfer") return "manage";
  return "read";
}

async function realRpc(method: string, params: unknown): Promise<unknown> {
  const resp = await fetch(REAL_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${realToken(scopeFor(method))}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: params ?? {},
    }),
  });
  const body = await resp.json();
  if (body.error) {
    throw new Error(`${body.error.message ?? "rpc error"} (code ${body.error.code})`);
  }
  return body.result;
}

export const devmock = {
  isActive(): boolean {
    // Tauri injects this on window. If absent, we're in a plain browser.
    return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__ === "undefined";
  },

  async bootstrap_status(): Promise<BootstrapStatus> {
    if (useRealWalletd()) {
      // Real walletd is already running outside the desktop process.
      // The "bootstrap" concept (password prompt → spawn walletd) is
      // bypassed in this mode; we report Ready immediately so the UI
      // skips the modal.
      try {
        await realRpc("ping", {});
        return {
          status: "ready",
          local_addr: "127.0.0.1:7448 (via vite proxy)",
          fingerprint: "(plain HTTP — proxy)",
        };
      } catch (e) {
        return {
          status: "failed",
          message: `cannot reach real walletd via ${REAL_BASE}: ${String(e)}`,
        };
      }
    }
    return loadState().bootstrap as BootstrapStatus;
  },

  async submit_password(password: string): Promise<BootstrapStatus> {
    if (useRealWalletd()) {
      // No-op in real mode; bootstrap_status already returned Ready.
      return this.bootstrap_status();
    }
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
    if (useRealWalletd()) {
      const st = (await realRpc("get_status", {})) as {
        upstream?: { url?: string };
      };
      return st.upstream?.url ?? "(unknown)";
    }
    return loadState().nodeRpc;
  },

  async set_node_rpc(url: string): Promise<BootstrapStatus> {
    if (useRealWalletd()) {
      // walletd has no runtime-mutable node_rpc — would need a restart
      // with new env. Surface a friendly failure.
      throw new Error(
        "Changing the upstream node requires restarting the daemon in real-walletd dev mode.",
      );
    }
    const s = loadState();
    s.nodeRpc = url;
    saveState(s);
    return s.bootstrap as BootstrapStatus;
  },

  async rpc(method: string, params: unknown): Promise<unknown> {
    if (useRealWalletd()) {
      return realRpc(method, params);
    }
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

      case "reveal_mnemonic": {
        const p = params as { passphrase: string };
        if (!p.passphrase || p.passphrase.length < 4) {
          throw new Error("Keystore locked: wrong passphrase");
        }
        return {
          mnemonic: [
            "abandon", "ability", "able", "about", "above", "absent",
            "absorb", "abstract", "absurd", "abuse", "access", "accident",
            "account", "accuse", "achieve", "acid", "acoustic", "acquire",
            "across", "act", "action", "actor", "actress", "actual",
          ],
        };
      }

      case "reveal_private_key": {
        const p = params as { address: string; passphrase: string };
        if (!p.passphrase || p.passphrase.length < 4) {
          throw new Error("Keystore locked: wrong passphrase");
        }
        if (!s.addresses.find((a) => a.address === p.address)) {
          throw new Error(`Wallet not found: ${p.address}`);
        }
        return {
          address: p.address,
          secret_hex: fakeHex(`sk-${p.address}`, 64),
        };
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
