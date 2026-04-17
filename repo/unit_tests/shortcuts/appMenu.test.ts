import { beforeEach, describe, expect, it, vi } from 'vitest';

/* =========================================================================
 *  AppMenu — DEFAULT_SHORTCUTS declarations, buildAppMenu integration,
 *  Ctrl+K / Ctrl+E broadcast, Ctrl+Shift+L opens audit, menu structure.
 * ========================================================================= */

const openMock = vi.fn();
const focusedSendMock = vi.fn();
const focusedWindow = {
  webContents: { send: focusedSendMock },
  isDestroyed: () => false,
};

let setApplicationMenuTemplate: any = null;

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => focusedWindow },
  Menu: {
    buildFromTemplate: (t: any) => { setApplicationMenuTemplate = t; return t; },
    setApplicationMenu: vi.fn(),
  },
  globalShortcut: {
    register: vi.fn().mockReturnValue(true),
    unregister: vi.fn(),
  },
}));

vi.mock('../../src/main/windows/WindowManager', () => ({
  windowManager: { open: openMock },
}));

import { shortcutManager } from '../../src/main/shortcuts/ShortcutManager';
import { DEFAULT_SHORTCUTS, buildAppMenu } from '../../src/main/shortcuts/AppMenu';

describe('DEFAULT_SHORTCUTS', () => {
  it('declares exactly three shortcuts: search, export, audit', () => {
    expect(DEFAULT_SHORTCUTS.map(s => s.id).sort()).toEqual(['audit', 'export', 'search']);
  });

  it('search uses Ctrl+K', () => {
    expect(DEFAULT_SHORTCUTS.find(s => s.id === 'search')!.accelerator).toBe('Ctrl+K');
  });

  it('export uses Ctrl+E', () => {
    expect(DEFAULT_SHORTCUTS.find(s => s.id === 'export')!.accelerator).toBe('Ctrl+E');
  });

  it('audit uses Ctrl+Shift+L', () => {
    expect(DEFAULT_SHORTCUTS.find(s => s.id === 'audit')!.accelerator).toBe('Ctrl+Shift+L');
  });
});

describe('buildAppMenu()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset ShortcutManager state
    for (const s of shortcutManager.list()) shortcutManager.unregister(s.id);
    buildAppMenu();
  });

  it('registers all DEFAULT_SHORTCUTS in the ShortcutManager', () => {
    for (const def of DEFAULT_SHORTCUTS) {
      expect(shortcutManager.get(def.id)).toBeDefined();
    }
  });

  it('builds a menu with File, Go, View submenus', () => {
    expect(setApplicationMenuTemplate).toBeDefined();
    const labels = setApplicationMenuTemplate.map((s: any) => s.label);
    expect(labels).toEqual(['File', 'Go', 'View']);
  });

  it('Ctrl+K dispatches shortcut:search to focused window', async () => {
    await shortcutManager.dispatch('search');
    expect(focusedSendMock).toHaveBeenCalledWith('shortcut:search', undefined);
  });

  it('Ctrl+E dispatches shortcut:export to focused window', async () => {
    await shortcutManager.dispatch('export');
    expect(focusedSendMock).toHaveBeenCalledWith('shortcut:export', undefined);
  });

  it('Ctrl+Shift+L opens the audit window via windowManager', async () => {
    await shortcutManager.dispatch('audit');
    expect(openMock).toHaveBeenCalledWith('audit');
  });

  it('Go submenu includes Dashboard and Contract Workspace entries', () => {
    const goMenu = setApplicationMenuTemplate.find((s: any) => s.label === 'Go');
    const labels = goMenu.submenu.map((i: any) => i.label).filter(Boolean);
    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Contract Workspace');
  });

  it('File submenu includes Export shortcut', () => {
    const fileMenu = setApplicationMenuTemplate.find((s: any) => s.label === 'File');
    const labels = fileMenu.submenu.map((i: any) => i.label).filter(Boolean);
    expect(labels).toContain('Export…');
  });

  it('View submenu includes zoom roles', () => {
    const viewMenu = setApplicationMenuTemplate.find((s: any) => s.label === 'View');
    const roles = viewMenu.submenu.map((i: any) => i.role).filter(Boolean);
    expect(roles).toContain('zoomIn');
    expect(roles).toContain('zoomOut');
    expect(roles).toContain('resetZoom');
    expect(roles).toContain('togglefullscreen');
  });
});
