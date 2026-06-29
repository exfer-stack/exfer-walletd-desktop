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
    // True for an independent 1:1 key (the keyring-model default) — vs a
    // legacy HD-derived address. Drives nothing visual anymore but kept so
    // dev mode mirrors the daemon's list shape.
    imported?: boolean;
    // Optional mocked unconfirmed credit, surfaced when get_wallet_balance
    // is called with { pending: true } — lets dev mode exercise the
    // pending/incoming UI without a live mempool.
    pendingIn?: number;
  }>;
}

function defaultState(): DevState {
  return {
    bootstrap: { status: "needs_password" },
    nodeRpc: "http://80.78.31.82:9334",
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
  if (
    method === "transfer" ||
    method === "send_raw_transaction" ||
    method === "sign_message" ||
    method === "reveal_mnemonic" ||
    method === "reveal_private_key" ||
    method === "reveal_evm_private_key" ||
    method === "reveal_address_mnemonic" ||
    method === "export_vault" ||
    method === "export_address" ||
    method === "import_vault" ||
    method === "delete_address" ||
    // HTLC lifecycle moves funds — Spend.
    method === "htlc_lock" ||
    method === "htlc_claim" ||
    method === "htlc_reclaim" ||
    // Cross-chain swap: quote reserves a preimage, execute/refund move funds,
    // bsc_send_bnb withdraws BNB — all Spend, else walletd 401s with -32001.
    method === "swap_get_quote" ||
    method === "swap_execute" ||
    method === "swap_refund" ||
    method === "swap_refresh" ||
    method === "bsc_send_bnb" ||
    // BSC/EVM recovery-phrase reveal + key deletion expose/strand funds;
    // lp_withdraw_self pays out the pool to the user — all Spend.
    method === "bsc_reveal_mnemonic" ||
    method === "bsc_delete_key" ||
    method === "lp_withdraw_self"
  )
    return "spend";
  if (
    method === "generate_address" ||
    method === "generate_independent_address" ||
    method === "generate_standard_address" ||
    method === "import_private_key" ||
    method === "import_mnemonic" ||
    method === "import_standard_mnemonic" ||
    // BSC/EVM independent-key provisioning mutates the keystore (no funds).
    method === "bsc_create_address" ||
    method === "bsc_import_mnemonic" ||
    method === "bsc_import_key" ||
    method === "htlc_forget" ||
    method === "abandon_transfer"
  )
    return "manage";
  return "read";
}

// A deterministic 24-word phrase from a seed, for dev display only (NOT a
// real BIP-39 mnemonic). Lets the recovery-phrase UI render without a
// backend.
const MOCK_WORDS = [
  "ball", "panel", "web", "field", "blossom", "hire", "sketch", "viable",
  "fragile", "museum", "cherry", "talent", "today", "sentence", "truth",
  "camp", "dose", "essence", "crime", "patrol", "guard", "lunar", "manage",
  "supply", "ocean", "ladder", "velvet", "puzzle", "garden", "rocket",
];
function mockMnemonic(seed: string): string[] {
  const hex = fakeHex(seed, 48);
  return Array.from({ length: 24 }, (_, i) => {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return MOCK_WORDS[byte % MOCK_WORDS.length];
  });
}

// ── vote server (exfer-vote) dev transport + in-memory mock ─────────────────
// Mirrors the walletd dual mode: when VITE_VOTE_PROXY_TARGET points the Vite
// `/__vote` proxy at a real exfer-vote service, hit it; otherwise synthesise
// realistic proposals/results so `npm run dev` works fully in-browser.

const VOTE_BASE = "/__vote";

function useRealVote(): boolean {
  return !!import.meta.env.VITE_VOTE_PROXY_TARGET;
}

// Two open + one upcoming + one finalized proposal, with a live tally on the
// open ones. min_power = 50,000 EXFER. Persisted votes live in MOCK_VOTES so
// re-vote / latest-nonce / live-bar behaviour is exercisable in the browser.
const MOCK_MIN_POWER = 5_000_000_000_000; // 50,000 EXFER
const _voteNow = Math.floor(Date.now() / 1000);

const MOCK_PROPOSALS = [
  {
    id: "eip-014-buyback",
    title: {
      en: "Use 30% of swap fees for buyback & burn",
      zh: "将交易手续费的 30% 用于回购销毁",
    },
    description: {
      en: "Route 30% of monthly protocol fee revenue into a buyback vault that buys EXFER on the open market and sends it to an unspendable burn address. Buybacks run weekly and are verifiable on-chain — an estimated ~18,000 EXFER/month burned, tightening circulating supply over the long term.",
      zh: "把每月手续费收入的 30% 自动注入回购金库,由金库在公开市场买入 EXFER 并发送至不可花费的销毁地址。回购按周执行、链上可查。预计每月销毁约 18,000 EXFER,长期收紧流通供应。",
    },
    options: [
      { id: "opt_a", label: { en: "For — enable 30% buyback & burn", zh: "赞成 —— 启用 30% 回购销毁" } },
      { id: "opt_b", label: { en: "Against — keep the status quo", zh: "反对 —— 维持现状,不做回购" } },
      { id: "opt_c", label: { en: "Abstain — count me as present", zh: "弃权 —— 计入参与,不站队" } },
    ],
    voting_window: { open_time: _voteNow - 86_400, close_time: _voteNow + 30 * 3600 },
    status: "open" as const,
    min_power: MOCK_MIN_POWER,
    spot_check: { window_days: 7 },
    results: {
      finalized_at_height: null,
      spot_check_heights: [] as number[],
      total_voters: 3047,
      total_power: "318400000000000", // 3,184,000 EXFER
      by_option: {
        opt_a: "194200000000000",
        opt_b: "98700000000000",
        opt_c: "25500000000000",
      } as Record<string, string>,
    },
  },
  {
    id: "eip-013-hk-node",
    title: {
      en: "Add a DMIT Hong Kong node reachable from mainland China",
      zh: "新增 DMIT 香港节点接入中国大陆",
    },
    description: {
      en: "Deploy an official exfer node on a Hong Kong CN2 GIA line reachable from mainland China to improve domestic connectivity.",
      zh: "在香港 CN2 GIA 线路部署一个面向中国大陆可达的官方 exfer 节点,改善国内连接质量。",
    },
    options: [
      { id: "opt_a", label: { en: "For", zh: "赞成" } },
      { id: "opt_b", label: { en: "Against", zh: "反对" } },
      { id: "opt_c", label: { en: "Abstain", zh: "弃权" } },
    ],
    voting_window: { open_time: _voteNow - 2 * 86_400, close_time: _voteNow + 4 * 86_400 },
    status: "open" as const,
    min_power: MOCK_MIN_POWER,
    spot_check: { window_days: 7 },
    results: {
      finalized_at_height: null,
      spot_check_heights: [] as number[],
      total_voters: 1902,
      total_power: "190200000000000",
      by_option: {
        opt_a: "156000000000000",
        opt_b: "26600000000000",
        opt_c: "7600000000000",
      } as Record<string, string>,
    },
  },
  {
    id: "eip-015-feecut",
    title: {
      en: "Cut the cross-chain swap fee from 0.30% to 0.20%",
      zh: "把跨链兑换费率从 0.30% 下调到 0.20%",
    },
    description: {
      en: "Lower the EXFER↔USDT cross-chain swap pool fee to a more competitive rate to attract more volume.",
      zh: "降低 EXFER↔USDT 跨链兑换的池子手续费,以更有竞争力的价格吸引更多兑换量。",
    },
    options: [
      { id: "opt_a", label: { en: "Approve", zh: "通过" } },
      { id: "opt_b", label: { en: "Reject", zh: "否决" } },
    ],
    voting_window: { open_time: _voteNow + 2 * 86_400, close_time: _voteNow + 9 * 86_400 },
    status: "upcoming" as const,
    min_power: MOCK_MIN_POWER,
    spot_check: { window_days: 7 },
    results: null,
  },
  {
    id: "eip-012-swapcap",
    title: {
      en: "Raise the single-swap cap to 5% of pool depth",
      zh: "将单笔兑换上限提升至池子深度的 5%",
    },
    description: {
      en: "Relax the soft single-swap cap so large users can complete a swap in one go while keeping slippage protection.",
      zh: "放宽单笔兑换的软上限,方便大额用户一次性完成兑换,同时保留滑点保护。",
    },
    options: [
      { id: "opt_a", label: { en: "Approve", zh: "通过" } },
      { id: "opt_b", label: { en: "Reject", zh: "否决" } },
    ],
    voting_window: { open_time: _voteNow - 20 * 86_400, close_time: _voteNow - 10 * 86_400 },
    status: "finalized" as const,
    min_power: MOCK_MIN_POWER,
    spot_check: { window_days: 7 },
    results: {
      finalized_at_height: 690_120,
      spot_check_heights: [688_400, 689_700],
      total_voters: 5210,
      total_power: "521000000000000",
      by_option: {
        opt_a: "385400000000000",
        opt_b: "135600000000000",
      } as Record<string, string>,
    },
  },
  {
    id: "eip-011-halving",
    title: {
      en: "Halve the block-reward halving interval",
      zh: "将区块出块奖励减半周期缩短一半",
    },
    description: {
      en: "Speed up the halving schedule to enter deflation sooner; failed to reach the threshold over miner-incentive concerns.",
      zh: "提议加快减半节奏以提前进入通缩,因社区担心矿工激励不足而未达通过门槛。",
    },
    options: [
      { id: "opt_a", label: { en: "Approve", zh: "通过" } },
      { id: "opt_b", label: { en: "Reject", zh: "否决" } },
    ],
    voting_window: { open_time: _voteNow - 30 * 86_400, close_time: _voteNow - 20 * 86_400 },
    status: "finalized" as const,
    min_power: MOCK_MIN_POWER,
    spot_check: { window_days: 7 },
    results: {
      finalized_at_height: 670_900,
      spot_check_heights: [668_100, 669_500],
      total_voters: 4488,
      total_power: "448800000000000",
      by_option: {
        opt_a: "170500000000000",
        opt_b: "278300000000000",
      } as Record<string, string>,
    },
  },
];

// address -> { proposalId -> { option_id, nonce, power } }
interface MockVote {
  option_id: string;
  nonce: number;
  power: number;
}
const MOCK_VOTES: Record<string, Record<string, MockVote>> = {};

function mockProposalById(id: string) {
  return MOCK_PROPOSALS.find((p) => p.id === id);
}

async function realVoteFetch(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const resp = await fetch(VOTE_BASE + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  const json = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    const msg = (json && (json.error || json.message)) || `vote server ${resp.status}`;
    throw new Error(String(msg));
  }
  return json;
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

  async restore_from_mnemonic(
    phrase: string,
    password: string,
  ): Promise<BootstrapStatus> {
    if (password.length < 8) throw new Error("password must be at least 8 characters");
    if (phrase.trim().split(/\s+/).length !== 24) {
      throw new Error("recovery phrase must be 24 words");
    }
    // Dev mode: pretend the restore worked and seed a couple addresses.
    const s = loadState();
    s.bootstrap = {
      status: "ready",
      local_addr: "127.0.0.1:54321",
      fingerprint: "sha256:dev-mock-fingerprint",
    };
    s.addresses = [0, 1, 2].map((index) => ({
      address: fakeHex(`restored-${index}`, 64),
      index,
      pubkey: fakeHex(`rpk-${index}`, 64),
      balance: 0,
      utxoCount: 0,
    }));
    saveState(s);
    return s.bootstrap;
  },

  /// Preview the two candidate addresses for a phrase, with fake balances so
  /// the picker / "found your wallet" UX is exercisable in browser dev. By
  /// default the standard candidate is funded (the common case).
  async preview_mnemonic_import(
    phrase: string,
  ): Promise<{
    standard: { address: string; balance: number | null };
    legacy: { address: string; balance: number | null };
  }> {
    if (phrase.trim().split(/\s+/).length !== 24) {
      throw new Error("recovery phrase must be 24 words");
    }
    const key = phrase.trim();
    return {
      standard: { address: fakeHex(`std-${key}`, 64), balance: 125_000_000 },
      legacy: { address: fakeHex(`legacy-${key}`, 64), balance: 0 },
    };
  },

  /// Import a phrase under the chosen scheme; mirrors the `import_mnemonic`
  /// case but keyed by scheme so the address matches the preview.
  async import_mnemonic_scheme(
    phrase: string,
    scheme: string,
    _label?: string,
  ): Promise<{ address: string }> {
    if (phrase.trim().split(/\s+/).length !== 24) {
      throw new Error("recovery phrase must be 24 words");
    }
    const s = loadState();
    const prefix = scheme === "legacy" ? "legacy" : "std";
    const address = fakeHex(`${prefix}-${phrase.trim()}`, 64);
    if (!s.addresses.find((a) => a.address === address)) {
      s.addresses.push({
        address,
        index: s.addresses.length,
        pubkey: fakeHex(`mnpk-${address.slice(0, 8)}`, 64),
        balance: 0,
        utxoCount: 0,
        imported: true,
      });
      saveState(s);
    }
    return { address };
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

  async get_indexer_config(): Promise<{ rpc: string }> {
    // Dev mode talks to walletd over the proxy; the indexer endpoint is the
    // daemon's own config, not the webapp's. Report blank (= "use default").
    return { rpc: "" };
  },

  async set_indexer_config(_rpc: string): Promise<BootstrapStatus> {
    if (useRealWalletd()) {
      throw new Error(
        "Changing the indexer requires restarting the daemon in real-walletd dev mode.",
      );
    }
    return loadState().bootstrap as BootstrapStatus;
  },

  async reset_wallet(): Promise<BootstrapStatus> {
    // Dev mode: wipe local mock state back to first-run.
    localStorage.removeItem(DEV_STATE_KEY);
    return { status: "needs_password" };
  },

  async export_wallet_key(args: {
    address: string;
    exportPassword: string;
  }): Promise<void> {
    // Dev mode can't write files / build EXFK; just validate inputs so
    // the modal flow is exercisable.
    if (args.exportPassword.length < 6) {
      throw new Error("export password must be at least 6 characters");
    }
    // no-op: a real Tauri build writes the .key file.
  },

  async import_wallet_key(args: {
    path: string;
    filePassword: string;
    label?: string;
  }): Promise<string> {
    // Dev mode can't read EXFK files; fabricate a fake "imported" address
    // so the modal flow is exercisable end-to-end in the browser.
    if (!args.path) throw new Error("no wallet.key file selected");
    if (!args.filePassword) throw new Error("file password required");
    const s = loadState();
    const address = fakeHex(`imported-${Date.now()}`, 64);
    s.addresses.push({
      address,
      index: s.addresses.length,
      pubkey: fakeHex(`pk-imp-${address.slice(0, 8)}`, 64),
      balance: 0,
      utxoCount: 0,
    });
    saveState(s);
    return address;
  },

  async export_vault_file(args: {
    walletPassword: string;
    dest: string;
  }): Promise<void> {
    // Dev mode can't write files; just validate so the flow is exercisable.
    if (!args.walletPassword) throw new Error("wallet password required");
    // no-op: a real Tauri build writes the sealed .vault file.
  },

  async import_vault_file(args: {
    path: string;
    filePassword: string;
  }): Promise<number> {
    // Dev mode can't read files; fabricate a couple of restored addresses
    // so the restore flow is exercisable end-to-end in the browser.
    if (!args.path) throw new Error("no backup file selected");
    if (!args.filePassword) throw new Error("file password required");
    const s = loadState();
    let added = 0;
    for (let i = 0; i < 2; i++) {
      const address = fakeHex(`vault-${args.path}-${i}`, 64);
      if (s.addresses.find((a) => a.address === address)) continue;
      s.addresses.push({
        address,
        index: s.addresses.length,
        pubkey: fakeHex(`vpk-${address.slice(0, 8)}`, 64),
        balance: 0,
        utxoCount: 0,
        imported: true,
      });
      added++;
    }
    saveState(s);
    return added;
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

      // Governance voting signs a canonical payload via walletd's
      // sign_message (Spend scope). Dev mode can't run Ed25519, so we
      // return a deterministic fake { signature, pubkey, address } — enough
      // for the vote_api_post mock to accept the vote and move the live bar.
      case "sign_message": {
        const p = (params ?? {}) as { address?: string; message?: string };
        if (!p.address) throw new Error("sign_message: address required");
        if (!p.message) throw new Error("sign_message: message required");
        const a = s.addresses.find((x) => x.address === p.address);
        return {
          address: p.address,
          pubkey: a?.pubkey ?? fakeHex(`pk-${p.address}`, 64),
          signature: fakeHex(`sig-${p.address}-${p.message}`, 128),
        };
      }

      case "list_addresses":
        return {
          addresses: s.addresses.map((a) => ({
            address: a.address,
            // Imported addresses have no HD index — surface that so the
            // UI's "Imported" pill works in dev mode too.
            ...(a.pubkey.startsWith("pk-imp-")
              ? { imported: true }
              : { index: a.index, imported: false }),
            label: null,
          })),
        };

      case "get_wallet_balance": {
        // Mirror the daemon: utxo_count/truncated only when utxos !== false,
        // and pending_received/pending_spent only when pending === true.
        const p = params as { utxos?: boolean; pending?: boolean };
        const withUtxos = p?.utxos !== false;
        const withPending = p?.pending === true;
        const entries: WalletEntry[] = s.addresses.map((a) => ({
          address: a.address,
          index: a.index,
          label: null,
          imported: false,
          balance: a.balance,
          ...(withUtxos
            ? { utxo_count: a.utxoCount, truncated: false }
            : {}),
          ...(withPending
            ? { pending_received: a.pendingIn ?? 0, pending_spent: 0 }
            : {}),
        }));
        const total = entries.reduce((acc, e) => acc + e.balance, 0);
        const projected = entries.reduce(
          (acc, e) =>
            acc + e.balance + (e.pending_received ?? 0) - (e.pending_spent ?? 0),
          0,
        );
        const out: WalletBalance = {
          entries,
          total,
          projected,
          pending_supported: withPending,
        };
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

      case "generate_independent_address": {
        // Keyring-model default: a fresh independent 1:1 key (no HD index).
        const n = s.addresses.length;
        const address = fakeHex(`ind-${n}-${Date.now()}`, 64);
        const pubkey = fakeHex(`indpk-${n}`, 64);
        const balance = n === 0 ? Math.floor(0.1 * EXFER_UNIT) : 0;
        s.addresses.push({
          address,
          index: n,
          pubkey,
          balance,
          utxoCount: balance > 0 ? 1 : 0,
          imported: true,
        });
        saveState(s);
        return { address, pubkey, imported: true };
      }

      case "generate_standard_address": {
        // Standard BIP39 address (walletd v1.12+). Dev mock: a fresh fake key.
        const n = s.addresses.length;
        const address = fakeHex(`std-${n}-${Date.now()}`, 64);
        const pubkey = fakeHex(`stdpk-${n}`, 64);
        s.addresses.push({
          address,
          index: n,
          pubkey,
          balance: 0,
          utxoCount: 0,
          imported: true,
        });
        saveState(s);
        return { address, pubkey, imported: true };
      }

      case "reveal_address_mnemonic": {
        const p = params as { address: string; passphrase: string };
        if (!p.passphrase || p.passphrase.length < 4) {
          throw new Error("Keystore locked: wrong passphrase");
        }
        if (!s.addresses.find((a) => a.address === p.address)) {
          throw new Error(`Wallet not found: ${p.address}`);
        }
        return { address: p.address, mnemonic: mockMnemonic(`am-${p.address}`) };
      }

      case "import_mnemonic": {
        const p = params as { mnemonic: string; label?: string };
        if (!p.mnemonic || p.mnemonic.trim().split(/\s+/).length !== 24) {
          throw new Error("recovery phrase must be 24 words");
        }
        const address = fakeHex(`frommn-${p.mnemonic.trim()}`, 64);
        if (!s.addresses.find((a) => a.address === address)) {
          s.addresses.push({
            address,
            index: s.addresses.length,
            pubkey: fakeHex(`mnpk-${address.slice(0, 8)}`, 64),
            balance: 0,
            utxoCount: 0,
            imported: true,
          });
          saveState(s);
        }
        return { address, imported: true };
      }

      case "delete_address": {
        const p = params as { address: string; passphrase: string; force?: boolean };
        if (!p.passphrase || p.passphrase.length < 4) {
          throw new Error("Keystore locked: wrong passphrase");
        }
        const target = s.addresses.find((a) => a.address === p.address);
        if (!target) throw new Error(`Wallet not found: ${p.address}`);
        if (!p.force && target.balance > 0) {
          throw new Error(
            `address ${p.address} still holds ${target.balance} exfers — sweep it first, or force the deletion`,
          );
        }
        s.addresses = s.addresses.filter((a) => a.address !== p.address);
        saveState(s);
        return { deleted: p.address };
      }

      case "simulate_transfer": {
        // No broadcast: just return the exact fee for the template so the
        // Send page can show a live per-tier estimate.
        const p = params as {
          from: string;
          outputs: { to: string; amount: number }[];
          fee_rate?: number;
        };
        const sender = s.addresses.find((a) => a.address === p.from);
        if (!sender) throw new Error("from address not in wallet");
        const total = p.outputs.reduce((a, o) => a + o.amount, 0);
        const cost = 70 + 45 * Math.max(1, p.outputs.length);
        const fee = (p.fee_rate ?? 1) * cost;
        if (sender.balance < total + fee) throw new Error("insufficient balance");
        return {
          size: 180 + 34 * p.outputs.length,
          fee,
          fee_rate: p.fee_rate ?? 1,
        };
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

  // ── vote server (exfer-vote) ─────────────────────────────────────────────
  // GET helper: list / detail / my-vote / results. Real mode hits the proxy;
  // otherwise serves MOCK_PROPOSALS + the in-memory MOCK_VOTES tally.
  async vote_api_get(path: string): Promise<unknown> {
    if (useRealVote()) return realVoteFetch("GET", path);

    const [rawPath, query = ""] = path.split("?");
    const qs = new URLSearchParams(query);

    if (rawPath === "/proposals") {
      return { proposals: MOCK_PROPOSALS };
    }

    // /proposals/:id  |  /proposals/:id/my-vote  |  /proposals/:id/results
    const m = rawPath.match(/^\/proposals\/([^/]+)(\/my-vote|\/results)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2];
      const p = mockProposalById(id);
      if (!p) throw new Error(`proposal not found: ${id}`);

      if (sub === "/my-vote") {
        const addr = qs.get("address") ?? "";
        const v = MOCK_VOTES[addr]?.[id];
        return v ? { option_id: v.option_id } : { option_id: null };
      }

      if (sub === "/results") {
        return this._voteTally(id);
      }

      // detail — merge any live mock votes into the published tally so the
      // detail view shows movement after voting in-browser.
      return { ...p, results: this._voteTally(id) };
    }

    throw new Error(`dev-mock vote_api_get: ${path} not implemented`);
  },

  // POST helper: /votes. Verifies the request shape, snapshots a mock power,
  // records latest-nonce-wins, and returns the credited power.
  async vote_api_post(path: string, body: unknown): Promise<unknown> {
    if (useRealVote()) return realVoteFetch("POST", path, body);

    if (path === "/votes") {
      const b = (body ?? {}) as { payload?: string; signature?: string; pubkey?: string };
      if (!b.payload || !b.signature || !b.pubkey) {
        throw new Error("vote request must carry { payload, signature, pubkey }");
      }
      let parsed: {
        proposal_id?: string;
        option_id?: string;
        address?: string;
        nonce?: number;
      };
      try {
        parsed = JSON.parse(b.payload);
      } catch {
        throw new Error("payload is not valid JSON");
      }
      const id = parsed.proposal_id ?? "";
      const p = mockProposalById(id);
      if (!p) throw new Error(`proposal not found: ${id}`);
      if (p.status !== "open") throw new Error("proposal is not open for voting");
      if (!p.options.some((o) => o.id === parsed.option_id)) {
        throw new Error(`unknown option: ${parsed.option_id}`);
      }
      const addr = parsed.address ?? "";
      const nonce = Number(parsed.nonce ?? 0);

      // latest-nonce-wins
      const prior = MOCK_VOTES[addr]?.[id];
      if (prior && nonce <= prior.nonce) {
        // Stale / replay — ignore, keep the existing vote, echo its power.
        return { power: prior.power };
      }

      // Snapshot "current balance" from the in-memory wallet state, falling
      // back to a plausible eligible power so a non-walletd dev browser still
      // shows a vote landing.
      const a = loadState().addresses.find((x) => x.address === addr);
      const power = a && a.balance > 0 ? a.balance : 12_840_000_000_000; // 128,400 EXFER
      (MOCK_VOTES[addr] ||= {})[id] = { option_id: parsed.option_id!, nonce, power };
      return { power };
    }

    throw new Error(`dev-mock vote_api_post: ${path} not implemented`);
  },

  // Compose the published mock tally with any in-browser votes layered on top.
  _voteTally(id: string): unknown {
    const p = mockProposalById(id);
    if (!p) throw new Error(`proposal not found: ${id}`);
    const base = p.results;
    const byOption: Record<string, string> = {};
    const seedByOption = (base?.by_option ?? {}) as Record<string, string>;
    for (const opt of p.options) byOption[opt.id] = seedByOption[opt.id] ?? "0";
    let totalPower = BigInt(base?.total_power ?? "0");
    let totalVoters = base?.total_voters ?? 0;

    for (const addr of Object.keys(MOCK_VOTES)) {
      const v = MOCK_VOTES[addr][id];
      if (!v) continue;
      byOption[v.option_id] = (
        BigInt(byOption[v.option_id] ?? "0") + BigInt(v.power)
      ).toString();
      totalPower += BigInt(v.power);
      totalVoters += 1;
    }
    return {
      finalized_at_height: base?.finalized_at_height ?? null,
      spot_check_heights: base?.spot_check_heights ?? [],
      total_voters: totalVoters,
      total_power: totalPower.toString(),
      by_option: byOption,
    };
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
