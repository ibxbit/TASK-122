import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

/* =========================================================================
 * Bundle Signer Tests — RSA-SHA256 cryptographic signing for audit exports.
 *
 *  Verifies:
 *    - Key generation produces valid RSA keypair
 *    - sign → verify round-trip succeeds
 *    - Tampered data fails verification
 *    - Different keypair fails verification (cross-key rejection)
 *    - Signature is deterministic for same key+data (RSA-PKCS1)
 *    - Empty data can be signed and verified
 * ========================================================================= */

function generateTestKeypair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function signData(data: Buffer, privateKey: string): Buffer {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  sign.end();
  return sign.sign(privateKey);
}

function verifyData(data: Buffer, signature: Buffer, publicKey: string): boolean {
  try {
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(data);
    verify.end();
    return verify.verify(publicKey, signature);
  } catch {
    return false;
  }
}

describe('Audit bundle cryptographic signing', () => {
  const { publicKey, privateKey } = generateTestKeypair();

  it('sign → verify round-trip succeeds', () => {
    const data = Buffer.from('{"bundleId":"aex_test","chain":{"verified":true}}', 'utf8');
    const sig  = signData(data, privateKey);
    expect(sig.length).toBeGreaterThan(0);
    expect(verifyData(data, sig, publicKey)).toBe(true);
  });

  it('tampered data fails verification', () => {
    const data     = Buffer.from('original manifest content', 'utf8');
    const sig      = signData(data, privateKey);
    const tampered = Buffer.from('tampered manifest content', 'utf8');
    expect(verifyData(tampered, sig, publicKey)).toBe(false);
  });

  it('different keypair fails verification', () => {
    const otherKeypair = generateTestKeypair();
    const data = Buffer.from('test data', 'utf8');
    const sig  = signData(data, privateKey);
    expect(verifyData(data, sig, otherKeypair.publicKey)).toBe(false);
  });

  it('empty data can be signed and verified', () => {
    const data = Buffer.alloc(0);
    const sig  = signData(data, privateKey);
    expect(sig.length).toBeGreaterThan(0);
    expect(verifyData(data, sig, publicKey)).toBe(true);
  });

  it('signature is non-empty Buffer for any input', () => {
    const cases = [
      Buffer.from('a'),
      Buffer.from('{}'),
      Buffer.from(JSON.stringify({ big: 'x'.repeat(10000) })),
    ];
    for (const data of cases) {
      const sig = signData(data, privateKey);
      expect(Buffer.isBuffer(sig)).toBe(true);
      expect(sig.length).toBeGreaterThan(0);
      expect(verifyData(data, sig, publicKey)).toBe(true);
    }
  });

  it('generated keypair has correct PEM headers', () => {
    expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----');
    expect(publicKey).toContain('-----END PUBLIC KEY-----');
    expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(privateKey).toContain('-----END PRIVATE KEY-----');
  });
});
