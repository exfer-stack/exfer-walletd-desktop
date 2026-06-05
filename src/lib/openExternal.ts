import { invoke } from "@tauri-apps/api/core";
import { devmock } from "./devmock";

/** Open a URL in the user's default system browser.
 *
 *  In the Tauri shell a bare `<a target="_blank">` is a no-op (the webview can't
 *  spawn the system browser), so route through the `open_external` Rust command.
 *  Under browser-dev (no Tauri) fall back to a normal new tab. Any failure also
 *  falls back to window.open so a link is never a dead end. */
export async function openExternal(url: string): Promise<void> {
  // devmock.isActive() === true means we're NOT in Tauri (plain browser dev).
  if (devmock.isActive()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    await invoke("open_external", { url });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
