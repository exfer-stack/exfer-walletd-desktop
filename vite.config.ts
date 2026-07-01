import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// Read the LLM API key for the browser-real verification path WITHOUT ever
// shipping it to the browser. The /llm proxy injects it as an Authorization
// header server-side (in the vite dev process), so the webview only ever sees a
// same-origin /llm URL with a placeholder key. The key comes from the env that
// launches vite: DEEPSEEK_API_KEY directly, or a dotenv-style file pointed at by
// LLM_KEY_FILE. No path is hardcoded — the key never lands in import.meta.env.
function readDeepseekKey(): string {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv) return fromEnv;
  const keyFile = process.env.LLM_KEY_FILE;
  if (keyFile) {
    try {
      const raw = readFileSync(keyFile, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.*)\s*$/);
        if (m) return m[1].replace(/^["']|["']$/g, "").trim();
      }
    } catch {
      /* key file absent — browser-real LLM path just won't authenticate */
    }
  }
  return "";
}

// App version, baked in at build time from package.json so the update prompt
// can show "You're on vX". Exposed as __APP_VERSION__ (same as mobile).
const APP_VERSION: string = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

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
  const voteTarget = env.VITE_VOTE_PROXY_TARGET;

  // Browser-real verification path (VITE_USE_REAL_AGENT=true, no Tauri):
  //   /llm → the LLM provider base URL; the proxy injects the API key as an
  //          Authorization header server-side so the key never reaches the
  //          browser and the call is same-origin (CORS-free).
  //   /__walletd → a REAL walletd (wallet + swap tools run through the shared
  //          walletTools layer); /__fetch → CORS-free web reads. No mcp bridge.
  const llmTarget = env.LLM_BASE_URL || process.env.LLM_BASE_URL || "https://api.deepseek.com";
  const deepseekKey = readDeepseekKey();
  return {
  plugins: [
    react(),
    // Dev-only generic fetch proxy so the browser-real path can exercise the
    // first-party web capabilities (web_fetch / web_search) without CORS. The
    // installed app uses the Rust `fetch_url` command; this mirrors it for
    // `npm run dev`. GET /__fetch?url=<encoded> → { status, body } JSON.
    {
      name: "exfer-fetch-proxy",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configureServer(server: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use("/__fetch", async (req: any, res: any) => {
          const send = (status: number, body: string) => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ status, body }));
          };
          try {
            const full: string = req.originalUrl || req.url || "";
            const target = new URL(full, "http://localhost").searchParams.get("url");
            if (!target || !/^https?:\/\//i.test(target)) return send(400, "bad or missing url");
            const r = await fetch(target, { headers: { "user-agent": "Mozilla/5.0 (exfer-agent)" } });
            send(r.status, await r.text());
          } catch (e) {
            send(599, String(e));
          }
        });
      },
    },
  ],

  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },

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
      // Browser-real LLM. The key is injected here, server-side, so the
      // browser only sees a same-origin /llm path with a placeholder key.
      "/llm": {
        target: llmTarget,
        changeOrigin: true,
        secure: true,
        rewrite: (p: string) => p.replace(/^\/llm/, ""),
        configure: (proxy: { on: (ev: string, cb: (proxyReq: { setHeader: (k: string, v: string) => void }) => void) => void }) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (deepseekKey) proxyReq.setHeader("Authorization", `Bearer ${deepseekKey}`);
          });
        },
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
      //   /__vote → a real exfer-vote service. Activated by
      //     VITE_VOTE_PROXY_TARGET in .env.local (strips the prefix so the
      //     vote server sees `/proposals`, `/votes`, …); see lib/devmock.ts.
      //     Leave unset to use the in-browser mock proposals/tally instead.
      ...(voteTarget
        ? {
            "/__vote": {
              target: voteTarget,
              changeOrigin: true,
              secure: false,
              rewrite: (p: string) => p.replace(/^\/__vote/, ""),
            },
          }
        : {}),
    },
  },
  };
});
