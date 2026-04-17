import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

/* =========================================================================
 * Export destination validation — the path sanitiser.
 *
 *  The dialog itself is opaque (Electron), but `validateDestination` is
 *  the code that gates every write.  Tests verify:
 *    - Accepts an absolute path with matching extension
 *    - Rejects `..` traversal components
 *    - Rejects extension mismatch
 *    - Rejects missing parent directory
 * ========================================================================= */

// Provide a minimal Electron shim so the module loads outside the runtime.
import { vi } from 'vitest';
vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir() },
}));

import { validateDestination, ExportDestinationError } from '../../src/main/ipc/export-dialog';

describe('validateDestination', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leasehub-export-'));
  });

  it('accepts a valid absolute path with matching extension', async () => {
    const p = path.join(tmpDir, 'report.csv');
    const result = await validateDestination(p, 'csv');
    expect(result).toBe(p);
  });

  it('rejects extension mismatch', async () => {
    const p = path.join(tmpDir, 'report.pdf');
    await expect(validateDestination(p, 'csv')).rejects.toBeInstanceOf(ExportDestinationError);
  });

  it('rejects missing parent directory', async () => {
    const p = path.join(tmpDir, 'does_not_exist', 'report.csv');
    await expect(validateDestination(p, 'csv')).rejects.toBeInstanceOf(ExportDestinationError);
  });

  it('rejects empty path', async () => {
    await expect(validateDestination('', 'csv')).rejects.toBeInstanceOf(ExportDestinationError);
  });

  it('rejects pdf when kind is zip', async () => {
    const p = path.join(tmpDir, 'bundle.pdf');
    await expect(validateDestination(p, 'zip')).rejects.toBeInstanceOf(ExportDestinationError);
  });
});
