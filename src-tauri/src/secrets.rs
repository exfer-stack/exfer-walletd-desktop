//! Thin wrapper around the OS keychain for the walletd keystore
//! passphrase. macOS → Keychain, Windows → Credential Manager,
//! Linux → libsecret (secret-service).
//!
//! Service id is the Tauri application identifier so a single user can
//! have multiple installs (e.g. dev + release) without collisions; the
//! account field is a fixed `"keystore-passphrase"` string.

use anyhow::Context;
use keyring::Entry;

const ACCOUNT: &str = "keystore-passphrase";

fn entry(service: &str) -> anyhow::Result<Entry> {
    Entry::new(service, ACCOUNT).context("opening keyring entry")
}

/// Fetch the saved passphrase, returning `Ok(None)` if none has been
/// stored yet on this machine. Any other error (locked keychain,
/// permission denied) is bubbled up.
pub fn get_passphrase(service: &str) -> anyhow::Result<Option<String>> {
    match entry(service)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow::Error::new(e).context("reading keyring entry")),
    }
}

/// Persist the passphrase. Overwrites any prior value for the same
/// service/account pair.
pub fn set_passphrase(service: &str, value: &str) -> anyhow::Result<()> {
    entry(service)?
        .set_password(value)
        .context("writing keyring entry")
}

/// Remove the stored passphrase. A missing entry is treated as success
/// (the goal — no passphrase on disk — is already met).
pub fn delete_passphrase(service: &str) -> anyhow::Result<()> {
    match entry(service)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow::Error::new(e).context("deleting keyring entry")),
    }
}
