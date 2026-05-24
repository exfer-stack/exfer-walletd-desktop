# Developing against a real walletd (no Tauri prereqs needed)

For UI iteration we usually want a real wallet talking to the real
chain, but Tauri's platform prereqs (webkit2gtk on Linux, etc.) are
heavy. This shortcut lets you run **the Vite dev server against a
real `exfer-walletd` daemon over HTTP**, no Tauri build required.

Frontend code is identical to the Tauri build — `src/lib/devmock.ts`
auto-detects the absence of `window.__TAURI_INTERNALS__` and, when
`VITE_USE_REAL_WALLETD=true`, routes RPC calls through a Vite proxy
to walletd.

## One-time setup

1. Build the `exfer-walletd` daemon (from the sibling repo):
   ```bash
   cd ../exfer-walletd
   cargo build --release --bin exfer-walletd
   ```

2. Pick a passphrase + mint three random tokens:
   ```bash
   PASS="dev-only-passphrase"
   TOKEN_READ=$(openssl rand -hex 32)
   TOKEN_MANAGE=$(openssl rand -hex 32)
   TOKEN_SPEND=$(openssl rand -hex 32)
   ```

3. Write `.env.local` (gitignored) so Vite injects the tokens into
   the bundle:
   ```bash
   cat > .env.local <<EOF
   VITE_USE_REAL_WALLETD=true
   VITE_WALLETD_TOKEN_READ=$TOKEN_READ
   VITE_WALLETD_TOKEN_MANAGE=$TOKEN_MANAGE
   VITE_WALLETD_TOKEN_SPEND=$TOKEN_SPEND
   EOF
   chmod 600 .env.local
   ```

## Run

In one terminal — walletd (plain HTTP, browser-friendly):

```bash
WALLETD_KEYSTORE_PASSPHRASE="$PASS" \
WALLETD_AUTH_TOKEN_READ="$TOKEN_READ" \
WALLETD_AUTH_TOKEN_MANAGE="$TOKEN_MANAGE" \
WALLETD_AUTH_TOKEN_SPEND="$TOKEN_SPEND" \
../exfer-walletd/target/release/exfer-walletd \
  --datadir /tmp/walletd-desktop-dev \
  --bind 127.0.0.1:7448 \
  --node-rpc http://89.127.232.155:9334
```

In the other — Vite with the proxy target set:

```bash
VITE_WALLETD_PROXY_TARGET=http://127.0.0.1:7448 npm run dev
```

Open <http://127.0.0.1:1420/>. The password modal is skipped (walletd
is already running), the dashboard lands on real chain state.

## How it works

- `vite.config.ts` reads `VITE_WALLETD_PROXY_TARGET` and, when set,
  proxies `/__walletd` → that target. The browser sees same-origin
  requests, so CORS is a non-issue.
- `src/lib/devmock.ts` checks `import.meta.env.VITE_USE_REAL_WALLETD`.
  When `"true"`, every `rpc()` call becomes a `fetch('/__walletd', …)`
  with the bearer token for the method's scope; `bootstrap_status`
  returns Ready immediately after a successful `ping`.
- All other UI code (pages, history persistence, label overlay) is
  the same code path Tauri uses, so this is a real end-to-end test
  of the React + RPC layer.

## What's NOT exercised

- Tauri IPC (`invoke`) — bypassed in this mode.
- OS keychain integration (`secrets.rs`) — bypassed.
- The Rust-side fingerprint-pinned reqwest client — bypassed.
- TLS handshake against the in-process walletd — bypassed.

For those, you need `cargo tauri dev` with the proper platform
prereqs installed. See README.md for the per-platform list.

## End-to-end smoke (real chain)

This is the methodology we used to verify the desktop UI against
89.127.232.155 (per the project's
`reference-node-89-127` memory).

1. Generate three HD addresses via the Dashboard.
2. Fund the first one from another wallet — e.g. the devfee key via
   `~/exfer-recovery/wallets/quick_send.py`:
   ```bash
   python3 quick_send.py \
     --wallet ~/exfer-devfee-wallet/devfee.key \
     --passphrase-file ~/exfer-devfee-wallet/passphrase.txt \
     --to <address-0-hex> \
     --amount-exfer 0.1 \
     --fee-exfer 0.001 \
     --rpc http://89.127.232.155:9334
   ```
3. Wait ~20s, hit **Refresh** on the Dashboard — balance lands.
4. Go to **Send**, transfer 0.03 EXFER from address 0 to address 1.
5. Watch **Activity** — pill flips from "checking…" to "in mempool"
   to "confirmed @ <height>" as the chain catches up.
6. Repeat for any other recipient permutation.

### Gotcha: upstream rate limits

`89.127.232.155:9334` (and `rpc.exfer.dev`) enforce **30 UTXO-scan
queries / min / IP**. Two back-to-back Sends within the window can
exhaust the budget and surface as a red error banner
("Rate limit exceeded: max 30 balance/utxo queries per minute").
Wait ~60s for the window to reset. Running your own local
`exfer node` removes this constraint.
