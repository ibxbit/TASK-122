import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger';
import { resourceRegistry, type TrackingHandle } from '../resources/lifecycle';

/* =========================================================================
 * Image Cleanup — prompt disposal of review-image Buffers.
 *
 *  Review images (JPEG/PNG, ≤5 MB each, ≤5 per review) pass through a
 *  handful of transient Buffers: IPC payload → validation → disk write →
 *  optional thumbnail.  Without discipline, a burst of uploads can inflate
 *  the heap past the 300 MB budget before V8 decides to GC.
 *
 *  Three entry points:
 *    trackImageBuffer(buf, label)   — register for visibility
 *    processImageBuffer(buf, ..., fn) — try/finally wrapper, guaranteed release
 *    persistAndReleaseImage(buf, dst, label) — atomic write + sha256 + dispose
 * ========================================================================= */

export interface TrackedImage {
  readonly buffer:  Buffer;
  readonly bytes:   number;
  readonly handle:  TrackingHandle;
}

export function trackImageBuffer(buf: Buffer, label: string): TrackedImage {
  const handle = resourceRegistry.track({
    kind:    'image-buffer',
    label,
    bytes:   buf.byteLength,
    // Buffers are GC'd once all references drop — the dispose callback is a
    // no-op, but the tracking entry is what lets the memory-safety module
    // count image bytes in flight.
    dispose: () => { /* reference-drop-on-untrack */ },
  });
  return { buffer: buf, bytes: buf.byteLength, handle };
}

export async function disposeImageBuffer(img: TrackedImage): Promise<void> {
  await resourceRegistry.untrack(img.handle);
}

/**
 * Run `processor` with a tracked buffer; dispose and untrack it on exit,
 * even when `processor` throws or rejects.  Preferred pattern for review
 * image intake:
 *
 *   await processImageBuffer(incoming, 'review_asset', async (buf) => {
 *     validateMimeAndSize(buf);
 *     await persistAndReleaseImage(buf, targetPath, 'review_asset_write');
 *   });
 */
export async function processImageBuffer<R>(
  buf:       Buffer,
  label:     string,
  processor: (buf: Buffer) => Promise<R> | R,
): Promise<R> {
  const tracked = trackImageBuffer(buf, label);
  try { return await processor(tracked.buffer); }
  finally { await disposeImageBuffer(tracked); }
}

/* ------------------------------------------------------------------ */

export interface PersistedImage {
  path:       string;
  sha256:     string;
  size_bytes: number;
}

/**
 * Atomic write (tmp + fsync + rename) + sha256 + disposal in one call.
 * Caller must drop its own reference to `buf` after await so the Buffer
 * is eligible for GC.
 */
export async function persistAndReleaseImage(
  buf:         Buffer,
  destination: string,
  label:       string,
): Promise<PersistedImage> {
  return processImageBuffer(buf, label, async (b) => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const tmp = `${destination}.tmp`;
    const fh  = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(b);
      await fh.sync();
    } finally { await fh.close(); }
    await fs.rename(tmp, destination);

    const sha256 = crypto.createHash('sha256').update(b).digest('hex');
    logger.info({ destination, size: b.byteLength, sha256: sha256.slice(0, 12) }, 'image_persisted');
    return { path: destination, sha256, size_bytes: b.byteLength };
  });
}

/**
 * Bulk disposal — called on memory pressure by the memory-safety module to
 * force-drop every tracked image buffer still held by subsystems.
 */
export async function disposeAllTrackedImages(): Promise<number> {
  return resourceRegistry.disposeByKind('image-buffer');
}
