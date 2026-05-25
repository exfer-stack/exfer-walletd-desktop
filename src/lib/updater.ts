// In-app auto-update. Tauri-only; no-ops in browser dev mode.
//
// Flow: check() asks the updater plugin to fetch latest.json from the
// GitHub release, compare versions, and (if newer) hand back an Update
// handle. downloadAndApply() streams + verifies (ed25519 against the
// pubkey baked into tauri.conf.json), installs, and relaunches.

import { devmock } from "./devmock";

export interface UpdateInfo {
  available: boolean;
  version?: string;
  notes?: string;
}

// Cache the pending Update handle between check() and apply() so the
// Settings button can show "vX available → Install" without re-fetching.
let pending: import("@tauri-apps/plugin-updater").Update | null = null;

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (devmock.isActive()) return { available: false };
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update) {
      pending = update;
      return {
        available: true,
        version: update.version,
        notes: update.body ?? undefined,
      };
    }
    pending = null;
    return { available: false };
  } catch (e) {
    // Network error / no published release yet / draft-only release →
    // treat as "no update" rather than surfacing a scary error on launch.
    console.warn("update check failed", e);
    return { available: false };
  }
}

export type ProgressFn = (downloaded: number, total: number | null) => void;

export async function downloadAndApply(onProgress?: ProgressFn): Promise<void> {
  if (devmock.isActive()) return;
  if (!pending) {
    // Re-check if we don't hold a handle (e.g. user clicked Install
    // after a manual check elsewhere).
    const { check } = await import("@tauri-apps/plugin-updater");
    pending = await check();
    if (!pending) throw new Error("No update available");
  }
  let downloaded = 0;
  let total: number | null = null;
  await pending.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, total);
        break;
      case "Finished":
        onProgress?.(total ?? downloaded, total);
        break;
    }
  });
  // Relaunch into the freshly-installed version.
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
