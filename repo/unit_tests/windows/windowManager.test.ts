import { beforeEach, describe, expect, it, vi } from 'vitest';

/* =========================================================================
 *  WindowManager — multi-window lifecycle, single-instance enforcement,
 *  creation hooks, high-DPI defaults, hardened webPreferences, external
 *  navigation blocking, broadcast, kindOf reverse-lookup.
 * ========================================================================= */

// ── Electron stubs ──────────────────────────────────────────────────────
// vi.mock is hoisted above every top-level const/function declaration, so
// the spies + factory have to live inside a vi.hoisted() block (otherwise
// the mock factory sees `makeBW` etc. as uninitialised and fails with the
// opaque "error when mocking a module" message).
const h = vi.hoisted(() => {
  const webContentsSend = vi.fn();
  const setWindowOpenHandler = vi.fn();
  const willNavigateListeners: Function[] = [];
  const closedListeners:       Function[] = [];
  const readyToShowListeners:  Function[] = [];
  const appendSwitchSpy = vi.fn();
  const state = { capturedOpts: {} as any };

  function makeBW(opts: any) {
    state.capturedOpts = opts;
    const self: any = {
      _opts: opts,
      isDestroyed: vi.fn().mockReturnValue(false),
      isMinimized: vi.fn().mockReturnValue(false),
      isFocused:   vi.fn().mockReturnValue(false),
      isMaximized: vi.fn().mockReturnValue(false),
      show: vi.fn(),
      hide: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
      restore: vi.fn(),
      maximize: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: opts.width, height: opts.height }),
      loadURL:  vi.fn().mockResolvedValue(undefined),
      loadFile: vi.fn().mockResolvedValue(undefined),
      webContents: {
        send: webContentsSend,
        setWindowOpenHandler,
        on: vi.fn((ev: string, fn: Function) => {
          if (ev === 'will-navigate') willNavigateListeners.push(fn);
        }),
      },
      on: vi.fn((ev: string, fn: Function) => {
        if (ev === 'closed') closedListeners.push(fn);
      }),
      once: vi.fn((ev: string, fn: Function) => {
        if (ev === 'ready-to-show') readyToShowListeners.push(fn);
      }),
    };
    return self;
  }

  return {
    webContentsSend, setWindowOpenHandler,
    willNavigateListeners, closedListeners, readyToShowListeners,
    appendSwitchSpy, makeBW, state,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(
    vi.fn().mockImplementation((opts: any) => h.makeBW(opts)),
    { getFocusedWindow: vi.fn().mockReturnValue(null) },
  ),
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1.5,
    }),
  },
  app: {
    commandLine: { appendSwitch: h.appendSwitchSpy },
  },
}));

// Back-compat aliases so the assertions further down can keep their prior names.
const { webContentsSend, setWindowOpenHandler, willNavigateListeners,
        closedListeners, readyToShowListeners, appendSwitchSpy } = h;
// `capturedOpts` is reassigned every time BrowserWindow() is called, so
// proxy property reads through to the hoisted state so old-style tests
// that do `expect(capturedOpts.title).toBe(...)` keep observing the most
// recently-captured value.
const capturedOpts: any = new Proxy({}, {
  get: (_t, key) => (h.state.capturedOpts as any)[key as string],
});

import { windowManager, enableHighDpi, type WindowKind } from '../../src/main/windows/WindowManager';

describe('WindowManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    willNavigateListeners.length = 0;
    closedListeners.length = 0;
    readyToShowListeners.length = 0;
    webContentsSend.mockClear();
    // close all tracked windows so the singleton resets
    windowManager.closeAll();
  });

  describe('open()', () => {
    it('creates a BrowserWindow with correct title and webPreferences', () => {
      const win = windowManager.open('dashboard');
      expect(capturedOpts.title).toBe('LeaseHub — Dashboard');
      expect(capturedOpts.webPreferences.contextIsolation).toBe(true);
      expect(capturedOpts.webPreferences.nodeIntegration).toBe(false);
      expect(capturedOpts.webPreferences.sandbox).toBe(true);
      expect(capturedOpts.webPreferences.backgroundThrottling).toBe(false);
    });

    it('passes --lh-window and --lh-scale in additionalArguments', () => {
      windowManager.open('contracts');
      const args = capturedOpts.webPreferences.additionalArguments;
      expect(args).toContain('--lh-window=contracts');
      expect(args).toContain('--lh-scale=1.5');
    });

    it('enforces minWidth=1024 and minHeight=720', () => {
      windowManager.open('audit');
      expect(capturedOpts.minWidth).toBe(1024);
      expect(capturedOpts.minHeight).toBe(720);
    });

    it('clamps default size to 95% of work area', () => {
      // dashboard default is 1600×960, workArea is 1920×1080
      windowManager.open('dashboard');
      expect(capturedOpts.width).toBe(Math.min(1600, Math.floor(1920 * 0.95)));
      expect(capturedOpts.height).toBe(Math.min(960, Math.floor(1080 * 0.95)));
    });

    it('uses custom bounds from init', () => {
      windowManager.open('audit', { bounds: { x: 100, y: 200, width: 500, height: 400 } });
      expect(capturedOpts.x).toBe(100);
      expect(capturedOpts.y).toBe(200);
      expect(capturedOpts.width).toBe(500);
      expect(capturedOpts.height).toBe(400);
    });

    it('re-focuses existing window instead of creating a second one', async () => {
      const { BrowserWindow } = await import('electron');
      const BW = vi.mocked(BrowserWindow) as unknown as { mock: { calls: unknown[] } };
      const win1 = windowManager.open('dashboard');
      const callCount1 = BW.mock.calls.length;
      const win2 = windowManager.open('dashboard');
      expect(BW.mock.calls.length).toBe(callCount1);
      expect(win1).toBe(win2);
      expect(win1.show).toHaveBeenCalled();
      expect(win1.focus).toHaveBeenCalled();
    });

    it('restores minimised windows on re-open', () => {
      const win = windowManager.open('dashboard');
      win.isMinimized.mockReturnValue(true);
      windowManager.open('dashboard');
      expect(win.restore).toHaveBeenCalled();
    });

    it('does not steal focus when init.focus=false', () => {
      const win = windowManager.open('contracts');
      win.focus.mockClear();
      win.show.mockClear();
      windowManager.open('contracts', { focus: false });
      expect(win.focus).not.toHaveBeenCalled();
    });
  });

  describe('creation hooks', () => {
    it('fires hooks with (win, kind) after the window is registered', () => {
      const hook = vi.fn();
      const unsub = windowManager.onWindowCreated(hook);
      const win = windowManager.open('audit');
      expect(hook).toHaveBeenCalledWith(win, 'audit');
      // The window should already be in the map when the hook fires
      expect(windowManager.get('audit')).toBe(win);
      unsub();
    });

    it('unsubscribe removes the hook for subsequent opens', () => {
      const hook = vi.fn();
      const unsub = windowManager.onWindowCreated(hook);
      unsub();
      windowManager.open('audit');
      expect(hook).not.toHaveBeenCalled();
    });
  });

  describe('get/all/kindOf', () => {
    it('get() returns undefined for unopened kinds', () => {
      expect(windowManager.get('audit')).toBeUndefined();
    });

    it('all() returns only alive windows', () => {
      const d = windowManager.open('dashboard');
      const c = windowManager.open('contracts');
      expect(windowManager.all()).toEqual([d, c]);
    });

    it('kindOf() returns the kind for a known window', () => {
      const win = windowManager.open('contracts');
      expect(windowManager.kindOf(win)).toBe('contracts');
    });

    it('kindOf() returns null for unknown windows', () => {
      expect(windowManager.kindOf({} as any)).toBeNull();
    });
  });

  describe('broadcast()', () => {
    it('sends to all open windows', () => {
      windowManager.open('dashboard');
      windowManager.open('contracts');
      windowManager.broadcast('test:event', { foo: 1 });
      expect(webContentsSend).toHaveBeenCalledTimes(2);
      expect(webContentsSend).toHaveBeenCalledWith('test:event', { foo: 1 });
    });
  });

  describe('hardening', () => {
    it('setWindowOpenHandler denies popup windows', () => {
      windowManager.open('dashboard');
      expect(setWindowOpenHandler).toHaveBeenCalled();
      const handler = setWindowOpenHandler.mock.calls[0][0];
      expect(handler()).toEqual({ action: 'deny' });
    });

    it('will-navigate blocks external URLs', () => {
      windowManager.open('dashboard');
      expect(willNavigateListeners.length).toBe(1);
      const event = { preventDefault: vi.fn() };
      willNavigateListeners[0](event, 'https://evil.com');
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('will-navigate allows file:// URLs', () => {
      windowManager.open('dashboard');
      const event = { preventDefault: vi.fn() };
      willNavigateListeners[0](event, 'file:///app/index.html');
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('closed lifecycle', () => {
    it('removes the window from the map on closed event', () => {
      windowManager.open('audit');
      expect(windowManager.get('audit')).toBeDefined();
      closedListeners[0]();
      expect(windowManager.get('audit')).toBeUndefined();
    });
  });
});

describe('enableHighDpi()', () => {
  it('sets high-dpi-support and force-device-scale-factor switches', () => {
    enableHighDpi();
    expect(appendSwitchSpy).toHaveBeenCalledWith('high-dpi-support', '1');
    expect(appendSwitchSpy).toHaveBeenCalledWith('force-device-scale-factor', '1');
  });
});
