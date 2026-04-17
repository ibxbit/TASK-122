import type { Database } from 'better-sqlite3';
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REVIEW_LIMITS } from './validation';

/* =========================================================================
 * Review Asset Persistence
 *
 *  Reviewers attach up to 5 images (JPEG or PNG, each ≤ 5 MiB).  This
 *  module:
 *
 *    1. Validates the incoming asset list BEFORE any file is written —
 *       validation failures are reported to the renderer with the exact
 *       reason so the UI can display a field-level error.
 *    2. Verifies the bytes via the file magic header (first 8 bytes) so a
 *       .png with forged mime metadata is still rejected.
 *    3. Writes each file into userData/reviews/<tenantId>/<reviewId>/<id>.<ext>
 *       (chmod 0o440) and records a review_assets row with a sha256
 *       checksum so tamper-evidence holds after the fact.
 *    4. Is atomic per review: if any single write fails, previously-written
 *       files for the same review are unlinked and the DB stays unchanged.
 * ========================================================================= */

export interface AssetInput {
  mimeType:  string;
  sizeBytes: number;
  data:      Buffer;                    // raw bytes
}

export interface PersistedAsset {
  id:         string;
  filePath:   string;                   // relative to userData/
  mimeType:   string;
  sizeBytes:  number;
  checksum:   string;
}

export class AssetValidationError extends Error {
  constructor(public readonly code: string, public readonly index?: number) {
    super(`review_asset:${code}${index !== undefined ? `:${index}` : ''}`);
    this.name = 'AssetValidationError';
  }
}

const JPG_MAGIC = Buffer.from([0xFF, 0xD8, 0xFF]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

export function validateAssets(inputs: AssetInput[]): void {
  if (!Array.isArray(inputs)) throw new AssetValidationError('not_array');
  if (inputs.length > REVIEW_LIMITS.MAX_ASSETS) throw new AssetValidationError('too_many_assets');
  for (let i = 0; i < inputs.length; i++) {
    const a = inputs[i];
    if (!a || typeof a !== 'object') throw new AssetValidationError('shape', i);
    if (!REVIEW_LIMITS.ALLOWED_MIME.includes(a.mimeType as typeof REVIEW_LIMITS.ALLOWED_MIME[number])) {
      throw new AssetValidationError('mime_not_allowed', i);
    }
    if (!Buffer.isBuffer(a.data)) throw new AssetValidationError('not_buffer', i);
    if (a.data.length !== a.sizeBytes) throw new AssetValidationError('size_mismatch', i);
    if (a.sizeBytes > REVIEW_LIMITS.MAX_ASSET_BYTES) throw new AssetValidationError('too_large', i);

    const looksJpg = a.data.length >= 3 && a.data.subarray(0, 3).equals(JPG_MAGIC);
    const looksPng = a.data.length >= 8 && a.data.subarray(0, 8).equals(PNG_MAGIC);
    if (a.mimeType === 'image/jpeg' && !looksJpg) throw new AssetValidationError('magic_not_jpeg', i);
    if (a.mimeType === 'image/png'  && !looksPng) throw new AssetValidationError('magic_not_png',  i);
  }
}

function extFor(mime: string): string {
  return mime === 'image/jpeg' ? 'jpg' : 'png';
}

export async function persistReviewAssets(
  db: Database,
  tenantId: string,
  reviewId: string,
  inputs: AssetInput[],
): Promise<PersistedAsset[]> {
  if (inputs.length === 0) return [];
  validateAssets(inputs);

  const base = path.join(app.getPath('userData'), 'reviews', tenantId, reviewId);
  await fs.mkdir(base, { recursive: true });

  const written: Array<{ abs: string; rel: string }> = [];
  const out: PersistedAsset[] = [];

  try {
    for (const input of inputs) {
      const id  = `ra_${crypto.randomBytes(10).toString('hex')}`;
      const ext = extFor(input.mimeType);
      const abs = path.join(base, `${id}.${ext}`);
      const rel = path.relative(app.getPath('userData'), abs);
      const sha = crypto.createHash('sha256').update(input.data).digest('hex');

      await fs.writeFile(abs, input.data);
      try { await fs.chmod(abs, 0o440); } catch { /* Windows best-effort */ }
      written.push({ abs, rel });

      out.push({ id, filePath: rel, mimeType: input.mimeType, sizeBytes: input.sizeBytes, checksum: sha });
    }

    const insert = db.prepare(`
      INSERT INTO review_assets
        (id, tenant_id, review_id, file_path, mime_type, size_bytes, checksum)
      VALUES
        (@id, @tenantId, @reviewId, @filePath, @mimeType, @sizeBytes, @checksum)
    `);
    db.transaction(() => {
      for (const a of out) {
        insert.run({
          id:        a.id,
          tenantId,
          reviewId,
          filePath:  a.filePath,
          mimeType:  a.mimeType,
          sizeBytes: a.sizeBytes,
          checksum:  a.checksum,
        });
      }
    })();
  } catch (err) {
    // Rollback the filesystem writes to keep disk + DB consistent.
    for (const w of written) {
      try { await fs.unlink(w.abs); } catch { /* noop */ }
    }
    throw err;
  }

  return out;
}
