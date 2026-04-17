import { beforeEach, describe, expect, it, vi } from 'vitest';

/* =========================================================================
 *  ShortcutManager — registration, dispatch, menu items, duplicate guard.
 *  Electron is stubbed so no native window/menu layer is needed.
 * ========================================================================= */

vi.mock('electron', () => ({
  BrowserWindow:   { getFocusedWindow: () => null },
  globalShortcut:  {
    register:   vi.fn().mockReturnValue(true),
    unregister: vi.fn(),
  },
}));

import { shortcutManager } from '../../src/main/shortcuts/ShortcutManager';

describe('ShortcutManager', () => {
  beforeEach(() => {
    // Flush any leftover registrations from previous test files.
    for (const s of shortcutManager.list()) shortcutManager.unregister(s.id);
  });

  it('register adds a definition discoverable by id', () => {
    shortcutManager.register({
      id: 'x', label: 'Do X', accelerator: 'Ctrl+X', group: 'file',
      handler: () => {},
    });
    expect(shortcutManager.get('x')?.label).toBe('Do X');
  });

  it('register ignores duplicate ids (logs instead of throwing)', () => {
    shortcutManager.register({ id: 'x', label: 'A', accelerator: 'Ctrl+X', group: 'file', handler: () => {} });
    shortcutManager.register({ id: 'x', label: 'B', accelerator: 'Ctrl+X', group: 'file', handler: () => {} });
    expect(shortcutManager.get('x')?.label).toBe('A');
  });

  it('dispatch runs the registered handler', async () => {
    const fn = vi.fn();
    shortcutManager.register({ id: 'y', label: 'Y', accelerator: 'Ctrl+Y', group: 'file', handler: fn });
    await shortcutManager.dispatch('y');
    expect(fn).toHaveBeenCalled();
  });

  it('asMenuItems filters by group and respects visibleInMenu', () => {
    shortcutManager.register({ id: 'a', label: 'A', accelerator: 'Ctrl+A', group: 'file', handler: () => {} });
    shortcutManager.register({ id: 'b', label: 'B', accelerator: 'Ctrl+B', group: 'file', handler: () => {}, visibleInMenu: false });
    shortcutManager.register({ id: 'c', label: 'C', accelerator: 'Ctrl+C', group: 'view', handler: () => {} });
    const items = shortcutManager.asMenuItems('file');
    expect(items.map((x) => x.label)).toEqual(['A']);
  });
});
