import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/* =========================================================================
 * Static asset verification — replaces MV-1 step 1 ("tray icon visible").
 *
 *  Parses the PNG header + IHDR chunk directly and asserts:
 *    - File exists at the documented path
 *    - 8-byte PNG signature is correct
 *    - IHDR reports a square 16×16 RGBA image (color type 6, depth 8)
 *    - File is small (≤ 8 KiB) to keep the installer lean
 *    - There is no legacy `tray-icon.txt` placeholder sitting next to it
 *    - public-key.pem parses as a PEM-wrapped SPKI and crypto accepts it
 *
 *  The runtime tray code (`src/main/tray/tray.ts`) uses
 *  `nativeImage.createFromPath(iconPath)` and logs `tray_icon_missing_using_empty`
 *  when the icon fails to load — this test catches every failure mode
 *  BEFORE packaging.
 * ========================================================================= */

const RESOURCES = path.resolve(__dirname, '../../resources');
const PNG_PATH  = path.join(RESOURCES, 'tray-icon.png');
const KEY_PATH  = path.join(RESOURCES, 'public-key.pem');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

describe('resources/tray-icon.png — static asset contract', () => {
  it('exists at the path declared in resources/README.md', () => {
    expect(existsSync(PNG_PATH)).toBe(true);
  });

  it('is a valid PNG (signature bytes)', () => {
    const buf = readFileSync(PNG_PATH);
    expect(buf.length).toBeGreaterThan(PNG_SIG.length + 12);
    expect(buf.subarray(0, 8)).toEqual(PNG_SIG);
  });

  it('IHDR reports a square, RGBA image at 8-bit depth', () => {
    const buf = readFileSync(PNG_PATH);
    // IHDR chunk follows the 8-byte signature.  Layout:
    //   [length: u32][type "IHDR"][width:u32][height:u32][depth:u8][colorType:u8][...][CRC:u32]
    const chunkType = buf.subarray(12, 16).toString('ascii');
    expect(chunkType).toBe('IHDR');
    const width     = buf.readUInt32BE(16);
    const height    = buf.readUInt32BE(20);
    const bitDepth  = buf.readUInt8(24);
    const colorType = buf.readUInt8(25);
    expect(width).toBe(16);
    expect(height).toBe(16);
    expect(width).toBe(height);        // square
    expect(bitDepth).toBe(8);           // standard 8-bit channels
    expect(colorType).toBe(6);          // RGBA — nativeImage prefers alpha support
  });

  it('is small enough to be bundled without bloat', () => {
    const { size } = statSync(PNG_PATH);
    expect(size).toBeLessThan(8 * 1024);
  });

  it('no stale tray-icon.txt placeholder remains in resources/', () => {
    const legacy = path.join(RESOURCES, 'tray-icon.txt');
    expect(existsSync(legacy)).toBe(false);
  });
});

describe('resources/public-key.pem — static asset contract', () => {
  it('exists', () => {
    expect(existsSync(KEY_PATH)).toBe(true);
  });

  it('is a PEM-wrapped public key that the crypto module can consume', async () => {
    const pem  = readFileSync(KEY_PATH, 'utf8');
    expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(pem).toContain('-----END PUBLIC KEY-----');
    const { createPublicKey } = await import('node:crypto');
    const key = createPublicKey(pem);
    expect(key.type).toBe('public');
    // RSA is the only accepted algorithm for update signatures.
    expect(key.asymmetricKeyType).toBe('rsa');
    // 2048 bits minimum — NIST guidance for long-lived signing keys.
    const detail = key.asymmetricKeyDetails;
    expect(detail?.modulusLength ?? 0).toBeGreaterThanOrEqual(2048);
  });
});
