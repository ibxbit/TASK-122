import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger';

/* =========================================================================
 * Audit Bundle Signer — RSA-SHA256 cryptographic signing for export bundles.
 *
 *  On first run, generates a 2048-bit RSA keypair stored in:
 *    userData/keys/audit-signing.key      (private, chmod 0o400)
 *    userData/keys/audit-signing.pub.pem  (public,  embeddable in exports)
 *
 *  signBuffer(data)   → RSA-SHA256 signature (Buffer)
 *  verifyBuffer(data, sig) → boolean
 *  getPublicKeyPem()  → PEM string for inclusion in manifests
 *
 *  The keypair is per-installation.  In a multi-node deployment, each
 *  node signs its own exports; the public key is included in the bundle
 *  so any verifier can check integrity without a central key server.
 * ========================================================================= */

const KEY_DIR      = () => path.join(app.getPath('userData'), 'keys');
const PRIVATE_PATH = () => path.join(KEY_DIR(), 'audit-signing.key');
const PUBLIC_PATH  = () => path.join(KEY_DIR(), 'audit-signing.pub.pem');

let cachedPrivateKey: string | null = null;
let cachedPublicKey:  string | null = null;

export async function ensureSigningKeypair(): Promise<void> {
  const privPath = PRIVATE_PATH();
  const pubPath  = PUBLIC_PATH();

  try {
    await fs.access(privPath);
    await fs.access(pubPath);
    // Keys exist — load into cache
    cachedPrivateKey = await fs.readFile(privPath, 'utf8');
    cachedPublicKey  = await fs.readFile(pubPath,  'utf8');
    return;
  } catch {
    // Keys don't exist — generate
  }

  logger.info('generating_audit_signing_keypair');
  await fs.mkdir(KEY_DIR(), { recursive: true });

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  await fs.writeFile(privPath, privateKey, 'utf8');
  try { await fs.chmod(privPath, 0o400); } catch { /* Windows best-effort */ }

  await fs.writeFile(pubPath, publicKey, 'utf8');

  cachedPrivateKey = privateKey;
  cachedPublicKey  = publicKey;
  logger.info('audit_signing_keypair_generated');
}

export function signBuffer(data: Buffer): Buffer {
  if (!cachedPrivateKey) throw new Error('signing_keypair_not_initialized');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  sign.end();
  return sign.sign(cachedPrivateKey);
}

export function verifyBuffer(data: Buffer, signature: Buffer): boolean {
  if (!cachedPublicKey) throw new Error('signing_keypair_not_initialized');
  try {
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(data);
    verify.end();
    return verify.verify(cachedPublicKey, signature);
  } catch {
    return false;
  }
}

export function getPublicKeyPem(): string {
  if (!cachedPublicKey) throw new Error('signing_keypair_not_initialized');
  return cachedPublicKey;
}
