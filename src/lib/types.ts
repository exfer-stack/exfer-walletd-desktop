// Mirrors the BootstrapStatus enum on the Rust side
// (src-tauri/src/walletd_supervisor.rs).
export type BootstrapStatus =
  | { status: "needs_password" }
  | { status: "ready"; local_addr: string; fingerprint: string }
  | { status: "failed"; message: string };

// Wire shape from walletd's `get_wallet_balance` — see
// exfer-walletd's docs/src/rpc-reference.md.
export interface WalletEntry {
  address: string;
  index: number | null;
  label: string | null;
  imported: boolean;
  balance: number;
  // Unconfirmed (mempool) view, present when balance is polled with
  // { pending: true }. `pending_received` is incoming value sitting in
  // the mempool — visible seconds after a sender broadcasts, ahead of
  // confirmation. `pending_spent` is this address's outputs being spent
  // by an unconfirmed tx. Both omitted against a node too old to answer
  // get_address_mempool.
  pending_received?: number;
  pending_spent?: number;
  // Omitted when balance is polled with { utxos: false }; populated on
  // demand via the wallet provider's refreshUtxos().
  utxo_count?: number;
  truncated?: boolean;
}

export interface WalletBalance {
  entries: WalletEntry[];
  total: number;
  // Confirmed + unconfirmed credit − unconfirmed debit, summed over the
  // entries here. Equals `total` when there's nothing pending.
  projected: number;
  // False when the upstream node predates get_address_mempool, so no
  // pending signal is available and `projected` falls back to `total`.
  pending_supported: boolean;
}

export interface GeneratedAddress {
  address: string;
  /// HD derivation index — present only for legacy seeded `generate_address`.
  /// Independent (1:1) keys from `generate_independent_address` have none.
  index?: number;
  pubkey: string;
  /// True for an independent 1:1 key (the keyring-model default).
  imported?: boolean;
}

export interface TransferReceipt {
  tx_id: string;
  size: number;
  fee: number;
  fee_rate: number;
  inputs: { tx_id: string; output_index: number; value: number }[];
  outputs: { to: string; amount: number; is_change: boolean }[];
  built_at_height: number;
}

// ── Cross-chain swap (EXFER ↔ BNB on BSC) ───────────────────────────────
// Thin UI over walletd's swap engine. The daemon owns the preimage and both
// HTLC legs; the frontend just drives swap_get_quote → swap_execute → poll
// swap_status. These mirror walletd's SwapRecord (serde snake_case) — see
// exfer-walletd src/swap.rs / src/api/swap.rs. The swap_*/bsc_* RPCs only
// answer when walletd was started with a swap pool URL (DEFAULT_SWAP_POOL_URL
// in walletd_supervisor.rs); otherwise they return -32602 and the Swap UI
// degrades to hidden.

export type SwapDirection = "exfer_to_bnb" | "bnb_to_exfer";

export type SwapStatus =
  | "quoted"
  | "user_locked"
  | "pool_locked"
  | "claiming"
  | "completed"
  | "refunding"
  | "refunded"
  | "failed";

/** Subset of walletd's SwapRecord the UI reads (quote / execute / status). */
export interface SwapRec {
  swap_id: string;
  direction: SwapDirection;
  status: SwapStatus;
  amount_in: string;
  amount_out: string;
  fee_bps?: number;
  /** Pool's settlement-gas fee (human BNB), already deducted from amount_out. */
  network_fee_bnb?: string | null;
  our_bsc_address?: string | null;
  error?: string | null;
}

/** Lighter row returned by swap_list — used by the SwapWatcher. */
export interface SwapLite {
  swap_id: string;
  direction: SwapDirection;
  status: string;
  amount_out: string;
}

/** Raw wire shape of swap_pool_info (reserves may be string|number|null). */
export interface PoolInfoRaw {
  mid_price_bnb_per_exfer: number;
  fee_bps: number;
  exfer_reserve: number | string | null;
  bnb_reserve: number | string | null;
  max_swap_bps: number | null;
}

/** Normalized pool info the UI works with. */
export interface PoolInfo {
  mid: number;
  feeBps: number;
  exferReserve: number;
  bnbReserve: number;
  maxSwapBps: number;
}
