import { app, type BrowserWindow } from 'electron';
import path from 'node:path';
import { logger } from './logger';
import { trayManager } from './tray/tray';

/* =========================================================================
 * App Lifecycle Integration
 *
 *   installTray(deps)   — wires tray + hide-on-close + "keep running when
 *                         all windows closed".  Scheduler / checkpointer /
 *                         perf monitor already live in the main process and
 *                         are unaffected by window state.
 *   registerWindow(win) — call for every new BrowserWindow (e.g. from the
 *                         end of WindowManager.open()) so its close event
 *                         is intercepted and routed to tray.
 * ========================================================================= */

export interface TrayIntegrationDeps {
  /** Absolute path to the tray icon. Windows: .ico or .png; 16×16 + 32×32 recommended. */
  iconPath?:      string;
  /** Live window list — callers typically pass () => windowManager.all(). */
  windows:        () => BrowserWindow[];
  /** Re-open the dashboard when tray "Show App" is clicked with nothing open. */
  openDashboard:  () => BrowserWindow;
  /** Graceful-shutdown hook run just before app.quit() from the tray. */
  onBeforeQuit?:  () => Promise<void> | void;
  tooltip?:       string;
}

export function installTray(deps: TrayIntegrationDeps): void {
  const iconPath = deps.iconPath
    ?? path.join(process.resourcesPath ?? app.getAppPath(), 'tray-icon.png');

  trayManager.initTray({
    iconPath,
    tooltip:       deps.tooltip ?? 'LeaseHub Operations Console',
    windows:       deps.windows,
    openDashboard: deps.openDashboard,
    onQuit:        deps.onBeforeQuit,
  });

  // Hook any already-open windows.
  for (const w of deps.windows()) trayManager.wireMinimizeToTray(w);

  // Default Electron behaviour is "quit when last window closes".  Override:
  // we want the process (and the scheduler inside it) to keep running in
  // the tray until the user explicitly selects Quit.
  //
  // Electron emits an Event argument at runtime but the `@types/electron`
  // signature declares `() => void`.  We cast through `unknown` so the
  // runtime `event.preventDefault()` still works while TS accepts the
  // listener shape.
  app.on('window-all-closed', ((event: Electron.Event) => {
    if (!trayManager.isQuitting) {
      event.preventDefault();
      logger.info('all_windows_closed_kept_alive');
    }
  }) as unknown as () => void);

  // Any quit path (Ctrl+Q, native menu, Cmd+Q, OS shutdown) flips the flag
  // so window-close handlers stop intercepting.
  app.on('before-quit', () => trayManager.signalQuitting());

  logger.info('tray_lifecycle_installed');
}

/** Call from WindowManager.open() after BrowserWindow construction. */
export function registerWindow(win: BrowserWindow): void {
  trayManager.wireMinimizeToTray(win);
}
