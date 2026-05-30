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

export function getNodeRpc(): Promise<string> {
  if (devmock.isActive()) return devmock.get_node_rpc();
  return invoke<string>("get_node_rpc");
}

export function setNodeRpc(url: string): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.set_node_rpc(url);
  return invoke<BootstrapStatus>("set_node_rpc", { url });
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
