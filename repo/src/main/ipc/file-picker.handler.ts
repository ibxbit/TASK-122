import { dialog, ipcMain, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import { REVIEW_LIMITS } from '../reviews/validation';

/* =========================================================================
 * File-picker IPC
 *
 *  The immediate-mode renderer has no DOM <input type=file>, so image
 *  selection for review assets goes through the main process:
 *
 *    files:pickImages → showOpenDialog(filters=image/jpeg|png) →
 *      read each file, validate size + mime, return
 *      [{ name, mimeType, sizeBytes, base64 }]
 *
 *  Validation mirrors the server-side rules so the UI can show early
 *  errors without a full IPC round-trip.  The final truth is still the
 *  review.create / review.followUp handler (which runs the exact same
 *  validators via `persistReviewAssets`), so a renderer bug cannot widen
 *  the policy.
 * ========================================================================= */

export interface PickedImage {
  name:       string;
  mimeType:   string;
  sizeBytes:  number;
  base64:     string;
}

export function registerFilePickerHandlers(): void {
  ipcMain.handle('files:pickImages', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const opts = {
      title:       'Attach images to review',
      properties:  ['openFile', 'multiSelections'] as const,
      filters:     [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: true, files: [] as PickedImage[] };
    }

    if (result.filePaths.length > REVIEW_LIMITS.MAX_ASSETS) {
      return { ok: false, error: `too_many_selected:${result.filePaths.length}>${REVIEW_LIMITS.MAX_ASSETS}` };
    }

    const files: PickedImage[] = [];
    for (const p of result.filePaths) {
      try {
        const stat = await fs.stat(p);
        if (stat.size > REVIEW_LIMITS.MAX_ASSET_BYTES) {
          return { ok: false, error: `too_large:${path.basename(p)}` };
        }
        const ext = path.extname(p).toLowerCase();
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                   : ext === '.png' ? 'image/png'
                   : null;
        if (!mime) {
          return { ok: false, error: `bad_extension:${path.basename(p)}` };
        }
        const data = await fs.readFile(p);
        files.push({
          name:      path.basename(p),
          mimeType:  mime,
          sizeBytes: stat.size,
          base64:    data.toString('base64'),
        });
      } catch (err) {
        logger.warn({ err, path: p }, 'file_picker_read_failed');
        return { ok: false, error: `read_failed:${path.basename(p)}` };
      }
    }
    return { ok: true, files };
  });
}
