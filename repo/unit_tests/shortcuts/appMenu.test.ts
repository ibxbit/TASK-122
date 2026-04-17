import { beforeEach, describe, expect, it, vi } from 'vitest';

/* =========================================================================
 *  AppMenu — DEFAULT_SHORTCUTS declarations, buildAppMenu integration,
 *  Ctrl+K / Ctrl+E broadcast, Ctrl+Shift+L opens audit, menu structure.
 * ========================================================================= */

// All module-mock factories are hoisted to the top of the file by Vitest,
// so anything they reference must be hoisted too — otherwise the factories
// run before the `const openMock = …` / `const focusedWindow = …`
// declarations execute, producing ReferenceError / opaque "error when
// mocking a module" messages.  Wrap shared state in vi.hoisted().
const mocks = vi.hoisted(() => {
  const focusedSendMock = vi.fn();
  return {
    openMock: vi.fn(),
    focusedSendMock,
    focusedWindow: {
      webContents: { send: focusedSendMock },
      isDestroyed: () => false,
    },
    menuState: { template: null as any },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => mocks.focusedWindow },
  Menu: {
    buildFromTemplate: (t: any) => { mocks.menuState.template = t; return t; },
    setApplicationMenu: vi.fn(),
  },
  globalShortcut: {
    register: vi.fn().mockReturnValue(true),
    unregister: vi.fn(),
  },
}));

vi.mock('../../src/main/windows/WindowManager', () => ({
  windowManager: { open: mocks.openMock },
}));

const { openMock, focusedSendMock, menuState } = mocks;

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
    expect(menuState.template).toBeDefined();
    const labels = menuState.template.map((s: any) => s.label);
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
    const goMenu = menuState.template.find((s: any) => s.label === 'Go');
    const labels = goMenu.submenu.map((i: any) => i.label).filter(Boolean);
    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Contract Workspace');
  });

  it('File submenu includes Export shortcut', () => {
    const fileMenu = menuState.template.find((s: any) => s.label === 'File');
    const labels = fileMenu.submenu.map((i: any) => i.label).filter(Boolean);
    expect(labels).toContain('Export…');
  });

  it('View submenu includes zoom roles', () => {
    const viewMenu = menuState.template.find((s: any) => s.label === 'View');
    const roles = viewMenu.submenu.map((i: any) => i.role).filter(Boolean);
    expect(roles).toContain('zoomIn');
    expect(roles).toContain('zoomOut');
    expect(roles).toContain('resetZoom');
    expect(roles).toContain('togglefullscreen');
  });
});
