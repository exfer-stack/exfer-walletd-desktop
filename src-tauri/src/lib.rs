//! Tauri entrypoint + command surface.
//!
//! The frontend talks to walletd exclusively through these commands;
//! it never makes HTTPS calls itself. All TLS pinning and token
//! routing happens on the Rust side.

mod error;
mod export_key;
mod mcp_registry;
mod mcp_supervisor;
mod miner;
mod mnemonic;
mod native_tools;
mod rpc_client;
mod secrets;
mod walletd_supervisor;

use mcp_registry::{mcp_add_server, mcp_list_servers, mcp_remove_server, mcp_set_enabled};
use mcp_supervisor::{mcp_call_tool, mcp_list_tools, mcp_start, McpCtx};

use serde_json::Value;
use tauri::{Manager, State};

use walletd_supervisor::{
    read_desktop_config, restart, restore, start_with_app, stop, write_desktop_config, AppCtx,
    BootstrapStatus, KEYRING_SERVICE,
};

#[tauri::command]
async fn bootstrap_status(ctx: State<'_, AppCtx>) -> Result<BootstrapStatus, String> {
    Ok(ctx.inner.lock().await.status.clone())
}

/// Open an external URL in the user's default browser. The webview can't launch
/// the system browser itself, and a bare `<a target="_blank">` is a no-op in the
/// Tauri shell — so explorer links (Activity, etc.) route through here. Locked to
/// http(s) so the frontend can never open arbitrary schemes or local files.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("refusing to open a non-http(s) URL".into());
    }
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn submit_password(
    app: tauri::AppHandle,
    ctx: State<'_, AppCtx>,
    password: String,
) -> Result<BootstrapStatus, String> {
    if password.is_empty() {
        return Err("password must not be empty".into());
    }
    secrets::set_passphrase(KEYRING_SERVICE, &password).map_err(|e| e.to_string())?;
    Ok(start_with_app(&ctx, &password, Some(app)).await)
}

#[tauri::command]
async fn restore_from_mnemonic(
    ctx: State<'_, AppCtx>,
    phrase: String,
    password: String,
) -> Result<BootstrapStatus, String> {
    if password.len() < 8 {
        return Err("password must be at least 8 characters".into());
    }
    let words = phrase.split_whitespace().count();
    if words != 24 {
        return Err(format!("recovery phrase must be 24 words (got {words})"));
    }
    restore(&ctx, phrase.trim(), &password)
        .await
        .map_err(|e| e.to_user_string())
}

#[tauri::command]
async fn rpc(
    ctx: State<'_, AppCtx>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let (client, conn) = {
        let inner = ctx.inner.lock().await;
        match (inner.client.clone(), inner.conn.clone()) {
            (Some(c), Some(k)) => (c, k),
            _ => return Err("walletd not ready".into()),
        }
    };
    let params = params.unwrap_or(Value::Object(Default::default()));
    rpc_client::forward_rpc(&client, &conn, &method, params)
        .await
        .map_err(|e| e.to_user_string())
}

/// Best-effort on-chain balance (base units) for ANY address — used to show,
/// before importing, which candidate address actually holds the coins.
async fn address_balance(
    client: &reqwest::Client,
    conn: &rpc_client::ConnectionInfo,
    address: &str,
) -> Option<u64> {
    let params = serde_json::json!({ "address": address });
    let v = rpc_client::forward_rpc(client, conn, "get_balance", params)
        .await
        .ok()?;
    v.get("balance")
        .and_then(|b| b.as_u64())
        .or_else(|| v.as_u64())
}

/// Preview the two addresses a 24-word phrase maps to (standard BIP39 vs the
/// legacy raw-key scheme) WITH each address's on-chain balance, so the user can
/// pick the one that holds their coins instead of guessing a scheme. Pure
/// derivation + a read-only balance query; mints no key, imports nothing. This
/// is the same derivation + preview the mobile wallet uses, so a phrase shows
/// the same candidate addresses on both.
#[tauri::command]
async fn preview_mnemonic_import(ctx: State<'_, AppCtx>, phrase: String) -> Result<Value, String> {
    let (standard, legacy) = mnemonic::preview(&phrase)?;
    let cc = {
        let inner = ctx.inner.lock().await;
        inner.client.clone().zip(inner.conn.clone())
    };
    let (std_bal, leg_bal) = if let Some((client, conn)) = cc {
        tokio::join!(
            address_balance(&client, &conn, &standard),
            address_balance(&client, &conn, &legacy),
        )
    } else {
        (None, None)
    };
    Ok(serde_json::json!({
        "standard": { "address": standard, "balance": std_bal },
        "legacy": { "address": legacy, "balance": leg_bal },
    }))
}

/// Import a 24-word phrase under the chosen scheme (`"standard"` | `"legacy"`).
/// Routes to walletd so the phrase is sealed and reveals back: standard →
/// `import_standard_mnemonic` (same address as exfer.dev / the mobile wallet),
/// legacy → `import_mnemonic` (raw-key encoding). The address joins the wallet
/// as an independent key; it does not touch the HD seed used by full restore.
/// Returns `{ address, imported }`.
#[tauri::command]
async fn import_mnemonic_scheme(
    ctx: State<'_, AppCtx>,
    phrase: String,
    scheme: String,
    label: Option<String>,
) -> Result<Value, String> {
    let method = match mnemonic::Scheme::parse(&scheme)? {
        mnemonic::Scheme::Standard => "import_standard_mnemonic",
        mnemonic::Scheme::Legacy => "import_mnemonic",
    };
    let (client, conn) = {
        let inner = ctx.inner.lock().await;
        match (inner.client.clone(), inner.conn.clone()) {
            (Some(c), Some(k)) => (c, k),
            _ => return Err("walletd not ready".into()),
        }
    };
    let params = serde_json::json!({ "mnemonic": phrase.trim(), "label": label });
    rpc_client::forward_rpc(&client, &conn, method, params)
        .await
        .map_err(|e| e.to_user_string())
}

/// Export a single address's key as an official Exfer `wallet.key`
/// (EXFK) file at `dest`, encrypted with `export_password`. The raw
/// secret is fetched from walletd (authorized by `wallet_password`),
/// turned into the EXFK format, and written to disk — the plaintext key
/// never crosses into the webview. The resulting file imports directly
/// into exfer.dev ("Import wallet.key") and the exfer CLI.
#[tauri::command]
async fn export_wallet_key(
    ctx: State<'_, AppCtx>,
    address: String,
    wallet_password: String,
    export_password: String,
    dest: String,
) -> Result<(), String> {
    if export_password.len() < 6 {
        return Err("export password must be at least 6 characters".into());
    }
    // 1. Get the raw secret from walletd (spend-scope, passphrase-gated).
    let (client, conn) = {
        let inner = ctx.inner.lock().await;
        match (inner.client.clone(), inner.conn.clone()) {
            (Some(c), Some(k)) => (c, k),
            _ => return Err("walletd not ready".into()),
        }
    };
    let result = rpc_client::forward_rpc(
        &client,
        &conn,
        "reveal_private_key",
        serde_json::json!({ "address": address, "passphrase": wallet_password }),
    )
    .await
    .map_err(|e| e.to_user_string())?;

    let secret_hex = result
        .get("secret_hex")
        .and_then(|v| v.as_str())
        .ok_or("walletd response missing secret_hex")?;
    let mut secret = [0u8; 32];
    hex::decode_to_slice(secret_hex, &mut secret)
        .map_err(|_| "secret_hex not 32 bytes".to_string())?;

    // 2. Build the EXFK file + write it (0600). Zeroize the secret after.
    let exfk = export_key::build_exfk(&secret, export_password.as_bytes());
    secret.fill(0);
    let exfk = exfk?;

    std::fs::write(&dest, &exfk).map_err(|e| format!("writing {dest}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Import a wallet.key (EXFK) file as a non-derived address. Reads the
/// file, decrypts it with `file_password`, hands the raw secret to
/// walletd's `import_private_key` RPC, and returns the resulting address.
/// The plaintext key never crosses into the webview.
///
/// Errors are surfaced as short user strings (wrong password, malformed
/// file, duplicate address, etc.). `file_password` and the in-memory
/// secret buffer are zeroed before the call returns.
#[tauri::command]
async fn import_wallet_key(
    ctx: State<'_, AppCtx>,
    path: String,
    file_password: String,
    label: Option<String>,
) -> Result<String, String> {
    if path.is_empty() {
        return Err("no wallet.key file selected".into());
    }
    let buf = std::fs::read(&path).map_err(|e| format!("reading {path}: {e}"))?;

    // Accept an encrypted EXFK file, a raw 32-byte secret, or a 64-hex
    // dump — the same set the mobile app takes, so a file that imports on
    // the phone imports here too. Password is only used for the EXFK shape.
    let mut secret = export_key::parse_key_file(&buf, file_password.as_bytes())?;

    let (client, conn) = {
        let inner = ctx.inner.lock().await;
        match (inner.client.clone(), inner.conn.clone()) {
            (Some(c), Some(k)) => (c, k),
            _ => {
                secret.fill(0);
                return Err("walletd not ready".into());
            }
        }
    };
    let secret_hex = hex::encode(secret);
    secret.fill(0);

    let mut params = serde_json::json!({ "secret_hex": secret_hex });
    if let Some(l) = label.as_ref().filter(|l| !l.trim().is_empty()) {
        params["label"] = serde_json::Value::String(l.trim().to_string());
    }

    let result = rpc_client::forward_rpc(&client, &conn, "import_private_key", params)
        .await
        .map_err(|e| e.to_user_string())?;

    let address = result
        .get("address")
        .and_then(|v| v.as_str())
        .ok_or("walletd response missing address")?
        .to_string();
    Ok(address)
}

/// Export the WHOLE keyring as one passphrase-sealed vault file at
/// `dest`. walletd seals every managed key (verified by `wallet_password`)
/// into a single WDV1 blob; we write its raw bytes to disk (0600). This is
/// the keyring-model backup — one file, no seed mnemonic to copy. Restores
/// via `import_vault_file`.
#[tauri::command]
async fn export_vault_file(
    ctx: State<'_, AppCtx>,
    wallet_password: String,
    dest: String,
) -> Result<(), String> {
    let (client, conn) = {
        let inner = ctx.inner.lock().await;
        match (inner.client.clone(), inner.conn.clone()) {
            (Some(c), Some(k)) => (c, k),
            _ => return Err("walletd not ready".into()),
        }
    };
    let result = rpc_client::forward_rpc(
        &client,
        &conn,
        "export_vault",
        serde_json::json!({ "passphrase": wallet_password }),
    )
    .await
    .map_err(|e| e.to_user_string())?;

    let vault_hex = result
        .get("vault_hex")
        .and_then(|v| v.as_str())
        .ok_or("walletd response missing vault_hex")?;
    let bytes = hex::decode(vault_hex).map_err(|_| "vault_hex not valid hex".to_string())?;

    std::fs::write(&dest, &bytes).map_err(|e| format!("writing {dest}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Restore keys from a vault file written by `export_vault_file`. Reads the
/// sealed blob, hands it to walletd's `import_vault` (decrypted with
/// `file_password` — the password the backup was created with). Each key is
/// re-imported as an independent key; already-present addresses are
/// skipped. Returns the number of addresses newly restored.
#[tauri::command]
async fn import_vault_file(
    ctx: State<'_, AppCtx>,
    path: String,
    file_password: String,
) -> Result<usize, String> {
    if path.is_empty() {
        return Err("no backup file selected".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("reading {path}: {e}"))?;
    let vault_hex = hex::encode(&bytes);

    let (client, conn) = {
        let inner = ctx.inner.lock().await;
        match (inner.client.clone(), inner.conn.clone()) {
            (Some(c), Some(k)) => (c, k),
            _ => return Err("walletd not ready".into()),
        }
    };
    let result = rpc_client::forward_rpc(
        &client,
        &conn,
        "import_vault",
        serde_json::json!({ "vault_hex": vault_hex, "passphrase": file_password }),
    )
    .await
    .map_err(|e| e.to_user_string())?;

    let count = result
        .get("imported")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    Ok(count)
}

#[tauri::command]
async fn get_node_rpc(ctx: State<'_, AppCtx>) -> Result<String, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    Ok(read_desktop_config(&datadir).node_rpc)
}

#[tauri::command]
async fn set_node_rpc(ctx: State<'_, AppCtx>, url: String) -> Result<BootstrapStatus, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("node_rpc URL must not be empty".into());
    }
    let datadir = ctx.inner.lock().await.datadir.clone();
    // Read-modify-write so changing the node preserves the indexer config.
    let mut cfg = read_desktop_config(&datadir);
    cfg.node_rpc = url;
    write_desktop_config(&datadir, &cfg).map_err(|e| format!("persisting config: {e}"))?;
    restart(&ctx).await.map_err(|e| e.to_user_string())
}

/// Configured indexer endpoint. An empty string means "use the built-in
/// default". The indexer is anonymous (public read-only chain data); no token.
#[derive(serde::Serialize)]
struct IndexerConfig {
    rpc: String,
}

#[tauri::command]
async fn get_indexer_config(ctx: State<'_, AppCtx>) -> Result<IndexerConfig, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    let cfg = read_desktop_config(&datadir);
    Ok(IndexerConfig {
        rpc: cfg.indexer_rpc.unwrap_or_default(),
    })
}

#[tauri::command]
async fn set_indexer_config(
    ctx: State<'_, AppCtx>,
    rpc: String,
) -> Result<BootstrapStatus, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    let mut cfg = read_desktop_config(&datadir);
    let trimmed = rpc.trim().to_string();
    cfg.indexer_rpc = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    write_desktop_config(&datadir, &cfg).map_err(|e| format!("persisting config: {e}"))?;
    restart(&ctx).await.map_err(|e| e.to_user_string())
}

/// Cross-chain swap engine config. An empty `pool_url` ⇒ the bundled official
/// pool default; `bsc_rpc_url` empty ⇒ walletd's mainnet RPC default;
/// `bsc_chain_id` 0/absent ⇒ 56 (mainnet). The public pool runs on BSC
/// mainnet — set bsc_chain_id=97 + a testnet RPC only for a Chapel test pool.
#[derive(serde::Serialize)]
struct SwapConfig {
    pool_url: String,
    bsc_rpc_url: String,
    bsc_chain_id: u64,
}

#[tauri::command]
async fn get_swap_config(ctx: State<'_, AppCtx>) -> Result<SwapConfig, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    let cfg = read_desktop_config(&datadir);
    Ok(SwapConfig {
        pool_url: cfg.swap_pool_url.unwrap_or_default(),
        bsc_rpc_url: cfg.bsc_rpc_url.unwrap_or_default(),
        bsc_chain_id: cfg.bsc_chain_id.unwrap_or(0),
    })
}

#[tauri::command]
async fn set_swap_config(
    ctx: State<'_, AppCtx>,
    pool_url: String,
    bsc_rpc_url: String,
    bsc_chain_id: u64,
) -> Result<BootstrapStatus, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    let mut cfg = read_desktop_config(&datadir);
    let pool = pool_url.trim().to_string();
    let rpc = bsc_rpc_url.trim().to_string();
    cfg.swap_pool_url = if pool.is_empty() { None } else { Some(pool) };
    cfg.bsc_rpc_url = if rpc.is_empty() { None } else { Some(rpc) };
    cfg.bsc_chain_id = if bsc_chain_id == 0 {
        None
    } else {
        Some(bsc_chain_id)
    };
    write_desktop_config(&datadir, &cfg).map_err(|e| format!("persisting config: {e}"))?;
    restart(&ctx).await.map_err(|e| e.to_user_string())
}

/// A reqwest client trusting the public webpki root store, for outbound HTTPS
/// to public hosts (Binance). The app's other reqwest client pins walletd's
/// self-signed cert via manual roots, which would reject a public CA chain —
/// hence a separate client here.
pub(crate) fn public_https_client() -> Result<reqwest::Client, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    reqwest::ClientBuilder::new()
        .use_preconfigured_tls(tls)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("building http client: {e}"))
}

/// BNB/USD spot from Binance, returned as the raw JSON body ({"price":"..."}).
/// The frontend (lib/market.ts) parses `price` and derives EXFER/USD from the
/// pool ratio. Read-only; a failure just means USD values don't render.
#[tauri::command]
async fn get_bnb_price() -> Result<String, String> {
    let resp = public_https_client()?
        .get("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT")
        .send()
        .await
        .map_err(|e| format!("bnb price request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("bnb price endpoint returned {}", resp.status()));
    }
    resp.text()
        .await
        .map_err(|e| format!("reading bnb price body: {e}"))
}

/// An HTTPS client that PINS the `exfer-vote` service's self-signed CA
/// ([`VOTE_CA_PEM`]) — the same posture as the swap-pool client. Manual-roots
/// reqwest means this CA is the ONLY trust anchor, so a MITM with a public cert
/// still can't impersonate the vote server. Built per request (cheap; the
/// governance UI calls are infrequent) to keep no extra long-lived state.
fn vote_https_client() -> Result<reqwest::Client, String> {
    let ca = reqwest::Certificate::from_pem(walletd_supervisor::VOTE_CA_PEM.as_bytes())
        .map_err(|e| format!("parsing vote CA: {e}"))?;
    reqwest::ClientBuilder::new()
        .tls_built_in_root_certs(false)
        .add_root_certificate(ca)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("building vote http client: {e}"))
}

/// Normalize a frontend-supplied API path onto the vote server base, rejecting
/// anything that isn't a relative `/...` path so the frontend can't redirect
/// these (CA-pinned) calls at an arbitrary host.
fn vote_url(path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.contains("://") {
        return Err("vote api path must be a relative \"/...\" path".into());
    }
    Ok(format!(
        "{}{}",
        walletd_supervisor::DEFAULT_VOTE_SERVER_URL.trim_end_matches('/'),
        path
    ))
}

/// GET a path on the community vote service (e.g. `/proposals`,
/// `/proposals/:id`, `/proposals/:id/results`). Returns the raw JSON body as a
/// `Value` for the frontend's `governance.ts` to normalize. CA-pinned HTTPS;
/// mirrors `get_bnb_price`'s read-only, failure-is-tolerable shape.
#[tauri::command]
async fn vote_api_get(path: String) -> Result<Value, String> {
    let resp = vote_https_client()?
        .get(vote_url(&path)?)
        .send()
        .await
        .map_err(|e| format!("vote api request failed: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("reading vote api body: {e}"))?;
    if !status.is_success() {
        return Err(format!("vote server returned {status}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("vote api returned non-JSON: {e}"))
}

/// POST a JSON body to the vote service (currently only `/votes` with
/// `{ payload, signature, pubkey }`). `body` is the already-serialized JSON
/// string built by `governance.ts`; we forward it verbatim so the signed
/// `payload` bytes are never re-serialized. CA-pinned HTTPS.
#[tauri::command]
async fn vote_api_post(path: String, body: String) -> Result<Value, String> {
    let resp = vote_https_client()?
        .post(vote_url(&path)?)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("vote api request failed: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("reading vote api body: {e}"))?;
    if !status.is_success() {
        return Err(format!("vote server returned {status}: {text}"));
    }
    if text.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("vote api returned non-JSON: {e}"))
}

/// GET an attachment's raw bytes from the exfer-vote service (`/media/:id`),
/// routed through the SAME CA-pinned client as the JSON API so the pinned trust
/// anchor is preserved — the webview must never hit the host directly for media.
/// Returns `{ content_type, body_hex }`; the JS side hex-decodes the bytes and
/// either renders them as an inline blob (`image` kinds) or saves them to disk
/// (`file` kinds). The body is capped to guard against a hostile/oversized
/// response (uploads are already capped server-side; this is belt-and-suspenders).
#[tauri::command]
async fn vote_media_get(path: String) -> Result<Value, String> {
    // Hard ceiling on what we'll pull into memory + ferry across the IPC bridge.
    const MAX_MEDIA_BYTES: usize = 16 * 1024 * 1024;
    let resp = vote_https_client()?
        .get(vote_url(&path)?)
        .send()
        .await
        .map_err(|e| format!("media request failed: {e}"))?;
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("reading media body: {e}"))?;
    if !status.is_success() {
        return Err(format!("vote server returned {status}"));
    }
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err("attachment exceeds the maximum download size".into());
    }
    Ok(serde_json::json!({
        "content_type": content_type,
        "body_hex": hex::encode(&bytes),
    }))
}

/// Download an attachment (`/media/:id`) through the CA-pinned vote client and
/// write it to `dest` (a path the frontend picked via the OS save dialog). Mirrors
/// `export_wallet_key`'s "Rust owns the disk write" pattern — the bytes go
/// straight from the pinned HTTPS response to the file, never through the webview
/// host, so cert pinning is preserved. Same in-memory ceiling as `vote_media_get`.
#[tauri::command]
async fn vote_media_save(path: String, dest: String) -> Result<(), String> {
    const MAX_MEDIA_BYTES: usize = 16 * 1024 * 1024;
    if dest.is_empty() {
        return Err("no destination selected".into());
    }
    let resp = vote_https_client()?
        .get(vote_url(&path)?)
        .send()
        .await
        .map_err(|e| format!("media request failed: {e}"))?;
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("reading media body: {e}"))?;
    if !status.is_success() {
        return Err(format!("vote server returned {status}"));
    }
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err("attachment exceeds the maximum download size".into());
    }
    std::fs::write(&dest, &bytes).map_err(|e| format!("writing {dest}: {e}"))?;
    Ok(())
}

/// Wipe everything on this device: stop the embedded walletd, delete the
/// entire app-data directory (sealed seed, tokens, TLS cert, desktop
/// config), and clear the keychain passphrase. Returns the app to the
/// first-run `NeedsPassword` state.
///
/// IRREVERSIBLE — the frontend gates this behind a typed confirmation.
#[tauri::command]
async fn reset_wallet(ctx: State<'_, AppCtx>) -> Result<BootstrapStatus, String> {
    // 1. Stop the running daemon (releases file handles on the datadir).
    stop(&ctx).await;

    // 2. Delete the datadir contents.
    let datadir = ctx.inner.lock().await.datadir.clone();
    if datadir.exists() {
        std::fs::remove_dir_all(&datadir).map_err(|e| format!("deleting datadir: {e}"))?;
    }
    std::fs::create_dir_all(&datadir).map_err(|e| format!("recreating datadir: {e}"))?;

    // 3. Clear the keychain passphrase (best-effort; missing entry is fine).
    let _ = secrets::delete_passphrase(KEYRING_SERVICE);

    // 4. Reset in-memory state back to first-run.
    {
        let mut inner = ctx.inner.lock().await;
        inner.status = BootstrapStatus::NeedsPassword;
        inner.handle = None;
        inner.conn = None;
        inner.client = None;
    }
    Ok(BootstrapStatus::NeedsPassword)
}

// ── in-wallet agent: LLM fetch (key injected host-side) + consent ─────────────

/// Per-provider keyring service for the user's LLM API key. Distinct from the
/// walletd keystore passphrase service so the two never collide.
fn llm_key_service(provider: &str) -> String {
    format!("{KEYRING_SERVICE}-llm:{provider}")
}

#[derive(serde::Deserialize)]
struct LlmRequest {
    url: String,
    #[serde(default = "default_post")]
    method: String,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}
fn default_post() -> String {
    "POST".into()
}

#[derive(serde::Serialize)]
struct LlmResponse {
    status: u16,
    headers: std::collections::HashMap<String, String>,
    body: String,
}

/// A webpki-rooted client with a long timeout for (buffered) LLM responses.
fn llm_https_client() -> Result<reqwest::Client, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    reqwest::ClientBuilder::new()
        .use_preconfigured_tls(tls)
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("building llm http client: {e}"))
}

/// Forward an LLM request, injecting the user's API key from the OS keychain so
/// the plaintext key never lives in the webview. `provider` selects the key;
/// `kind` ("openai" | "anthropic") selects the auth header. Buffered for now —
/// the whole response body is returned (streaming variant is a follow-up).
#[tauri::command]
async fn llm_fetch(req: LlmRequest, provider: String, kind: String) -> Result<LlmResponse, String> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};

    let key = secrets::get_passphrase(&llm_key_service(&provider))
        .map_err(|e| format!("reading llm key: {e}"))?
        .ok_or_else(|| format!("no API key set for provider {provider}"))?;

    let mut headers = HeaderMap::new();
    for (k, v) in &req.headers {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            headers.insert(name, val);
        }
    }
    // Inject the real key host-side (override any placeholder the webview sent).
    if kind == "anthropic" {
        headers.remove(AUTHORIZATION);
        headers.insert(
            "x-api-key",
            HeaderValue::from_str(&key).map_err(|e| e.to_string())?,
        );
        if !headers.contains_key("anthropic-version") {
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
    } else {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {key}")).map_err(|e| e.to_string())?,
        );
    }
    if !headers.contains_key(CONTENT_TYPE) {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }

    let method =
        reqwest::Method::from_bytes(req.method.as_bytes()).unwrap_or(reqwest::Method::POST);
    let mut builder = llm_https_client()?
        .request(method, &req.url)
        .headers(headers);
    if let Some(b) = req.body {
        builder = builder.body(b);
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("llm request failed: {e}"))?;
    let status = resp.status().as_u16();
    let mut out_headers = std::collections::HashMap::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            out_headers.insert(k.as_str().to_string(), s.to_string());
        }
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("reading llm body: {e}"))?;
    Ok(LlmResponse {
        status,
        headers: out_headers,
        body,
    })
}

/// A CORS-free HTTP(S) fetch through the host, for the first-party `web_fetch`
/// capability tool (and anything else that needs to read the public web without
/// the webview's CORS wall). Uses the webpki-rooted public client; the body is
/// safely truncated to ~200KB so a huge page can't blow up the webview.
#[derive(serde::Deserialize)]
struct FetchUrlReq {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    headers: Option<std::collections::HashMap<String, String>>,
}
#[derive(serde::Serialize)]
struct FetchUrlResp {
    status: u16,
    body: String,
}
#[tauri::command]
async fn fetch_url(req: FetchUrlReq) -> Result<FetchUrlResp, String> {
    if !(req.url.starts_with("http://") || req.url.starts_with("https://")) {
        return Err("url must be http(s)".into());
    }
    let client = public_https_client()?;
    let method = reqwest::Method::from_bytes(req.method.unwrap_or_else(|| "GET".into()).as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let mut b = client.request(method, &req.url);
    if let Some(h) = req.headers {
        for (k, v) in h {
            b = b.header(k, v);
        }
    }
    if let Some(body) = req.body {
        b = b.body(body);
    }
    let resp = b.send().await.map_err(|e| format!("fetch failed: {e}"))?;
    let status = resp.status().as_u16();
    let full = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    // safe UTF-8 truncate to ~200KB
    let body = if full.len() > 200_000 {
        let mut end = 200_000;
        while !full.is_char_boundary(end) {
            end -= 1;
        }
        full[..end].to_string()
    } else {
        full
    };
    Ok(FetchUrlResp { status, body })
}

#[tauri::command]
fn set_llm_api_key(provider: String, key: String) -> Result<(), String> {
    secrets::set_passphrase(&llm_key_service(&provider), &key).map_err(|e| e.to_string())
}

#[tauri::command]
fn has_llm_api_key(provider: String) -> Result<bool, String> {
    Ok(secrets::get_passphrase(&llm_key_service(&provider))
        .map_err(|e| e.to_string())?
        .is_some())
}

/// Confirm a money-moving agent action by re-checking the wallet passphrase
/// against the one in the OS keychain (constant-time). On mobile this is
/// replaced by a biometric prompt; on desktop it is passphrase re-entry.
#[tauri::command]
fn agent_confirm_consent(passphrase: String) -> Result<bool, String> {
    let stored = secrets::get_passphrase(KEYRING_SERVICE)
        .map_err(|e| e.to_string())?
        .ok_or("wallet is locked")?;
    let (a, b) = (passphrase.as_bytes(), stored.as_bytes());
    let eq = a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0;
    Ok(eq)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,exfer_walletd=info,exfer_walletd_desktop=debug".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Resolve the per-platform app-data dir and stash it in the
            // managed AppCtx; everything else (datadir creation, token
            // files, sealed seed) is handled inside walletd's
            // `run_embedded`.
            let datadir = app.path().app_data_dir().expect("resolving app_data_dir");
            std::fs::create_dir_all(&datadir).expect("creating app_data_dir");
            let ctx = AppCtx::new(datadir);
            app.manage(ctx.clone());
            app.manage(McpCtx::new());
            app.manage(miner::MinerCtx::new());

            // Try silent passphrase recovery from the OS keychain. If
            // it's there, kick off walletd immediately; otherwise the
            // frontend will see `NeedsPassword` on its first
            // bootstrap_status poll and show the prompt.
            let ctx_for_spawn = ctx.clone();
            let app_for_spawn = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match secrets::get_passphrase(KEYRING_SERVICE) {
                    Ok(Some(passphrase)) => {
                        let _ =
                            start_with_app(&ctx_for_spawn, &passphrase, Some(app_for_spawn)).await;
                    }
                    Ok(None) => {
                        // First launch — stay in NeedsPassword.
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "keyring lookup failed, will prompt user");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_status,
            open_external,
            submit_password,
            rpc,
            get_node_rpc,
            set_node_rpc,
            get_indexer_config,
            set_indexer_config,
            get_swap_config,
            set_swap_config,
            get_bnb_price,
            vote_api_get,
            vote_api_post,
            vote_media_get,
            vote_media_save,
            reset_wallet,
            export_wallet_key,
            import_wallet_key,
            export_vault_file,
            import_vault_file,
            restore_from_mnemonic,
            preview_mnemonic_import,
            import_mnemonic_scheme,
            llm_fetch,
            fetch_url,
            set_llm_api_key,
            has_llm_api_key,
            agent_confirm_consent,
            mcp_start,
            mcp_list_tools,
            mcp_call_tool,
            mcp_list_servers,
            mcp_add_server,
            mcp_remove_server,
            mcp_set_enabled,
            miner::mine_start,
            miner::mine_stop,
            miner::mine_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
