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
  utxo_count: number;
  truncated: boolean;
}

export interface WalletBalance {
  entries: WalletEntry[];
  total: number;
}

export interface GeneratedAddress {
  address: string;
  index: number;
  pubkey: string;
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
