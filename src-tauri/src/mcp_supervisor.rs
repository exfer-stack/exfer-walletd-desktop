//! Manages the `exfer-mcp` sidecar and speaks MCP to it over stdio via the
//! official `rmcp` client. Runs exfer-mcp in EXTERNAL mode pointed at THIS app's
//! in-process embedded walletd (URL + scope tokens + TLS fingerprint from
//! `ConnectionInfo`), so the agent's 35 tools operate on the user's real wallet
//! — no second walletd, no second keystore.
//!
//! The rmcp stdio-client pattern here is verified end-to-end against a real
//! exfer-mcp + real chain (see the standalone rmcp probe).

use std::collections::HashMap;
use std::sync::Arc;

use rmcp::{
    model::CallToolRequestParams, service::RoleClient, service::RunningService,
    transport::TokioChildProcess, ServiceExt,
};
use serde_json::{json, Value};
use tauri::State;
use tokio::sync::Mutex;

use crate::rpc_client::ConnectionInfo;
use crate::walletd_supervisor::AppCtx;

/// Managed Tauri state holding the running MCP client (lazily started).
pub struct McpCtx {
    inner: Arc<Mutex<Option<RunningService<RoleClient, ()>>>>,
}

impl McpCtx {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for McpCtx {
    fn default() -> Self {
        Self::new()
    }
}

/// exfer-mcp EXTERNAL-mode env pointed at the embedded walletd.
fn external_env(conn: &ConnectionInfo) -> HashMap<String, String> {
    let mut e = HashMap::new();
    e.insert("WALLETD_URL".into(), conn.base_url.clone());
    e.insert("WALLETD_TOKEN_READ".into(), conn.token_read.clone());
    e.insert("WALLETD_TOKEN_MANAGE".into(), conn.token_manage.clone());
    e.insert("WALLETD_TOKEN_SPEND".into(), conn.token_spend.clone());
    if !conn.fingerprint.is_empty() {
        e.insert("WALLETD_FINGERPRINT".into(), conn.fingerprint.clone());
    }
    // The on-ramp tools use the community pool + its pinned CA by default.
    e.insert("EXFER_ENABLE_SWAP".into(), "1".into());
    e
}

/// Spawn + MCP-handshake exfer-mcp if not already running.
async fn ensure_started(mcp: &McpCtx, env: HashMap<String, String>) -> Result<(), String> {
    let mut guard = mcp.inner.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let bin = std::env::var("EXFER_MCP_CMD").unwrap_or_else(|_| "uvx".into());
    let pin = std::env::var("EXFER_MCP_PIN").unwrap_or_else(|_| "exfer-mcp==0.6.0".into());
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg(pin);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let transport = TokioChildProcess::new(cmd).map_err(|e| format!("spawn exfer-mcp: {e}"))?;
    let client = ().serve(transport).await.map_err(|e| format!("mcp handshake failed: {e}"))?;
    *guard = Some(client);
    Ok(())
}

/// Read the embedded walletd connection (url + tokens + fingerprint) from the
/// app context, erroring if walletd isn't ready yet.
async fn conn_of(app: &AppCtx) -> Result<Arc<ConnectionInfo>, String> {
    let inner = app.inner.lock().await;
    inner
        .conn
        .clone()
        .ok_or_else(|| "walletd not ready".to_string())
}

#[tauri::command]
pub async fn mcp_start(app: State<'_, AppCtx>, mcp: State<'_, McpCtx>) -> Result<(), String> {
    let conn = conn_of(&app).await?;
    ensure_started(&mcp, external_env(&conn)).await
}

#[tauri::command]
pub async fn mcp_list_tools(
    app: State<'_, AppCtx>,
    mcp: State<'_, McpCtx>,
) -> Result<Value, String> {
    let conn = conn_of(&app).await?;
    ensure_started(&mcp, external_env(&conn)).await?;
    let guard = mcp.inner.lock().await;
    let client = guard.as_ref().ok_or("mcp not started")?;
    let tools = client
        .list_all_tools()
        .await
        .map_err(|e| format!("list_tools: {e}"))?;
    let tools_json = serde_json::to_value(tools).map_err(|e| e.to_string())?;
    Ok(json!({ "tools": tools_json }))
}

#[tauri::command]
pub async fn mcp_call_tool(
    app: State<'_, AppCtx>,
    mcp: State<'_, McpCtx>,
    name: String,
    args: Value,
) -> Result<Value, String> {
    let conn = conn_of(&app).await?;
    ensure_started(&mcp, external_env(&conn)).await?;
    let arguments = args.as_object().cloned();
    let guard = mcp.inner.lock().await;
    let client = guard.as_ref().ok_or("mcp not started")?;
    let res = client
        .call_tool(CallToolRequestParams {
            name: name.clone().into(),
            arguments,
            meta: None,
            task: None,
        })
        .await
        .map_err(|e| format!("call_tool {name}: {e}"))?;
    serde_json::to_value(res).map_err(|e| e.to_string())
}
