//! Build the official Exfer "wallet.key" (EXFK) file for a single
//! address, so it imports cleanly into exfer.dev ("Import wallet.key")
//! and the `exfer wallet` CLI.
//!
//! Byte-for-byte identical to the exfer crate's `Wallet::save_encrypted`
//! (81 bytes):
//!   "EXFK" magic (4) + version u8 (1) + Argon2id salt (16)
//!   + AES-256-GCM nonce (12) + ciphertext (48 = 32-byte ed25519 secret
//!   + 16-byte GCM tag)
//!
//! KDF: Argon2id, V0x13, m=262144 KiB (256 MiB), t=3, p=1, 32-byte out —
//! matching the official wallet's at-rest hardening so the same
//! passphrase decrypts on the other side.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::rngs::OsRng;
use rand::RngCore;

const MAGIC: &[u8; 4] = b"EXFK";
const VERSION: u8 = 1;

fn derive_key(passphrase: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    let argon2 = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(262_144, 3, 1, Some(32)).map_err(|e| format!("argon2 params: {e}"))?,
    );
    let mut out = [0u8; 32];
    argon2
        .hash_password_into(passphrase, salt, &mut out)
        .map_err(|e| format!("argon2 derive: {e}"))?;
    Ok(out)
}

/// Encode a raw 32-byte ed25519 secret into an EXFK file buffer,
/// encrypted with `passphrase`.
pub fn build_exfk(secret: &[u8; 32], passphrase: &[u8]) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);

    let aes_key = derive_key(passphrase, &salt)?;
    let cipher =
        Aes256Gcm::new_from_slice(&aes_key).map_err(|e| format!("aes init: {e}"))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), secret.as_slice())
        .map_err(|e| format!("aes encrypt: {e}"))?;

    let mut buf = Vec::with_capacity(81);
    buf.extend_from_slice(MAGIC);
    buf.push(VERSION);
    buf.extend_from_slice(&salt);
    buf.extend_from_slice(&nonce_bytes);
    buf.extend_from_slice(&ciphertext);
    Ok(buf)
}
