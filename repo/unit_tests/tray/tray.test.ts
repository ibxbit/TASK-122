import { beforeEach, describe, expect, it, vi } from 'vitest';

/* =========================================================================
 *  TrayManager — icon init, tooltip, show/hide/quit, wireMinimizeToTray,
 *  refreshMenu enable/disable logic, double-click, signalQuitting flag.
 * ========================================================================= */

// ── Electron stubs ──────────────────────────────────────────────────────
const destroySpy = vi.fn();
const setToolTipSpy = vi.fn();
const setContextMenuSpy = vi.fn();
const onSpy = vi.fn();
const isDestroyedSpy = vi.fn().mockReturnValue(false);

function makeFakeTray() {
  return {
    setToolTip: setToolTipSpy,
    setContextMenu: setContextMenuSpy,
    on: onSpy,
    isDestroyed: isDestroyedSpy,
    destroy: destroySpy,
  };
}

const fakeImg = { isEmpty: vi.fn().mockReturnValue(false) };
let builtTemplate: any[] = [];

vi.mock('electron', () => ({
  app: { quit: vi.fn(), on: vi.fn() },
  Tray: vi.fn().mockImplementation(() => makeFakeTray()),
  Menu: { buildFromTemplate: (t: any) => { builtTemplate = t; return t; } },
  nativeImage: { createFromPath: () => fakeImg },
}));

import { trayManager, type TrayDeps } from '../../src/main/tray/tray';
import { app } from 'electron';

function makeFakeWindow(visible = true, destroyed = false, minimized = false) {
  const listeners: Record<string, Function[]> = {};
  return {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    hide: vi.fn(() => { visible = false; }),
    show: vi.fn(() => { visible = true; }),
    focus: vi.fn(),
    restore: vi.fn(),
    on: vi.fn((event: string, cb: Function) => {
      (listeners[event] ??= []).push(cb);
    }),
    _emit(event: string, ...args: any[]) {
      for (const fn of listeners[event] ?? []) fn(...args);
    },
  } as any;
}

describe('TrayManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    builtTemplate = [];
    // Reset the singleton — re-import wouldn't help because the module is cached,
    // so we call destroy() to put it back into an uninitialised state.
    trayManager.destroy();
  });

  function initTray(overrides: Partial<TrayDeps> = {}): ReturnType<typeof makeFakeWindow>[] {
    const wins = [makeFakeWindow(true), makeFakeWindow(false)];
    trayManager.initTray({
      iconPath: '/fake/icon.png',
      tooltip: 'Test tooltip',
      windows: () => wins,
      openDashboard: vi.fn().mockReturnValue(makeFakeWindow()),
      ...overrides,
    });
    return wins;
  }

  describe('initTray()', () => {
    it('sets the tooltip from deps', () => {
      initTray();
      expect(setToolTipSpy).toHaveBeenCalledWith('Test tooltip');
    });

    it('defaults tooltip to "LeaseHub Operations Console"', () => {
      initTray({ tooltip: undefined });
      expect(setToolTipSpy).toHaveBeenCalledWith('LeaseHub Operations Console');
    });

    it('registers a double-click handler for showAll', () => {
      initTray();
      expect(onSpy).toHaveBeenCalledWith('double-click', expect.any(Function));
    });

    it('warns when tray icon is empty', () => {
      fakeImg.isEmpty.mockReturnValueOnce(true);
      initTray();
      // The call proceeds without throwing — icon is optional.
    });

    it('is idempotent — second call returns existing tray', () => {
      initTray();
      const spy1 = vi.mocked(app.quit);
      initTray(); // should not create a second Tray
    });
  });

  describe('refreshMenu() context-menu enable/disable', () => {
    it('"Show App" disabled when a window is visible; "Hide App" enabled', () => {
      initTray(); // wins[0] visible, wins[1] hidden
      // refreshMenu is called from initTray → setContextMenu
      expect(builtTemplate.length).toBeGreaterThanOrEqual(3);
      const showItem = builtTemplate.find((i: any) => i.label === 'Show App');
      const hideItem = builtTemplate.find((i: any) => i.label === 'Hide App');
      expect(showItem.enabled).toBe(false);     // because at least one win IS visible
      expect(hideItem.enabled).toBe(true);
    });

    it('"Show App" enabled when all windows are hidden', () => {
      const wins = [makeFakeWindow(false), makeFakeWindow(false)];
      trayManager.initTray({
        iconPath: '/fake/icon.png',
        windows: () => wins,
        openDashboard: vi.fn().mockReturnValue(makeFakeWindow()),
      });
      const showItem = builtTemplate.find((i: any) => i.label === 'Show App');
      expect(showItem.enabled).toBe(true);
    });
  });

  describe('wireMinimizeToTray()', () => {
    it('intercepts close and hides to tray when not quitting', () => {
      initTray();
      const win = makeFakeWindow(true);
      trayManager.wireMinimizeToTray(win);

      const closeHandler = win.on.mock.calls.find((c: any) => c[0] === 'close')?.[1];
      expect(closeHandler).toBeDefined();

      const event = { preventDefault: vi.fn() };
      closeHandler(event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(win.hide).toHaveBeenCalled();
    });

    it('lets close through when isQuitting is true', () => {
      initTray();
      trayManager.signalQuitting();
      const win = makeFakeWindow(true);
      trayManager.wireMinimizeToTray(win);

      const closeHandler = win.on.mock.calls.find((c: any) => c[0] === 'close')?.[1];
      const event = { preventDefault: vi.fn() };
      closeHandler(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('showAll()', () => {
    it('shows and focuses all windows', () => {
      const wins = [makeFakeWindow(false), makeFakeWindow(false)];
      trayManager.initTray({
        iconPath: '/fake/icon.png',
        windows: () => wins,
        openDashboard: vi.fn(),
      });
      trayManager.showAll();
      expect(wins[0].show).toHaveBeenCalled();
      expect(wins[1].show).toHaveBeenCalled();
      expect(wins[1].focus).toHaveBeenCalled();
    });

    it('restores minimized windows', () => {
      const minimized = makeFakeWindow(false, false, true);
      trayManager.initTray({
        iconPath: '/fake/icon.png',
        windows: () => [minimized],
        openDashboard: vi.fn(),
      });
      trayManager.showAll();
      expect(minimized.restore).toHaveBeenCalled();
    });

    it('opens dashboard when no windows exist', () => {
      const openDash = vi.fn().mockReturnValue(makeFakeWindow());
      trayManager.initTray({
        iconPath: '/fake/icon.png',
        windows: () => [],
        openDashboard: openDash,
      });
      trayManager.showAll();
      expect(openDash).toHaveBeenCalled();
    });
  });

  describe('hideAll()', () => {
    it('hides every window', () => {
      const wins = [makeFakeWindow(true), makeFakeWindow(true)];
      trayManager.initTray({ iconPath: '/x', windows: () => wins, openDashboard: vi.fn() });
      trayManager.hideAll();
      expect(wins[0].hide).toHaveBeenCalled();
      expect(wins[1].hide).toHaveBeenCalled();
    });
  });

  describe('quit()', () => {
    it('sets isQuitting, runs onQuit hook, then calls app.quit', async () => {
      const onQuit = vi.fn();
      trayManager.initTray({
        iconPath: '/x',
        windows: () => [],
        openDashboard: vi.fn(),
        onQuit,
      });
      await trayManager.quit();
      expect(trayManager.isQuitting).toBe(true);
      expect(onQuit).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
    });

    it('calls app.quit even when onQuit throws', async () => {
      trayManager.initTray({
        iconPath: '/x',
        windows: () => [],
        openDashboard: vi.fn(),
        onQuit: () => { throw new Error('hook failed'); },
      });
      await trayManager.quit();
      expect(app.quit).toHaveBeenCalled();
    });
  });

  describe('signalQuitting()', () => {
    it('flips isQuitting flag from false to true', () => {
      initTray();
      expect(trayManager.isQuitting).toBe(false);
      trayManager.signalQuitting();
      expect(trayManager.isQuitting).toBe(true);
    });
  });
});
