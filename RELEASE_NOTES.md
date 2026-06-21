<!-- Release notes for the NEXT tag. Updated in the release commit; CI bakes
     this file into the GitHub Release body AND latest.json's notes, which the
     in-app update modal shows. English only; the app renders the
     "## What's new" bullets and stops at the first horizontal rule. History
     lives in git; this file only ever describes the upcoming release. -->

## What's new

- Addresses now have a newer, checksummed "xf…" form alongside the original.
  Click any address to see both formats and copy whichever you need — it's the
  same address with the same balance either way.
- Sending accepts both forms: paste an xf… or a classic address and it just
  works. The xf… form has a built-in check that catches typos, so funds can't
  go to a mistyped address.
