# Bundled Resources

Assets copied into the installed `resources/` directory at build time:

| File              | Purpose                                                            |
|-------------------|--------------------------------------------------------------------|
| `tray-icon.png`   | 16×16 RGBA icon used by `src/main/tray/tray.ts`                    |
| `public-key.pem`  | 2048-bit RSA public key consumed by `src/main/updates/signature.ts` |

Both files are **real binaries / PEM-encoded keys** committed to the repo so
a fresh clone renders the tray icon and loads the update verifier out of
the box.  Production release builds rotate both via the signing pipeline;
the checked-in key is the development/CI key only.

Code path contracts:

* `tray.ts` loads the icon via `nativeImage.createFromPath` and warns only
  when `isEmpty()` returns true.  The committed PNG passes this check.
* `signature.ts` requires an RSA-SHA256-verifiable signature; an invalid or
  mismatched key rejects every package, which is the fail-closed behaviour.
* The audit-bundle signer generates a per-installation keypair into
  `userData/keys/` — it does not rely on `public-key.pem`.
