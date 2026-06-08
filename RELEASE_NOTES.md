<!-- Release notes for the NEXT tag. Updated in the release commit; CI bakes
     this file into the GitHub Release body AND latest.json's notes, which the
     in-app update modal shows. English only; the app renders the
     "## What's new" bullets and stops at the first horizontal rule. History
     lives in git; this file only ever describes the upcoming release. -->

## What's new

- **Activity now shows incoming transactions.** Received funds — and your full
  on-chain history — show up in Activity; previously only the transfers you sent
  were listed.
- A small **"confirming" hint** on Receive / Swap / Liquidity / Vote when a
  deposit hasn't confirmed yet, so those screens line up with your home total.
  Spendable balance and voting power still use confirmed funds only.
