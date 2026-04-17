import { BrowserWindow, screen, app } from 'electron';
import path from 'node:path';

/* =========================================================================
 * WindowManager
 *  - Three roles: dashboard | contracts | audit — each an independent
 *    BrowserWindow with its own webContents, lifecycle, and close event
 *  - Single-instance per role (open() re-focuses an existing window)
 *  - High-DPI aware (uses primary display scale factor for default sizing)
 *  - Hardened: sandbox, contextIsolation, external navigation denied
 *  - Integration hooks:
 *      open(kind, init?)       — init.bounds + init.maximized power the
 *                                 crash-recovery restore flow
 *      all()                   — live window list for tray + checkpoint
 *      kindOf(win)             — reverse lookup for checkpoint snapshot
 *      onWindowCreated(hook)   — per-new-window callback (tray hide-to-
 *                                 tray, perf tracking, etc.)
 * ========================================================================= */

export type WindowKind = 'dashboard' | 'contracts' | 'audit';

export interface WindowBounds {
  x:      number;
  y:      number;
  width:  number;
  height: number;
}

export interface WindowInit {
  bounds?:    WindowBounds;
  maximized?: boolean;
  focus?:     boolean;              // default true
}

export type WindowCreationHook = (win: BrowserWindow, kind: WindowKind) => void;

const TITLES: Record<WindowKind, string> = {
  dashboard: 'LeaseHub — Dashboard',
  contracts: 'LeaseHub — Contract Workspace',
  audit:     'LeaseHub — Audit Log Viewer',
};

const DEFAULT_SIZE: Record<WindowKind, { w: number; h: number }> = {
  dashboard: { w: 1600, h: 960 },
  contracts: { w: 1440, h: 900 },
  audit:     { w: 1200, h: 800 },
};

// Called ONCE before app.whenReady() — propagates to all renderer processes.
export function enableHighDpi(): void {
  app.commandLine.appendSwitch('high-dpi-support', '1');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
}

class WindowManager {
  private readonly wins          = new Map<WindowKind, BrowserWindow>();
  private readonly creationHooks = new Set<WindowCreationHook>();

  /**
   * Open (or re-focus) the window for a given kind.
   *   init.bounds     — restore window at saved position/size (crash recovery)
   *   init.maximized  — apply maximize on ready-to-show
   *   init.focus=false — do not steal focus from the current foreground window
   */
  open(kind: WindowKind, init?: WindowInit): BrowserWindow {
    const existing = this.wins.get(kind);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      if (init?.focus !== false) existing.focus();
      return existing;
    }

    const base = DEFAULT_SIZE[kind];
    const { workArea, scaleFactor } = screen.getPrimaryDisplay();
    // Clamp to the current work area so default windows stay usable on smaller displays.
    const width  = init?.bounds?.width  ?? Math.min(base.w, Math.floor(workArea.width  * 0.95));
    const height = init?.bounds?.height ?? Math.min(base.h, Math.floor(workArea.height * 0.95));
    const x      = init?.bounds?.x;
    const y      = init?.bounds?.y;

    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      minWidth:         1024,
      minHeight:        720,
      title:            TITLES[kind],
      backgroundColor:  '#0f172a',
      show:             false,
      useContentSize:   true,
      autoHideMenuBar:  false,
      webPreferences: {
        preload:              path.join(__dirname, '../../preload/index.js'),
        contextIsolation:     true,
        nodeIntegration:      false,
        sandbox:              true,
        spellcheck:           false,
        zoomFactor:           1.0,
        backgroundThrottling: false,    // scheduler/UI keep ticking when blurred
        additionalArguments:  [`--lh-window=${kind}`, `--lh-scale=${scaleFactor}`],
      },
    });

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      void win.loadURL(`${devUrl}?window=${kind}`);
    } else {
      void win.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'), {
        query: { window: kind },
      });
    }

    win.once('ready-to-show', () => {
      if (init?.maximized) win.maximize();
      win.show();
      if (init?.focus !== false) win.focus();
    });

    // Independent lifecycle — closing this window removes it from the map but
    // does not affect the other two windows.
    win.on('closed', () => this.wins.delete(kind));

    // Hardening — block all external navigation + popup windows.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      if (devUrl && url.startsWith(devUrl)) return;
      if (url.startsWith('file://')) return;
      e.preventDefault();
    });

    this.wins.set(kind, win);

    // Fire creation hooks AFTER the window is registered so hooks can call
    // back into the manager (e.g. trayManager.wireMinimizeToTray).
    for (const hook of this.creationHooks) {
      try { hook(win, kind); } catch (err) { console.error('window_creation_hook_failed', err); }
    }

    return win;
  }

  /** Get the window for a kind (or undefined if not open). */
  get(kind: WindowKind): BrowserWindow | undefined {
    const w = this.wins.get(kind);
    return w && !w.isDestroyed() ? w : undefined;
  }

  /** All currently-alive managed windows. */
  all(): BrowserWindow[] {
    return [...this.wins.values()].filter((w) => !w.isDestroyed());
  }

  /** Reverse lookup — returns the kind that owns `win`, or null. */
  kindOf(win: BrowserWindow): WindowKind | null {
    for (const [kind, w] of this.wins.entries()) {
      if (w === win) return kind;
    }
    return null;
  }

  focused(): BrowserWindow | null {
    return BrowserWindow.getFocusedWindow();
  }

  broadcast(channel: string, payload?: unknown): void {
    for (const w of this.wins.values()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }

  /**
   * Register a hook invoked for every NEW window created by open().
   * Used by the tray to wire close→hide on each window as it appears,
   * and by perf/checkpoint subsystems for per-window setup.
   * Returns an unsubscribe function.
   */
  onWindowCreated(hook: WindowCreationHook): () => void {
    this.creationHooks.add(hook);
    return () => { this.creationHooks.delete(hook); };
  }

  closeAll(): void {
    for (const w of this.wins.values()) if (!w.isDestroyed()) w.close();
    this.wins.clear();
  }
}

export const windowManager = new WindowManager();
