import { describe, expect, it, vi } from 'vitest';

/* =========================================================================
 *  Recovery — snapshot validation.  Electron is stubbed since restore.ts
 *  imports `app`, `dialog`, `screen`.
 * ========================================================================= */

vi.mock('electron', () => ({
  app:    { getVersion: () => '1.0.0' },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
}));

// Private helpers are inlined in the module; the test round-trips via detectDirtyShutdown.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Re-wire CheckpointPaths to a temp dir so tests don't touch the real userData.
vi.mock('../../src/main/recovery/checkpoint', async () => {
  const actual = await vi.importActual<any>('../../src/main/recovery/checkpoint');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lh-checkpoint-'));
  return {
    ...actual,
    CheckpointPaths: {
      dir:     () => dir,
      session: () => path.join(dir, 'session.json'),
      prev:    () => path.join(dir, 'session.prev.json'),
      tmp:     () => path.join(dir, 'session.tmp.json'),
      dirty:   () => path.join(dir, 'dirty.flag'),
    },
  };
});

import {
  detectDirtyShutdown, clearSession,
} from '../../src/main/recovery/restore';
import { CheckpointPaths, CHECKPOINT_VERSION } from '../../src/main/recovery/checkpoint';

async function writeJson(p: string, obj: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj), 'utf8');
}

describe('detectDirtyShutdown()', () => {
  it('returns null when no dirty.flag is present', async () => {
    await clearSession();
    const r = await detectDirtyShutdown();
    expect(r).toBeNull();
  });

  it('returns a parsed snapshot when dirty.flag + session.json exist', async () => {
    await writeJson(CheckpointPaths.dirty(),   { pid: 1, startedAt: 1, appVersion: '1.0.0' });
    await writeJson(CheckpointPaths.session(), {
      version:    CHECKPOINT_VERSION,
      savedAt:    1_700_000_000,
      appVersion: '1.0.0',
      windows:    [{ kind: 'dashboard', bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, focused: true, ui: {}, unsaved: {} }],
    });
    const r = await detectDirtyShutdown();
    expect(r?.source).toBe('current');
    expect(r?.session.windows).toHaveLength(1);
  });

  it('returns null when session has unrecognised version', async () => {
    await writeJson(CheckpointPaths.dirty(),   { pid: 1, startedAt: 1, appVersion: '1.0.0' });
    await writeJson(CheckpointPaths.session(), {
      version:    999,                           // not CHECKPOINT_VERSION
      savedAt:    1,
      appVersion: '1.0.0',
      windows:    [],
    });
    const r = await detectDirtyShutdown();
    expect(r).toBeNull();
  });
});
