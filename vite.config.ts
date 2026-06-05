import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  // Read .env / .env.local ourselves: Vite does NOT load them into
  // `process.env` for the config file, so a bare `npm run dev` would leave the
  // `/__walletd` proxy below unregistered → the browser-dev mode hits an
  // unproxied path → empty response → "Unexpected end of JSON input". Reading
  // via loadEnv registers the proxy straight from `.env.local`, no shell export.
  const env = loadEnv(mode, process.cwd(), "");
  const walletdTarget = env.VITE_WALLETD_PROXY_TARGET;
  return {
  plugins: [react()],

  build: {
    // Inline the logo (64px) and wordmark (128px) PNGs as base64 data
    // URIs instead of emitting them as separate files. At their post-
    // downscale sizes (~4KB / ~17KB) they paint with the React component
    // that references them, rather than triggering a second HTTP request
    // that can't even start until the JS bundle has booted — which is
    // what made the header logo appear half a beat late. 24KB covers
    // both with headroom; anything larger still emits as a file.
    assetsInlineLimit: 24 * 1024,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Dev-mode proxies (browser, outside Tauri):
    //   /__bnbusd → Binance BNB/USD spot (CORS-blocked from the browser).
    //     Production uses the Rust get_bnb_price command; see lib/market.ts.
    //   /__walletd → a real walletd daemon. Activated by
    //     VITE_WALLETD_PROXY_TARGET in .env.local (strips the prefix so
    //     walletd sees `POST /`); see lib/devmock.ts for the switch.
    proxy: {
      "/__bnbusd": {
        target: "https://api.binance.com",
        changeOrigin: true,
        secure: true,
        rewrite: (p: string) => p.replace(/^\/__bnbusd/, ""),
      },
      ...(walletdTarget
        ? {
            "/__walletd": {
              target: walletdTarget,
              changeOrigin: true,
              rewrite: (p: string) => p.replace(/^\/__walletd/, ""),
            },
          }
        : {}),
    },
  },
  };
});
