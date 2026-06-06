// Explorer URLs, routed by chain. Ported from the mobile wallet.

import { getSwapConfig } from "./rpc";

export const EXPLORER = "https://explorer.exfer.dev";

// BSC block explorer for the BNB leg of a swap. Mainnet by default — walletd's
// default chain id is 56 — and flips to Chapel's explorer only when the desktop
// config pins bsc_chain_id=97. Resolved once at module load; links rendered
// before the config answers use the mainnet default, which is also the answer
// in every non-testnet install.
let bscExplorer = "https://bscscan.com";
getSwapConfig()
  .then((cfg) => {
    if (cfg.bsc_chain_id === 97) bscExplorer = "https://testnet.bscscan.com";
  })
  .catch(() => {}); // config unreadable ⇒ keep the mainnet default

/** Explorer URL for a tx, routed by chain: a 0x-prefixed hash is a BSC tx
 *  (BscScan); anything else is an EXFER tx id (the EXFER explorer). */
export function txExplorerUrl(txid: string): string {
  return txid.startsWith("0x") ? `${bscExplorer}/tx/${txid}` : `${EXPLORER}/tx/${txid}`;
}

/** Address explorer URL on the EXFER chain. */
export function addrExplorerUrl(address: string): string {
  return `${EXPLORER}/address/${address}`;
}
