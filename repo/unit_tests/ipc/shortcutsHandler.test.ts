import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';

/* =========================================================================
 * shortcuts:{list,set,clear,reset} handler — real execution path.
 *
 *  Exercises the whole surface end-to-end against a real on-disk
 *  shortcuts.json.  ipcMain.handle is captured so we drive each channel
 *  through the registered function.  Electron BrowserWindow + Menu +
 *  globalShortcut are stubbed minimally so the underlying AppMenu /
 *  ShortcutManager code runs for real (including the clear-and-re-
 *  register path inside buildAppMenu).
 * ========================================================================= */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

let tmpUserData = '';
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, payload: unknown) => unknown) =>
      handlers.set(ch, fn),
  },
  app:            { getPath: () => tmpUserData, getVersion: () => '1.0.0' },
  BrowserWindow:  { getFocusedWindow: () => null, fromWebContents: () => null },
  Menu:           { setApplicationMenu: vi.fn(), buildFromTemplate: (t: unknown) => t },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
}));
vi.mock('../../src/main/windows/WindowManager', () => ({
  windowManager: { open: vi.fn() },
}));

import { makeTestDb, seedAccessGraph } from '../_helpers/db';
import { initDbLifecycle } from '../../src/main/db/cleanup';
import { setSession, clearAllSessions } from '../../src/main/session';
import { registerShortcutsHandlers } from '../../src/main/ipc/shortcuts.handler';

function invoke(channel: string, senderId: number, payload: unknown = {}): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no_handler_for:${channel}`);
  return fn({ sender: { id: senderId } }, payload);
}

describe('shortcuts handler — real execution path', () => {
  let db: ReturnType<typeof makeTestDb>;

  beforeEach(() => {
    tmpUserData = mkdtempSync(path.join(os.tmpdir(), 'lh-shcfg-'));
    db = makeTestDb();
    const ids = seedAccessGraph(db);
    try { initDbLifecycle({ db }); } catch { /* already initialised */ }

    handlers.clear();
    clearAllSessions();
    registerShortcutsHandlers();

    // A TenantAdmin session — so chain-audit emits with a valid tenant.
    setSession(17, {
      userId: ids.adminUserId, tenantId: ids.tenantId,
      roles: ['TenantAdmin'], loggedInAt: 0,
    });
  });

  afterEach(() => {
    clearAllSessions();
    db.close();
    try { rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* noop */ }
    handlers.clear();
  });

  it('registers all four channels', () => {
    for (const ch of ['shortcuts:list', 'shortcuts:set', 'shortcuts:clear', 'shortcuts:reset']) {
      expect(handlers.has(ch), `missing ${ch}`).toBe(true);
    }
  });

  it('shortcuts:list returns the defaults with overridden=false before any change', async () => {
    const r = await invoke('shortcuts:list', 17) as {
      defaults:  Array<{ id: string; accelerator: string }>;
      effective: Array<{ id: string; accelerator: string; overridden: boolean }>;
    };
    const ids = r.defaults.map((d) => d.id).sort();
    expect(ids).toEqual(['audit', 'export', 'search']);
    expect(r.effective.every((e) => e.overridden === false)).toBe(true);
  });

  it('shortcuts:set writes the config file and the next :list reflects the override', async () => {
    const set = await invoke('shortcuts:set', 17, {
      id: 'search', accelerator: 'Ctrl+Shift+F',
    }) as { ok: boolean };
    expect(set.ok).toBe(true);

    // File on disk contains the override
    const saved = JSON.parse(await fs.readFile(path.join(tmpUserData, 'shortcuts.json'), 'utf8'));
    expect(saved).toEqual({ version: 1, overrides: { search: 'Ctrl+Shift+F' } });

    // :list shows the effective value + overridden flag
    const list = await invoke('shortcuts:list', 17) as {
      effective: Array<{ id: string; accelerator: string; overridden: boolean }>;
    };
    const search = list.effective.find((e) => e.id === 'search')!;
    expect(search.accelerator).toBe('Ctrl+Shift+F');
    expect(search.overridden).toBe(true);

    // Chain audit emitted
    const ae = db.prepare(
      `SELECT payload FROM audit_events WHERE action = 'shortcuts.override_set'`,
    ).get() as { payload: string } | undefined;
    expect(ae).toBeDefined();
    expect(JSON.parse(ae!.payload)).toMatchObject({ id: 'search', accelerator: 'Ctrl+Shift+F' });
  });

  it('shortcuts:set rejects a conflicting accelerator and does NOT write the file', async () => {
    // Ctrl+E already belongs to `export` — assigning it to `search` conflicts.
    const r = await invoke('shortcuts:set', 17, {
      id: 'search', accelerator: 'Ctrl+E',
    }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/accelerator_conflict/);

    // No file written
    await expect(fs.access(path.join(tmpUserData, 'shortcuts.json')))
      .rejects.toThrow();
  });

  it('shortcuts:set rejects an unknown shortcut id', async () => {
    const r = await invoke('shortcuts:set', 17, {
      id: 'not-a-real-shortcut', accelerator: 'Ctrl+F2',
    }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown_shortcut_id/);
  });

  it('shortcuts:clear removes a single override', async () => {
    await invoke('shortcuts:set', 17, { id: 'search', accelerator: 'Ctrl+Shift+F' });
    const clear = await invoke('shortcuts:clear', 17, { id: 'search' }) as { ok: boolean };
    expect(clear.ok).toBe(true);

    const saved = JSON.parse(await fs.readFile(path.join(tmpUserData, 'shortcuts.json'), 'utf8'));
    expect(saved).toEqual({ version: 1, overrides: {} });

    const ae = db.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'shortcuts.override_cleared'`,
    ).get() as { n: number };
    expect(ae.n).toBe(1);
  });

  it('shortcuts:reset drops every override', async () => {
    await invoke('shortcuts:set', 17, { id: 'search', accelerator: 'Ctrl+Shift+F' });
    await invoke('shortcuts:set', 17, { id: 'export', accelerator: 'Ctrl+Alt+E' });

    const reset = await invoke('shortcuts:reset', 17, {}) as { ok: boolean };
    expect(reset.ok).toBe(true);

    const saved = JSON.parse(await fs.readFile(path.join(tmpUserData, 'shortcuts.json'), 'utf8'));
    expect(saved).toEqual({ version: 1, overrides: {} });

    const ae = db.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'shortcuts.reset'`,
    ).get() as { n: number };
    expect(ae.n).toBe(1);
  });

  it('shortcuts:set works without a session (no audit row written, not a crash)', async () => {
    clearAllSessions();
    const r = await invoke('shortcuts:set', 999, {
      id: 'audit', accelerator: 'Ctrl+Alt+Shift+L',
    }) as { ok: boolean };
    expect(r.ok).toBe(true);

    const ae = db.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'shortcuts.override_set'`,
    ).get() as { n: number };
    // No session → the handler must not write a chain-audit row under a
    // bogus tenant.  This prevents an unauthenticated IPC caller from
    // growing the audit chain.
    expect(ae.n).toBe(0);
  });
});
