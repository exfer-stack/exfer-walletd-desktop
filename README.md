<p align="center">
  <img src="docs/logo.png" alt="exfer wallet" width="96" height="96" />
</p>

<h1 align="center">exfer-wallet (desktop)</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
</p>

<p align="center">
  <img src="docs/preview.png" alt="exfer wallet — dashboard and send" width="900" />
</p>

A double-click desktop GUI for the Exfer blockchain. One executable
ships:

- the [`exfer-walletd`](https://github.com/exfer-stack/exfer-walletd)
  daemon, in-process, with a self-signed TLS cert auto-generated on
  first run;
- a small React UI for balance / generate-address / transfer /
  node-RPC settings.

The frontend never talks HTTPS directly. Every request goes
JS → Tauri IPC → Rust → loopback HTTPS to walletd, with the cert
pinned by SHA-256 fingerprint inside the Rust shell. The webview
never has to be taught to trust the self-signed cert.

Built with Tauri 2 + React 18+ + TypeScript + Vite + Tailwind.

## Architecture

```
┌── exfer-wallet (single executable) ─────────────────────────┐
│  ┌─ Tauri webview (React + TS + Tailwind) ──┐               │
│  │  Dashboard / Generate / Transfer /         │               │
│  │  Settings / PasswordPrompt                 │ ──IPC──┐     │
│  │  lib/rpc.ts → invoke('rpc', ...)            │       │     │
│  └─────────────────────────────────────────────┘       │     │
│  ┌─ Tauri Rust ───────────────────────────────────────┘     │
│  │  walletd_supervisor: keychain → run_embedded(cfg)         │
│  │  rpc_client: reqwest + rustls, fingerprint-pinned         │
│  │  embedded walletd → 127.0.0.1:<random>, TLS self-signed    │
│  └────────────────────────────────────────────────────────────┘
└───────────────────────────────────────────────────────────────┘
```

## First-run UX

- Password modal — the user picks a passphrase that will encrypt
  walletd's HD seed at rest. Stored silently in the OS keychain
  afterwards (macOS Keychain, Windows Credential Manager, Linux
  libsecret); on subsequent launches walletd boots without asking.
- No BIP-39 mnemonic display. Walletd's custom derivation path
  (`m/44'/9527'/0'/0'/i'`) isn't interoperable with standard
  wallets, so the 24 words don't help with cross-wallet recovery.
  Backup story: keep the password safe and the per-user app-data
  directory backed up.
- Default upstream node: `http://89.127.232.155:9334`. Editable in
  Settings; comma-separated for round-robin + failover.

## Install

Pre-built binaries are published on the
[Releases page](https://github.com/exfer-stack/exfer-walletd-desktop/releases)
for:

- Linux x86_64 — `.deb`, `.AppImage`, `.rpm`
- macOS Apple Silicon — `.dmg`, `.app.tar.gz`
- Windows x86_64 — `.exe` installer, `.msi`

**Intel macOS users**: no pre-built binary is shipped — GitHub
deprecated the `macos-13` x86_64 runner, and queue times made it
block every release. Follow the
[Build from source](#build) section below; everything works the
same, you just compile it yourself.

## Build

### Prerequisites

- Rust 1.75+ and Cargo
- Node.js 20+ and npm
- Tauri's platform prerequisites: see
  <https://tauri.app/start/prerequisites/>
  - **Linux**: `libwebkit2gtk-4.1-dev libsoup-3.0-dev pkg-config build-essential libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
  - **macOS**: Xcode command-line tools
  - **Windows**: Microsoft Visual Studio C++ Build Tools + WebView2

### Dev

```bash
npm install
npm run tauri dev
```

### Release

```bash
npm install
npm run tauri build
```

Produces `.app` / `.exe` / `.AppImage` / `.deb` under
`src-tauri/target/release/bundle/`.

## Layout

```
exfer-walletd-desktop/
├── README.md
├── LICENSE
├── index.html
├── package.json, tsconfig.json, vite.config.ts
├── tailwind.config.js, postcss.config.js
├── src/                       # React frontend (TS + Tailwind)
│   ├── App.tsx                # router + bootstrap_status polling
│   ├── main.tsx, index.css
│   ├── lib/{rpc, types, toast, wallet, notify, labels, history}.ts(x)
│   ├── components/{Layout, PasswordPrompt, AddressRow, CopyButton, Reveal*Modal}.tsx
│   └── pages/{Dashboard, Receive, Send, Activity, Settings}.tsx
└── src-tauri/                 # Rust shell
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── lib.rs             # Tauri commands + setup
        ├── main.rs
        ├── walletd_supervisor.rs   # boot / restart embedded walletd
        ├── rpc_client.rs           # pinned reqwest + JSON-RPC forwarder
        ├── secrets.rs              # OS keychain wrapper
        └── error.rs
```

## Security model

- Walletd's TLS cert is generated on first run, self-signed, with
  SAN = `127.0.0.1` + `localhost`. The Rust shell pins by SHA-256(DER)
  of the leaf — no CA, no rotation ceremony. The webview never makes
  HTTPS calls; only the Rust side handles TLS.
- Passphrase lives in the OS keychain. On Linux that's
  secret-service via libsecret. Inherits the desktop session's lock
  semantics — if you don't trust your own keychain, switch to
  `WALLETD_KEYSTORE_PASSPHRASE` prompts via a follow-up release.
- Bearer tokens are kept in the Rust shell and never sent to the
  webview. Scope mapping (read/manage/spend) mirrors walletd's
  `auth::Scope::for_method`.
- The embedded walletd binds `127.0.0.1:0` only. Public binds are
  off; you cannot accidentally expose this app to the LAN.

## License

MIT. See [LICENSE](./LICENSE).
