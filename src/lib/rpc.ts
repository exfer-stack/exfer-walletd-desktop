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

/// Desktop UX cap on managed addresses. walletd itself supports ~4B
/// HD indices, but a personal desktop wallet stays legible (and the
/// per-address balance fan-out stays light on the public node's
/// rate limit) when kept small. Raise if a power-user build needs more.
export const MAX_ADDRESSES = 6;

const EXFER_UNIT = 100_000_000; // 1 EXFER = 1e8 exfers

export function formatExfer(exfers: number): string {
  const whole = Math.floor(exfers / EXFER_UNIT);
  const frac = exfers % EXFER_UNIT;
  // Group the integer part with thin thousands separators so large
  // balances are scannable (e.g. 1,234,567.00000000).
  const wholeGrouped = whole.toLocaleString("en-US");
  return `${wholeGrouped}.${frac.toString().padStart(8, "0")} EXFER`;
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
