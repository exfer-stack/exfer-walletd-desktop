//! `Result` and error types shared by the Tauri shell. All Tauri
//! commands return strings — Tauri converts `Result<T, String>` cleanly
//! to a frontend rejection — so this exists mostly so internal callers
//! get richer types.

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("walletd not ready yet")]
    NotReady,
    #[error("walletd already running")]
    AlreadyRunning,
    #[error("invalid fingerprint: {0}")]
    InvalidFingerprint(String),
    #[error("upstream JSON-RPC error (code {code}): {message}")]
    RpcError { code: i64, message: String },
    #[error("transport: {0}")]
    Transport(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl AppError {
    /// Stringify into a frontend-friendly message. Tauri commands
    /// surface `Err(String)` to the JS side, so we collapse here.
    pub fn to_user_string(&self) -> String {
        self.to_string()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UiError {
    pub message: String,
}

impl From<AppError> for UiError {
    fn from(e: AppError) -> Self {
        UiError {
            message: e.to_user_string(),
        }
    }
}
