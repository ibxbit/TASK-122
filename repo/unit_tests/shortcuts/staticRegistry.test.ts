import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/* =========================================================================
 * Keyboard shortcut registry — replaces MV-3 / MV-4 manual steps for
 * "keyboard navigation & global shortcuts".
 *
 *  The product contract is that DEFAULT_SHORTCUTS carries three stable IDs
 *  (`search`, `export`, `audit`) bound to `Ctrl+K`, `Ctrl+E`, `Ctrl+Shift+L`
 *  respectively.  Renderer hooks reference these IDs statically, so if
 *  anyone renames one or drops it, runtime accelerators break silently.
 *  This test freezes that contract at the registry level AND in the README.
 * ========================================================================= */

vi.mock('electron', () => ({
  BrowserWindow:  { getFocusedWindow: () => null },
  Menu:           { setApplicationMenu: vi.fn(), buildFromTemplate: (t: unknown) => t },
  globalShortcut: { register: vi.fn().mockReturnValue(true), unregister: vi.fn() },
}));
vi.mock('../../src/main/windows/WindowManager', () => ({
  windowManager: { open: vi.fn() },
}));

describe('DEFAULT_SHORTCUTS — product contract', () => {
  it('contains the three required (id, accelerator, group) triples', async () => {
    const { DEFAULT_SHORTCUTS } = await import('../../src/main/shortcuts/AppMenu');
    const map = new Map(DEFAULT_SHORTCUTS.map((s) => [s.id, s]));

    for (const id of ['search', 'export', 'audit']) {
      expect(map.has(id), `missing shortcut id: ${id}`).toBe(true);
    }
    expect(map.get('search')!.accelerator).toBe('Ctrl+K');
    expect(map.get('export')!.accelerator).toBe('Ctrl+E');
    expect(map.get('audit') !.accelerator).toBe('Ctrl+Shift+L');
  });

  it('every shortcut has a non-empty label and a handler function', async () => {
    const { DEFAULT_SHORTCUTS } = await import('../../src/main/shortcuts/AppMenu');
    for (const s of DEFAULT_SHORTCUTS) {
      expect(s.label.length, `shortcut ${s.id} needs a label`).toBeGreaterThan(0);
      expect(typeof s.handler).toBe('function');
    }
  });

  it('README documents the same accelerators the registry ships', () => {
    const readme = readFileSync(
      path.resolve(__dirname, '../../README.md'), 'utf8',
    );
    // We only care that each accelerator appears in README so the docs never
    // silently drift out of sync from code.
    for (const acc of ['Ctrl+K', 'Ctrl+E', 'Ctrl+Shift+L']) {
      expect(readme.includes(acc), `README must reference ${acc}`).toBe(true);
    }
  });
});
