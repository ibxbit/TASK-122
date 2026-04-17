import {
  app, Tray, Menu, nativeImage, type BrowserWindow, type MenuItemConstructorOptions,
} from 'electron';
import { logger } from '../logger';

/* =========================================================================
 * System Tray
 *
 *  • Creates the tray icon + context menu (Show App / Hide App / Quit)
 *  • Owns the `isQuitting` flag — window close handlers consult it to
 *    decide hide-to-tray vs actual destroy
 *  • Closing windows does NOT exit the app; the scheduler, checkpointer
 *    and perf monitor keep running because they live in the main process
 *    and do not depend on any window
 * ========================================================================= */

export interface TrayDeps {
  iconPath:       string;
  tooltip?:       string;
  windows:        () => BrowserWindow[];
  openDashboard:  () => BrowserWindow;            // shown when tray "Show App" clicked with no open windows
  onQuit?:        () => Promise<void> | void;     // hook for scheduler.stop / checkpointer.stop etc.
}

class TrayManager {
  private tray:         Tray | null = null;
  private deps:         TrayDeps | null = null;
  private _isQuitting = false;

  /** Read by window-close handlers to decide hide vs destroy. */
  get isQuitting(): boolean { return this._isQuitting; }

  /** Called once from before-quit / Ctrl+Q / menu-Quit so close events let through. */
  signalQuitting(): void { this._isQuitting = true; }

  /* ---------- init ------------------------------------------------ */

  initTray(deps: TrayDeps): Tray {
    if (this.tray && !this.tray.isDestroyed()) return this.tray;
    this.deps = deps;

    const img = nativeImage.createFromPath(deps.iconPath);
    if (img.isEmpty()) logger.warn({ iconPath: deps.iconPath }, 'tray_icon_missing_using_empty');

    this.tray = new Tray(img);
    this.tray.setToolTip(deps.tooltip ?? 'LeaseHub Operations Console');
    this.tray.on('double-click', () => this.showAll());
    this.refreshMenu();

    logger.info({ iconPath: deps.iconPath }, 'tray_initialized');
    return this.tray;
  }

  /* ---------- per-window wiring ----------------------------------- */

  /** Attach close interception to a window so it hides to tray instead of quitting. */
  wireMinimizeToTray(win: BrowserWindow): void {
    win.on('close', (event) => {
      if (this._isQuitting) return;                       // user really wants to quit
      event.preventDefault();
      win.hide();
      this.refreshMenu();
    });
    win.on('show', () => this.refreshMenu());
    win.on('hide', () => this.refreshMenu());
  }

  /* ---------- actions --------------------------------------------- */

  showAll(): void {
    const wins = this.deps?.windows() ?? [];
    if (wins.length === 0) {
      this.deps?.openDashboard();
    } else {
      for (const w of wins) {
        if (w.isDestroyed()) continue;
        if (w.isMinimized()) w.restore();
        w.show();
      }
      const last = wins[wins.length - 1];
      if (last && !last.isDestroyed()) last.focus();
    }
    this.refreshMenu();
  }

  hideAll(): void {
    for (const w of this.deps?.windows() ?? []) {
      if (!w.isDestroyed()) w.hide();
    }
    this.refreshMenu();
  }

  async quit(): Promise<void> {
    this._isQuitting = true;
    try       { await this.deps?.onQuit?.(); }
    catch (err) { logger.error({ err }, 'tray_onquit_failed'); }
    app.quit();
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
    this.deps = null;
    this._isQuitting = false;
  }

  /**
   * Update the tray tooltip with a pending-notification count.  Electron's
   * Tray API has no portable badge API (macOS only), so we overlay the
   * count into the tooltip.  Safe to call before initTray — becomes a no-op.
   */
  setBadgeCount(count: number): void {
    if (!this.tray || this.tray.isDestroyed() || !this.deps) return;
    const base = this.deps.tooltip ?? 'LeaseHub Operations Console';
    this.tray.setToolTip(count > 0 ? `${base} (${count} pending)` : base);
    // macOS: also set the app dock badge text if available
    try {
      const dock = (app as unknown as { dock?: { setBadge: (s: string) => void } }).dock;
      if (dock && typeof dock.setBadge === 'function') {
        dock.setBadge(count > 0 ? String(count) : '');
      }
    } catch { /* not on macOS or no dock — silently ignore */ }
  }

  /* ---------- menu building --------------------------------------- */

  private refreshMenu(): void {
    if (!this.tray || this.tray.isDestroyed() || !this.deps) return;
    const anyVisible = this.deps.windows().some((w) => !w.isDestroyed() && w.isVisible());

    const template: MenuItemConstructorOptions[] = [
      { label: 'Show App', click: () => void this.showAll(), enabled: !anyVisible },
      { label: 'Hide App', click: () =>      this.hideAll(),  enabled:  anyVisible },
      { type:  'separator' },
      { label: 'Quit',     click: () => void this.quit() },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}

export const trayManager = new TrayManager();
