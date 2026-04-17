import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';

/* =========================================================================
 * Shortcut-config — persistence, conflict detection, reset.
 * ========================================================================= */

let tmp = '';
vi.mock('electron', () => ({
  app: { getPath: () => tmp },
}));

import {
  loadShortcutConfig, saveShortcutConfig, applyOverrides,
  setOverride, clearOverride, resetConfig, normaliseAccelerator,
  ShortcutConfigError, type ShortcutConfig,
} from '../../src/main/shortcuts/config';

const DEFAULTS = [
  { id: 'search', accelerator: 'Ctrl+K' },
  { id: 'export', accelerator: 'Ctrl+E' },
  { id: 'audit',  accelerator: 'Ctrl+Shift+L' },
];

beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), 'lh-sc-')); });
afterEach(()  => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

describe('loadShortcutConfig', () => {
  it('returns an empty config when the file does not exist', async () => {
    const c = await loadShortcutConfig();
    expect(c).toEqual({ version: 1, overrides: {} });
  });

  it('round-trips a saved config', async () => {
    const cfg: ShortcutConfig = { version: 1, overrides: { search: 'Ctrl+Shift+F' } };
    await saveShortcutConfig(cfg);
    const loaded = await loadShortcutConfig();
    expect(loaded).toEqual(cfg);
  });

  it('ignores a malformed JSON file, returning defaults', async () => {
    const p = path.join(tmp, 'shortcuts.json');
    await fs.writeFile(p, '{not valid json', 'utf8');
    const loaded = await loadShortcutConfig();
    expect(loaded.overrides).toEqual({});
  });

  it('drops unknown keys / wrong versions silently', async () => {
    const p = path.join(tmp, 'shortcuts.json');
    await fs.writeFile(p, JSON.stringify({ version: 42, overrides: { search: 42 } }), 'utf8');
    const loaded = await loadShortcutConfig();
    expect(loaded).toEqual({ version: 1, overrides: {} });
  });
});

describe('applyOverrides', () => {
  it('returns defaults with overridden=false when no config supplied', () => {
    const r = applyOverrides(DEFAULTS, { version: 1, overrides: {} });
    expect(r.map((e) => e.accelerator)).toEqual(['Ctrl+K','Ctrl+E','Ctrl+Shift+L']);
    expect(r.every((e) => e.overridden === false)).toBe(true);
  });

  it('applies a user override and marks overridden=true', () => {
    const r = applyOverrides(DEFAULTS, { version: 1, overrides: { search: 'Ctrl+Shift+F' } });
    expect(r[0]).toMatchObject({ id: 'search', accelerator: 'Ctrl+Shift+F', overridden: true });
    expect(r[1].overridden).toBe(false);
  });

  it('throws on unknown shortcut id', () => {
    expect(() => applyOverrides(DEFAULTS, { version: 1, overrides: { ghost: 'F1' } }))
      .toThrow(/shortcut_config:unknown_shortcut_id/);
  });

  it('throws accelerator_conflict when two shortcuts resolve to the same combo', () => {
    expect(() => applyOverrides(DEFAULTS, {
      version: 1, overrides: { search: 'Ctrl+E' },  // collides with export
    })).toThrow(/shortcut_config:accelerator_conflict/);
  });

  it('conflict detector is case-insensitive and modifier-order-agnostic', () => {
    // Cmd == Ctrl, Shift+Ctrl == Ctrl+Shift
    expect(normaliseAccelerator('CmdOrCtrl+Shift+L')).toBe(normaliseAccelerator('Ctrl+Shift+L'));
    expect(normaliseAccelerator('Shift+Ctrl+L')).toBe(normaliseAccelerator('Ctrl+Shift+L'));
    expect(() => applyOverrides(DEFAULTS, {
      version: 1, overrides: { search: 'shift+ctrl+l' },  // dup of audit
    })).toThrow(/accelerator_conflict/);
  });
});

describe('setOverride / clearOverride / resetConfig', () => {
  it('setOverride returns a valid config and is validated eagerly', () => {
    const c = setOverride(DEFAULTS, { version: 1, overrides: {} }, 'search', 'Ctrl+Shift+F');
    expect(c.overrides.search).toBe('Ctrl+Shift+F');
  });

  it('setOverride rejects a conflicting accelerator', () => {
    expect(() => setOverride(DEFAULTS, { version: 1, overrides: {} }, 'search', 'Ctrl+E'))
      .toThrow(/accelerator_conflict/);
  });

  it('clearOverride removes a single entry; missing id is a no-op', () => {
    const c1 = { version: 1, overrides: { search: 'Ctrl+J' } } as ShortcutConfig;
    const c2 = clearOverride(c1, 'search');
    expect(c2.overrides).toEqual({});
    expect(clearOverride(c2, 'search')).toEqual(c2);
  });

  it('resetConfig returns the empty config shape', () => {
    expect(resetConfig()).toEqual({ version: 1, overrides: {} });
  });
});

describe('normaliseAccelerator', () => {
  it('Canonicalises to lowercase, sorted modifiers', () => {
    expect(normaliseAccelerator('Ctrl+Shift+L')).toBe('ctrl+shift+l');
    expect(normaliseAccelerator('Alt+Shift+K')).toBe('alt+shift+k');
  });
});
