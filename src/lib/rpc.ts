import { invoke } from "@tauri-apps/api/core";
import type { BootstrapStatus } from "./types";
import { devmock } from "./devmock";

/// Forward a JSON-RPC call through the Rust shell to the embedded
/// walletd. The shell picks the right scoped token + handles TLS
/// pinning; we just hand it method + params.
///
/// Falls back to an in-browser mock when we're not running inside a
/// Tauri webview — lets us iterate UI in `npm run dev` without the
/// Tauri Linux prereqs. Real Tauri builds never hit the mock branch.
export function rpc<T = unknown>(
  method: string,
  params?: unknown,
): Promise<T> {
  if (devmock.isActive()) {
    return devmock.rpc(method, params ?? {}) as Promise<T>;
  }
  return invoke<T>("rpc", {
    method,
    params: params ?? {},
  });
}

export function bootstrapStatus(): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.bootstrap_status();
  return invoke<BootstrapStatus>("bootstrap_status");
}

export function submitPassword(password: string): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.submit_password(password);
  return invoke<BootstrapStatus>("submit_password", { password });
}

export function restoreFromMnemonic(
  phrase: string,
  password: string,
): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.restore_from_mnemonic(phrase, password);
  return invoke<BootstrapStatus>("restore_from_mnemonic", { phrase, password });
}

/** A 24-word phrase maps to two different addresses depending on the
 *  derivation scheme. "standard" is what exfer.dev / the mobile wallet
 *  produce (BIP39 → EXFER-MNEMONIC-ED25519); "legacy" treats the words as a
 *  raw private key (walletd's own per-address backup phrase). */
export type MnemonicScheme = "standard" | "legacy";

/** One candidate address for a phrase, with its on-chain balance (null when
 *  the chain is unreachable — the address is still valid, balance just unknown). */
export type MnemonicCandidate = { address: string; balance: number | null };

/// Preview both addresses a 24-word phrase maps to (standard BIP39 vs legacy
/// raw-key) WITH each one's on-chain balance, so the user picks the one that
/// holds their coins. Derives locally + does a read-only balance query;
/// imports nothing.
export function previewMnemonicImport(
  phrase: string,
): Promise<{ standard: MnemonicCandidate; legacy: MnemonicCandidate }> {
  if (devmock.isActive()) return devmock.preview_mnemonic_import(phrase);
  return invoke("preview_mnemonic_import", { phrase });
}

/// Import a 24-word phrase under the chosen scheme. Standard re-imports a
/// phrase that exfer.dev / the mobile wallet exported to the SAME address;
/// legacy is walletd's raw-key encoding. The address joins as an independent
/// key (it does not touch the HD seed used by full restore).
export function importMnemonicScheme(
  phrase: string,
  scheme: MnemonicScheme,
  label?: string,
): Promise<{ address: string }> {
  if (devmock.isActive())
    return devmock.import_mnemonic_scheme(phrase, scheme, label);
  return invoke("import_mnemonic_scheme", {
    phrase,
    scheme,
    label: label ?? null,
  });
}

/// Reveal the wallet's BSC/EVM private key (m/44'/60'/0'/0/0) for import into
/// MetaMask. Spend-scoped + passphrase-gated. The hex never gets persisted —
/// the UI shows it once and clears it.
export function revealEvmPrivateKey(
  passphrase: string,
): Promise<{ address: string; private_key_hex: string }> {
  return rpc("reveal_evm_private_key", { passphrase });
}

export function getNodeRpc(): Promise<string> {
  if (devmock.isActive()) return devmock.get_node_rpc();
  return invoke<string>("get_node_rpc");
}

export function setNodeRpc(url: string): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.set_node_rpc(url);
  return invoke<BootstrapStatus>("set_node_rpc", { url });
}

export interface IndexerConfig {
  /** Configured indexer URL; empty string ⇒ the app uses its built-in default.
   *  The indexer is anonymous (public read-only chain data) — no token. */
  rpc: string;
}

export function getIndexerConfig(): Promise<IndexerConfig> {
  if (devmock.isActive()) return devmock.get_indexer_config();
  return invoke<IndexerConfig>("get_indexer_config");
}

export function setIndexerConfig(rpc: string): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.set_indexer_config(rpc);
  return invoke<BootstrapStatus>("set_indexer_config", { rpc });
}

export interface SwapConfig {
  /** Swap pool URL; empty string ⇒ swap engine OFF. */
  pool_url: string;
  /** BSC JSON-RPC URL; empty ⇒ walletd's mainnet dataseed default. */
  bsc_rpc_url: string;
  /** BSC chain id; 0 ⇒ walletd default (56, mainnet). 97 = Chapel testnet. */
  bsc_chain_id: number;
}

export function getSwapConfig(): Promise<SwapConfig> {
  if (devmock.isActive())
    return Promise.resolve({ pool_url: "", bsc_rpc_url: "", bsc_chain_id: 0 });
  return invoke<SwapConfig>("get_swap_config");
}

export function setSwapConfig(cfg: SwapConfig): Promise<BootstrapStatus> {
  if (devmock.isActive())
    return invoke<BootstrapStatus>("bootstrap_status"); // dev: no-op
  return invoke<BootstrapStatus>("set_swap_config", {
    poolUrl: cfg.pool_url,
    bscRpcUrl: cfg.bsc_rpc_url,
    bscChainId: cfg.bsc_chain_id,
  });
}

export function resetWallet(): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.reset_wallet();
  return invoke<BootstrapStatus>("reset_wallet");
}

/// Export one address as an official Exfer `wallet.key` (EXFK) file at
/// `dest`, encrypted with `exportPassword`. `walletPassword` authorizes
/// pulling the secret from walletd. Importable on exfer.dev.
export function exportWalletKey(args: {
  address: string;
  walletPassword: string;
  exportPassword: string;
  dest: string;
}): Promise<void> {
  if (devmock.isActive()) return devmock.export_wallet_key(args);
  return invoke<void>("export_wallet_key", {
    address: args.address,
    walletPassword: args.walletPassword,
    exportPassword: args.exportPassword,
    dest: args.dest,
  });
}

/// Import a `wallet.key` (EXFK) file as a non-derived address. `path`
/// points to the file on disk; `filePassword` decrypts it. The Rust
/// shell parses the file, hands the raw secret to walletd's
/// `import_private_key` RPC, and returns the resulting address.
export function importWalletKey(args: {
  path: string;
  filePassword: string;
  label?: string;
}): Promise<string> {
  if (devmock.isActive()) return devmock.import_wallet_key(args);
  return invoke<string>("import_wallet_key", {
    path: args.path,
    filePassword: args.filePassword,
    label: args.label ?? null,
  });
}

/// Export the WHOLE keyring as one passphrase-sealed vault file at
/// `dest`. The keyring-model backup: a single encrypted file, no seed
/// phrase to copy. `walletPassword` authorizes + seals it. Restore with
/// `importVaultFile` using that same password.
export function exportVaultFile(args: {
  walletPassword: string;
  dest: string;
}): Promise<void> {
  if (devmock.isActive()) return devmock.export_vault_file(args);
  return invoke<void>("export_vault_file", {
    walletPassword: args.walletPassword,
    dest: args.dest,
  });
}

/// Restore keys from a vault file written by `exportVaultFile`.
/// `filePassword` is the password the backup was created with. Returns the
/// count of addresses newly restored (already-present ones are skipped).
export function importVaultFile(args: {
  path: string;
  filePassword: string;
}): Promise<number> {
  if (devmock.isActive()) return devmock.import_vault_file(args);
  return invoke<number>("import_vault_file", {
    path: args.path,
    filePassword: args.filePassword,
  });
}

/// Desktop UX cap on managed addresses. walletd itself supports ~4B
/// HD indices, but a personal desktop wallet stays legible (and the
/// per-address balance fan-out stays light on the public node's
/// rate limit) when kept small. Raise if a power-user build needs more.
export const MAX_ADDRESSES = 6;

const EXFER_UNIT = 100_000_000; // 1 EXFER = 1e8 exfers

export function formatExfer(exfers: number): string {
  const { whole, frac } = splitExfer(exfers);
  return frac ? `${whole}.${frac} EXFER` : `${whole} EXFER`;
}

/** Split a balance into grouped integer + fraction (no unit), so the hero
 *  can lead with the whole number and let the fraction recede. Trailing
 *  zeros are dropped — "0.10000000" reads as "0.1"; a whole number returns
 *  an empty `frac`. */
export function splitExfer(exfers: number): { whole: string; frac: string } {
  const whole = Math.floor(exfers / EXFER_UNIT).toLocaleString("en-US");
  const frac = (exfers % EXFER_UNIT)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return { whole, frac };
}

/** How many fractional digits the *compact* headline shows before it stops.
 *  Full precision still lives in tooltips and on the Send / receipt screens. */
const COMPACT_DECIMALS = 4;

/** Compact display split for the dashboard headline + rows: integer in full,
 *  fraction capped so an 8-decimal balance like 0.79999862 reads as "0.7999"
 *  instead of a long tail. Truncated toward zero (never rounded up) so it can
 *  never *overstate* funds. Sub-0.0001 amounts keep going to the first few
 *  significant digits so tiny balances don't collapse to "0". `truncated` is
 *  true when real digits were dropped (caller can offer the full value on
 *  hover). This mirrors how Coinbase/MetaMask/Phantom show a short balance up
 *  top and the exact figure on the detail view. */
export function splitBalanceCompact(exfers: number): {
  whole: string;
  frac: string;
  truncated: boolean;
} {
  const wholeNum = Math.floor(exfers / EXFER_UNIT);
  const whole = wholeNum.toLocaleString("en-US");
  const fracFull = (exfers % EXFER_UNIT).toString().padStart(8, "0");
  let cut = COMPACT_DECIMALS;
  if (wholeNum === 0) {
    const firstSig = fracFull.search(/[1-9]/);
    if (firstSig >= COMPACT_DECIMALS) cut = Math.min(8, firstSig + 3);
  }
  const frac = fracFull.slice(0, cut).replace(/0+$/, "");
  const truncated = fracFull.slice(cut).replace(/0+$/, "") !== "";
  return { whole, frac, truncated };
}

/** Compact one-line balance, e.g. "1,234.5 EXFER". */
export function formatBalanceCompact(exfers: number): string {
  const { whole, frac } = splitBalanceCompact(exfers);
  return frac ? `${whole}.${frac} EXFER` : `${whole} EXFER`;
}

/** A plain, NON-grouped decimal string for an exfers amount — safe to write
 *  INTO an amount <input> that `parseExferAmount` will later re-parse. The
 *  display formatters (`formatExfer` / `formatBalanceCompact` / `splitExfer`)
 *  insert `toLocaleString` comma thousands-separators, which `parseExferAmount`
 *  REJECTS — so feeding their output back into an input silently breaks Send/
 *  Swap "Max" for any balance ≥ 1,000 EXFER. Use this for round-tripping. */
export function formatExferInput(exfers: number): string {
  const e = Math.max(0, Math.floor(exfers));
  const whole = Math.floor(e / EXFER_UNIT).toString();
  const frac = (e % EXFER_UNIT).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function parseExferAmount(input: string): number {
  // Accepts "1.234" → 123_400_000 exfers. Throws on garbage.
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(trimmed)) {
    throw new Error("amount must be a decimal with up to 8 fractional digits");
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = frac.padEnd(8, "0");
  return Number(whole) * EXFER_UNIT + Number(fracPadded);
}
