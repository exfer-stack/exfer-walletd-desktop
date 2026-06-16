<!-- Release notes for the NEXT tag. Updated in the release commit; CI bakes
     this file into the GitHub Release body AND latest.json's notes, which the
     in-app update modal shows. English only; the app renders the
     "## What's new" bullets and stops at the first horizontal rule. History
     lives in git; this file only ever describes the upcoming release. -->

## What's new

- Automatic recovery for interrupted swaps — now both directions. If a swap is
  cut off at the final step (lost connection, app quit, fresh install), the
  wallet finds your stranded funds and returns them automatically when you reopen
  it: your EXFER on a sell, and now your BNB on a buy. As long as you have your
  wallet, no action is needed.
- Clearer guidance while a swap is in progress. The app now reminds you to keep
  it running until the swap finishes, and to reopen it to continue if you quit —
  so a swap is far less likely to be left waiting.
- Small fixes and consistency improvements.
