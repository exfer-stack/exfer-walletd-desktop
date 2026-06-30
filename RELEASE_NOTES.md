<!-- Release notes for the NEXT tag. Updated in the release commit; CI bakes
     this file into the GitHub Release body AND latest.json's notes, which the
     in-app update modal shows. English only; the app renders the
     "## What's new" bullets and stops at the first horizontal rule. History
     lives in git; this file only ever describes the upcoming release. -->

## What's new

- The in-wallet AI assistant's tools now run natively inside the app — no external helper process — so the assistant's actions are more reliable and self-contained.
- More resilient cross-chain swaps: the embedded wallet engine now recovers its in-flight locks after a restart, so a swap interrupted by a restart won't get stuck or accidentally re-spend, and swap errors are reported more precisely.
