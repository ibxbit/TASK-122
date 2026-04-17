import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions, verifySignatureBytes,
  readAndVerifyManifest, verifyManifestHashes, sha256File,
  SignatureError,
} from '../../src/main/updates/signature';

/* =========================================================================
 *  Update signature + manifest integrity.
 * ========================================================================= */

describe('compareVersions()', () => {
  it('orders by major / minor / patch', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
  });
  it('tolerates missing components', () => {
    expect(compareVersions('1.2',   '1.2.0')).toBe(0);
    expect(compareVersions('1',     '1.0.1')).toBe(-1);
    expect(compareVersions('1.0.1', '1')).toBe(1);
  });
});

describe('verifySignatureBytes()', () => {
  it('verifies RSA-SHA256 signatures round-trip', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const data = Buffer.from('hello, world');
    const sig = crypto.sign('RSA-SHA256', data, privateKey);
    const ok = verifySignatureBytes(data, sig, publicKey.export({ type: 'spki', format: 'pem' }).toString());
    expect(ok).toBe(true);
  });

  it('rejects tampered data', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const data = Buffer.from('hello, world');
    const sig  = crypto.sign('RSA-SHA256', data, privateKey);
    const ok = verifySignatureBytes(Buffer.from('bye, world'), sig, publicKey.export({ type: 'spki', format: 'pem' }).toString());
    expect(ok).toBe(false);
  });

  it('returns false (not throw) on malformed key input', () => {
    expect(verifySignatureBytes(Buffer.from('x'), Buffer.from('x'), 'not-a-pem')).toBe(false);
  });
});

describe('readAndVerifyManifest() + verifyManifestHashes()', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lh-pkg-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function makePackage(opts: { tamperHash?: boolean; missingSig?: boolean } = {}): Promise<string> {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fileBody = Buffer.from('hello update');
    await fs.mkdir(path.join(dir, 'payload'), { recursive: true });
    await fs.writeFile(path.join(dir, 'payload', 'app.txt'), fileBody);

    const manifest = {
      name:        'lh',
      version:     '2.0.0',
      issuer:      'LeaseHub',
      generatedAt: new Date().toISOString(),
      payloadFiles: [{
        path: 'app.txt',
        sha256: opts.tamperHash ? '0'.repeat(64) : crypto.createHash('sha256').update(fileBody).digest('hex'),
        size_bytes: fileBody.length,
      }],
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(dir, 'manifest.json'), manifestBuf);
    if (!opts.missingSig) {
      const sig = crypto.sign('RSA-SHA256', manifestBuf, privateKey);
      await fs.writeFile(path.join(dir, 'signature.bin'), sig);
    }
    return publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  it('reads and validates a signed manifest', async () => {
    const pub = await makePackage();
    const m = await readAndVerifyManifest(dir, pub);
    expect(m.version).toBe('2.0.0');
  });

  it('throws signature_missing when signature.bin is absent', async () => {
    const pub = await makePackage({ missingSig: true });
    await expect(readAndVerifyManifest(dir, pub)).rejects.toBeInstanceOf(SignatureError);
  });

  it('detects hash mismatch on payload', async () => {
    const pub = await makePackage({ tamperHash: true });
    const m = await readAndVerifyManifest(dir, pub);
    await expect(verifyManifestHashes(dir, m)).rejects.toBeInstanceOf(SignatureError);
  });

  it('sha256File computes hex digest', async () => {
    await fs.writeFile(path.join(dir, 'x.bin'), Buffer.from('abc'));
    const hex = await sha256File(path.join(dir, 'x.bin'));
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
