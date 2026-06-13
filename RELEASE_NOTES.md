<!-- Release notes for the NEXT tag. Updated in the release commit; CI bakes
     this file into the GitHub Release body AND latest.json's notes, which the
     in-app update modal shows. English only; the app renders the
     "## What's new" bullets and stops at the first horizontal rule. History
     lives in git; this file only ever describes the upcoming release. -->

## What's new

- **Import wallet.key files that the phone app accepts.** The desktop app now
  takes the same key files as Exfer mobile — including raw (unencrypted)
  private-key files — so a key that imported on your phone imports here too.
  Files that previously failed with a "wrong length" or "incorrect password"
  message now go in, and the password field is optional for unencrypted keys.
- **BNB key export now shows your recovery phrase**, not just the private key,
  so you can back up the phrase again from the export screen.
- Small fixes and consistency improvements.
