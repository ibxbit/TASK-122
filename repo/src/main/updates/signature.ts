import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* =========================================================================
 * Signature Verification
 *
 *  Package layout (directory on USB or local disk):
 *    <pkg>/
 *      manifest.json      metadata + per-file sha256
 *      signature.bin      RSA-SHA256 signature of manifest.json bytes
 *      payload/           files to install, preserving relative paths
 *
 *  Two-stage trust model:
 *    1. Verify RSA signature over manifest.json using the bundled public key
 *       → proves manifest was produced by the release signer
 *    2. For every payloadFiles entry, re-hash the file on disk and compare
 *       → manifest ⇒ payload integrity, so everything transitively trusted
 * ========================================================================= */

export interface ManifestFile {
  path:       string;     // relative to payload/
  sha256:     string;     // lowercase hex
  size_bytes: number;
}

export interface PackageManifest {
  name:             string;
  version:          string;
  minFromVersion?:  string;        // oldest current version allowed to upgrade
  generatedAt:      string;        // ISO-8601
  issuer:           string;
  payloadFiles:     ManifestFile[];
}

export class SignatureError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(`signature_error:${code}${detail ? `:${detail}` : ''}`);
    this.name = 'SignatureError';
  }
}

/* ------------------------------------------------------------------ *
 *  Primary API — reads, verifies, and returns the parsed manifest.   *
 *  Throws SignatureError on any integrity failure.                    *
 * ------------------------------------------------------------------ */

export async function readAndVerifyManifest(
  packageDir: string,
  publicKeyPem: string,
): Promise<PackageManifest> {
  const manifestPath  = path.join(packageDir, 'manifest.json');
  const signaturePath = path.join(packageDir, 'signature.bin');

  const manifestBuf  = await tryRead(manifestPath,  'manifest_missing');
  const signatureBuf = await tryRead(signaturePath, 'signature_missing');

  if (!verifySignatureBytes(manifestBuf, signatureBuf, publicKeyPem)) {
    throw new SignatureError('signature_invalid');
  }

  let parsed: unknown;
  try { parsed = JSON.parse(manifestBuf.toString('utf8')); }
  catch { throw new SignatureError('manifest_malformed'); }

  validateManifestShape(parsed);
  return parsed;
}

/** Low-level RSA-SHA256 verification — usable for any signed blob. */
export function verifySignatureBytes(
  data: Buffer, signature: Buffer, publicKeyPem: string,
): boolean {
  try {
    const v = crypto.createVerify('RSA-SHA256');
    v.update(data);
    v.end();
    return v.verify(publicKeyPem, signature);
  } catch {
    return false;
  }
}

/** Walks manifest.payloadFiles and checks each file's size + sha256. */
export async function verifyManifestHashes(
  packageDir: string,
  manifest: PackageManifest,
): Promise<void> {
  const payloadRoot = path.join(packageDir, 'payload');
  for (const f of manifest.payloadFiles) {
    const abs = path.join(payloadRoot, f.path);
    let stat;
    try { stat = await fs.stat(abs); }
    catch { throw new SignatureError('payload_missing', f.path); }

    if (stat.size !== f.size_bytes) throw new SignatureError('size_mismatch', f.path);

    const actual = await sha256File(abs);
    if (actual !== f.sha256.toLowerCase()) {
      throw new SignatureError('sha256_mismatch', f.path);
    }
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash   = crypto.createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

/** Numeric semver-ish comparison.  -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const n  = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* ------------------------------------------------------------------ */

async function tryRead(p: string, missingCode: string): Promise<Buffer> {
  try { return await fs.readFile(p); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SignatureError(missingCode);
    }
    throw err;
  }
}

function validateManifestShape(m: unknown): asserts m is PackageManifest {
  if (!m || typeof m !== 'object') throw new SignatureError('manifest_malformed');
  const x = m as Record<string, unknown>;

  if (typeof x.name        !== 'string' || !x.name)     throw new SignatureError('manifest_missing_name');
  if (typeof x.version     !== 'string' || !x.version)  throw new SignatureError('manifest_missing_version');
  if (typeof x.generatedAt !== 'string')                 throw new SignatureError('manifest_missing_generatedAt');
  if (typeof x.issuer      !== 'string')                 throw new SignatureError('manifest_missing_issuer');
  if (!Array.isArray(x.payloadFiles))                    throw new SignatureError('manifest_missing_files');

  for (const f of x.payloadFiles) {
    const y = f as Record<string, unknown>;
    if (typeof y.path       !== 'string' ||
        typeof y.sha256     !== 'string' ||
        typeof y.size_bytes !== 'number') {
      throw new SignatureError('manifest_file_shape');
    }
  }
  if (x.minFromVersion !== undefined && typeof x.minFromVersion !== 'string') {
    throw new SignatureError('manifest_minFromVersion_shape');
  }
}
