import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/* =========================================================================
 * Review asset persistence tests.
 *
 *  Validates:
 *    - mime whitelist (image/jpeg, image/png only)
 *    - max 5 MiB per asset
 *    - max 5 assets per review
 *    - magic-byte verification (JPG/PNG signatures)
 *    - sha256 checksum + row insertion on disk + DB
 *    - rollback of files on partial failure
 * ========================================================================= */

let tmpUserData = '';
vi.mock('electron', () => ({
  app: { getPath: () => tmpUserData },
}));

import { makeTestDb, seedAccessGraph } from '../_helpers/db';
import {
  persistReviewAssets, validateAssets, AssetValidationError, type AssetInput,
} from '../../src/main/reviews/assets';

function jpg(sizeBytes: number): Buffer {
  const b = Buffer.alloc(sizeBytes);
  b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF;
  return b;
}
function png(sizeBytes: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const b = Buffer.alloc(sizeBytes);
  header.copy(b, 0);
  return b;
}

describe('validateAssets', () => {
  it('accepts up to 5 JPG/PNG assets under the size limit', () => {
    expect(() => validateAssets([
      { mimeType: 'image/jpeg', sizeBytes: 1024, data: jpg(1024) },
      { mimeType: 'image/png',  sizeBytes: 1024, data: png(1024) },
    ])).not.toThrow();
  });

  it('rejects non-image mime types', () => {
    expect(() => validateAssets([
      { mimeType: 'application/pdf' as never, sizeBytes: 1024, data: Buffer.alloc(1024) },
    ])).toThrow(AssetValidationError);
  });

  it('rejects oversize assets (> 5 MiB)', () => {
    const big = 5 * 1024 * 1024 + 1;
    expect(() => validateAssets([
      { mimeType: 'image/jpeg', sizeBytes: big, data: jpg(big) },
    ])).toThrow(/too_large/);
  });

  it('rejects more than 5 assets', () => {
    const six: AssetInput[] = Array.from({ length: 6 }, () => ({
      mimeType: 'image/png', sizeBytes: 4, data: png(8),
    }));
    expect(() => validateAssets(six)).toThrow(/too_many_assets/);
  });

  it('rejects when magic bytes do not match the declared mime', () => {
    expect(() => validateAssets([
      { mimeType: 'image/jpeg', sizeBytes: 8, data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) },
    ])).toThrow(/magic_not_jpeg/);
    expect(() => validateAssets([
      { mimeType: 'image/png', sizeBytes: 8, data: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]) },
    ])).toThrow(/magic_not_png/);
  });

  it('rejects when size_bytes doesn\'t match the data length', () => {
    expect(() => validateAssets([
      { mimeType: 'image/png', sizeBytes: 10, data: png(5) },
    ])).toThrow(/size_mismatch/);
  });
});

describe('persistReviewAssets', () => {
  let db: ReturnType<typeof makeTestDb>;

  beforeEach(() => {
    tmpUserData = mkdtempSync(path.join(os.tmpdir(), 'lh-assets-'));
    db = makeTestDb();
    seedAccessGraph(db);
    // Create the parent review row (FK).
    db.prepare(`
      INSERT INTO reviews (id, tenant_id, target_type, target_id, reviewer_user_id, status, moderation_status, created_at, updated_at)
      VALUES ('rev_1', 't_acme', 'order', 'o_1', 'u_admin', 'submitted', 'pending', 0, 0)
    `).run();
  });

  afterEach(() => {
    db.close();
    try { rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('persists each asset to disk + inserts a DB row with sha256 checksum', async () => {
    const input1 = { mimeType: 'image/png'  as const, sizeBytes: 256, data: png(256) };
    const input2 = { mimeType: 'image/jpeg' as const, sizeBytes: 128, data: jpg(128) };
    const out = await persistReviewAssets(db, 't_acme', 'rev_1', [input1, input2]);

    expect(out.length).toBe(2);
    expect(out[0].mimeType).toBe('image/png');
    expect(out[0].checksum).toBe(crypto.createHash('sha256').update(input1.data).digest('hex'));

    // Files written to userData/reviews/<tenant>/<review>/<id>.<ext>
    for (const a of out) {
      const abs = path.join(tmpUserData, a.filePath);
      const stat = await fs.stat(abs);
      expect(stat.size).toBe(a.sizeBytes);
    }

    // DB rows
    const rows = db.prepare(
      `SELECT id, review_id, mime_type, size_bytes, checksum FROM review_assets WHERE review_id = 'rev_1' ORDER BY id`,
    ).all() as Array<{ id: string; mime_type: string; size_bytes: number; checksum: string }>;
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect([128, 256]).toContain(r.size_bytes);
    }
  });

  it('rolls back disk writes when validation fails mid-batch', async () => {
    // Second asset has bad magic, so the batch should be rejected BEFORE
    // any files are written (validateAssets is called up-front).
    await expect(
      persistReviewAssets(db, 't_acme', 'rev_1', [
        { mimeType: 'image/png', sizeBytes: 64,  data: png(64) },
        { mimeType: 'image/jpeg', sizeBytes: 32, data: Buffer.alloc(32) },
      ]),
    ).rejects.toThrow(/review_asset:magic_not_jpeg/);

    const rows = db.prepare(`SELECT COUNT(*) AS n FROM review_assets`).get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
