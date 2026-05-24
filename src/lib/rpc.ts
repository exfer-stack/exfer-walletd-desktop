import { invoke } from "@tauri-apps/api/core";
import type { BootstrapStatus } from "./types";

/// Forward a JSON-RPC call through the Rust shell to the embedded
/// walletd. The shell picks the right scoped token + handles TLS
/// pinning; we just hand it method + params.
export function rpc<T = unknown>(
  method: string,
  params?: unknown,
): Promise<T> {
  return invoke<T>("rpc", {
    method,
    params: params ?? {},
  });
}

export function bootstrapStatus(): Promise<BootstrapStatus> {
  return invoke<BootstrapStatus>("bootstrap_status");
}

export function submitPassword(password: string): Promise<BootstrapStatus> {
  return invoke<BootstrapStatus>("submit_password", { password });
}

export function getNodeRpc(): Promise<string> {
  return invoke<string>("get_node_rpc");
}

export function setNodeRpc(url: string): Promise<BootstrapStatus> {
  return invoke<BootstrapStatus>("set_node_rpc", { url });
}

const EXFER_UNIT = 100_000_000; // 1 EXFER = 1e8 exfers

export function formatExfer(exfers: number): string {
  const whole = Math.floor(exfers / EXFER_UNIT);
  const frac = exfers % EXFER_UNIT;
  return `${whole}.${frac.toString().padStart(8, "0")} EXFER`;
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
