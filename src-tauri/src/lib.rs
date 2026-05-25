//! Tauri entrypoint + command surface.
//!
//! The frontend talks to walletd exclusively through these commands;
//! it never makes HTTPS calls itself. All TLS pinning and token
//! routing happens on the Rust side.

mod error;
mod export_key;
mod rpc_client;
mod secrets;
mod walletd_supervisor;

use serde_json::Value;
use tauri::{Manager, State};

use walletd_supervisor::{
    read_desktop_config, restart, restore, start, stop, write_desktop_config, AppCtx,
    BootstrapStatus, DesktopConfig, KEYRING_SERVICE,
};

#[tauri::command]
async fn bootstrap_status(ctx: State<'_, AppCtx>) -> Result<BootstrapStatus, String> {
    Ok(ctx.inner.lock().await.status.clone())
}

#[tauri::command]
async fn submit_password(
    ctx: State<'_, AppCtx>,
    password: String,
) -> Result<BootstrapStatus, String> {
    if password.is_empty() {
        return Err("password must not be empty".into());
    }
    secrets::set_passphrase(KEYRING_SERVICE, &password).map_err(|e| e.to_string())?;
    Ok(start(&ctx, &password).await)
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

#[tauri::command]
async fn get_node_rpc(ctx: State<'_, AppCtx>) -> Result<String, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    Ok(read_desktop_config(&datadir).node_rpc)
}

#[tauri::command]
async fn set_node_rpc(
    ctx: State<'_, AppCtx>,
    url: String,
) -> Result<BootstrapStatus, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("node_rpc URL must not be empty".into());
    }
    let datadir = ctx.inner.lock().await.datadir.clone();
    write_desktop_config(&datadir, &DesktopConfig { node_rpc: url })
        .map_err(|e| format!("persisting config: {e}"))?;
    restart(&ctx).await.map_err(|e| e.to_user_string())
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
            let datadir = app
                .path()
                .app_data_dir()
                .expect("resolving app_data_dir");
            std::fs::create_dir_all(&datadir).expect("creating app_data_dir");
            let ctx = AppCtx::new(datadir);
            app.manage(ctx.clone());

            // Try silent passphrase recovery from the OS keychain. If
            // it's there, kick off walletd immediately; otherwise the
            // frontend will see `NeedsPassword` on its first
            // bootstrap_status poll and show the prompt.
            let ctx_for_spawn = ctx.clone();
            tauri::async_runtime::spawn(async move {
                match secrets::get_passphrase(KEYRING_SERVICE) {
                    Ok(Some(passphrase)) => {
                        let _ = start(&ctx_for_spawn, &passphrase).await;
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
            submit_password,
            rpc,
            get_node_rpc,
            set_node_rpc,
            reset_wallet,
            export_wallet_key,
            restore_from_mnemonic,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
