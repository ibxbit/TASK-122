import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* =========================================================================
 *  Recovery — atomic write round-trip.  We exercise CheckpointManager's
 *  writeAtomic path indirectly via the timer callback.
 * ========================================================================= */

const DIR = path.join(os.tmpdir(), `lh-cp-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock('electron', () => ({
  app:       { getPath: () => DIR, getVersion: () => '1.0.0' },
  ipcMain:   { on: () => {}, removeListener: () => {} },
}));

import { CheckpointManager, CheckpointPaths } from '../../src/main/recovery/checkpoint';

describe('CheckpointManager writeAtomic round-trip', () => {
  it('start + checkpointNow produces session.json under userData', async () => {
    const mgr = new CheckpointManager({
      openWindows: () => [],   // no windows, snapshot is empty
      kindOf:      () => null,
    });
    await mgr.start();
    await mgr.checkpointNow();
    const raw = await fs.readFile(CheckpointPaths.session(), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.windows)).toBe(true);
    await mgr.stop({ graceful: true });
  });

  it('graceful stop removes the dirty flag', async () => {
    const mgr = new CheckpointManager({ openWindows: () => [], kindOf: () => null });
    await mgr.start();
    await mgr.stop({ graceful: true });
    await expect(fs.access(CheckpointPaths.dirty())).rejects.toBeTruthy();
  });
});
