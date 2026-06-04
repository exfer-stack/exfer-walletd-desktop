// Explorer URLs, routed by chain. Ported from the mobile wallet.

export const EXPLORER = "https://explorer.exfer.dev";
// BSC block explorer for the BNB leg of a swap. Testnet (Chapel) while the HTLC
// contract is on testnet; switch to https://bscscan.com on mainnet.
export const BSC_EXPLORER = "https://testnet.bscscan.com";

/** Explorer URL for a tx, routed by chain: a 0x-prefixed hash is a BSC tx
 *  (BscScan); anything else is an EXFER tx id (the EXFER explorer). */
export function txExplorerUrl(txid: string): string {
  return txid.startsWith("0x") ? `${BSC_EXPLORER}/tx/${txid}` : `${EXPLORER}/tx/${txid}`;
}

/** Address explorer URL on the EXFER chain. */
export function addrExplorerUrl(address: string): string {
  return `${EXPLORER}/address/${address}`;
}
