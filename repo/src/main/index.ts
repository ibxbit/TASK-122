import { app } from 'electron';
import path from 'node:path';
import Database from 'better-sqlite3';

import { applyMigrations } from './db/migrate';
import { bootstrapFirstRun } from './db/bootstrap';
import { seedDemoCredentials } from './db/demo-seed';
import { startupTimer } from './perf/startup-timer';
import { perfMonitor } from './perf/monitor';
import { memorySafety } from './perf/memory-safety';
import { enableHighDpi, windowManager } from './windows/WindowManager';
import { installNetworkGuard } from './security/network-guard';
import { installTray, registerWindow } from './app-lifecycle';
import { trayManager } from './tray/tray';
import { buildAppMenu } from './shortcuts/AppMenu';
import { Scheduler, defineReportJobs } from './scheduler/Scheduler';
import { CheckpointManager } from './recovery/checkpoint';
import { detectDirtyShutdown, promptRestore, applySession, clearSession } from './recovery/restore';
import { initDbLifecycle } from './db/cleanup';
import { registerCanProbe } from './access/enforce';
import { registerContractHandlers } from './ipc/contracts.handler';
import { registerAuditHandlers } from './ipc/audit.handler';
import { registerAnalyticsHandlers } from './ipc/analytics.handler';
import { registerSessionHandlers } from './ipc/session.handler';
import { registerReviewsHandlers } from './ipc/reviews.handler';
import { registerRoutingHandlers } from './ipc/routing.handler';
import { registerUpdatesHandlers } from './ipc/updates.handler';
import { registerAdminHandlers } from './ipc/admin.handler';
import { registerFilePickerHandlers } from './ipc/file-picker.handler';
import { registerShortcutsHandlers } from './ipc/shortcuts.handler';
import { loadShortcutConfig } from './shortcuts/config';
import { clearAllSessions } from './session';
import { ensureSigningKeypair } from './audit/bundle-signer';
import { ExpiryService } from './contracts/expiry-service';
import { logger } from './logger';
import { StatementCache, ImageBufferCache } from './resources/lifecycle';

/* =========================================================================
 * Main Bootstrap — the single authoritative entrypoint for the Electron
 * main process.  Wires every subsystem in dependency order:
 *
 *   1. Pre-ready:  High-DPI, perf monitor, startup timer
 *   2. App ready:  DB init, network guard, IPC registration, session handlers
 *   3. Window:     App menu, window manager, tray, checkpoint, scheduler
 *   4. Restore:    Dirty-shutdown detection → prompt → restore or fresh start
 *   5. Shutdown:   Graceful teardown (scheduler → checkpoint → DB → memory)
 * ========================================================================= */

const MIGRATIONS_DIR = path.join(__dirname, 'db/migrations');

// ── 1. Pre-ready ─────────────────────────────────────────────────────────
enableHighDpi();
perfMonitor.start();
startupTimer.mark('pre_ready');

// ── 2. App ready ─────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  startupTimer.mark('app_ready');

  // DB initialization
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'leasehub.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  // Apply migrations through the versioned runner — fails fast on any
  // integrity problem (including unsafe brownfield states) so startup
  // never silently diverges.  Brownfield baseline is opt-in via
  // `LH_DB_BASELINE=<version>`; the runner reads that env var itself,
  // so no wiring is required here beyond a single call.
  const migrationResult = applyMigrations(db, MIGRATIONS_DIR);
  logger.info(
    {
      applied:   migrationResult.applied.length,
      skipped:   migrationResult.skipped.length,
      baselined: migrationResult.baselined.length,
    },
    'migrations_complete',
  );
  startupTimer.mark('db_ready');

  // First-run bootstrap: permission catalog + roles + role-perm grants
  // always, plus initial tenant/admin on a truly empty database.
  const bootstrap = bootstrapFirstRun(db);
  if (bootstrap.firstRun) {
    logger.warn(
      { credentialsPath: bootstrap.credentialsPath },
      'first_run_admin_credentials_written',
    );
  }

  // Opt-in demo seed — the Docker image sets LH_DEMO_SEED=1 so reviewers
  // land on a fully-usable app with one account per role.  Production
  // installs do NOT set it.
  if (process.env.LH_DEMO_SEED === '1') {
    try {
      const demo = seedDemoCredentials(db);
      logger.warn(
        { created: demo.createdUsers.length, skipped: demo.skippedUsers.length },
        'demo_credentials_seeded',
      );
    } catch (err) {
      logger.error({ err }, 'demo_seed_failed');
    }
  }
  startupTimer.mark('bootstrap_complete');

  // Statement + image caches
  const stmtCache = new StatementCache({ maxEntries: 256 });
  const imgCache = new ImageBufferCache({ maxBytes: 64 * 1024 * 1024 });

  initDbLifecycle({ db, statementCaches: [stmtCache] });
  startupTimer.mark('db_lifecycle_ready');

  // Memory safety
  memorySafety.install();
  memorySafety.trackStatementCache('main', stmtCache);
  memorySafety.trackImageCache('main', imgCache);
  perfMonitor.registerCaches({ statements: stmtCache, images: imgCache });

  // Network guard (offline enforcement)
  installNetworkGuard();
  startupTimer.mark('network_guard_installed');

  // Audit bundle signing keypair (generates on first run)
  await ensureSigningKeypair();
  startupTimer.mark('signing_keypair_ready');

  // ── IPC handler registration (full surface) ───────────────────────
  registerCanProbe();
  registerSessionHandlers();
  registerContractHandlers();
  registerAuditHandlers();
  registerAnalyticsHandlers();
  registerReviewsHandlers();
  registerRoutingHandlers();
  registerUpdatesHandlers();
  registerAdminHandlers();
  registerFilePickerHandlers();
  registerShortcutsHandlers();
  startupTimer.mark('ipc_handlers_registered');

  // ── App menu + shortcuts ──────────────────────────────────────────
  // Build the menu against the persisted shortcut config (if any).  The
  // config layer validates + rejects conflicts before the menu sees them.
  try {
    const shortcutConfig = await loadShortcutConfig();
    buildAppMenu(shortcutConfig);
  } catch (err) {
    logger.warn({ err }, 'shortcut_config_broken_falling_back_to_defaults');
    buildAppMenu();   // fall back to defaults
  }
  startupTimer.mark('menu_built');

  // ── Window creation hook → tray wiring ────────────────────────────
  windowManager.onWindowCreated((win, _kind) => {
    registerWindow(win);
  });

  // ── Expiry reminder service — wired to broadcast + tray badge ─────
  const expiryService = new ExpiryService(db, {
    broadcast:   (ch, payload) => windowManager.broadcast(ch, payload),
    onTrayBadge: (count) => {
      try { trayManager.setBadgeCount(count); }
      catch (err) { logger.warn({ err }, 'tray_badge_set_failed'); }
    },
  });

  // ── Scheduler (daily/weekly reports + expiry scan) ────────────────
  const resolveTenantIds = (): string[] => {
    try {
      const rows = db.prepare('SELECT id FROM tenants').all() as Array<{ id: string }>;
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
  };
  const jobs = [
    ...defineReportJobs(resolveTenantIds),
    expiryService.createScanJob(),
  ];
  const scheduler = new Scheduler(jobs);

  // ── Checkpoint ────────────────────────────────────────────────────
  const checkpointer = new CheckpointManager({
    openWindows: () => windowManager.all(),
    kindOf: (win) => windowManager.kindOf(win),
  });

  // ── Tray integration ──────────────────────────────────────────────
  installTray({
    windows: () => windowManager.all(),
    openDashboard: () => windowManager.open('dashboard'),
    onBeforeQuit: async () => {
      scheduler.stop();
      await checkpointer.stop({ graceful: true });
      await memorySafety.shutdown();
      clearAllSessions();
    },
  });
  startupTimer.mark('tray_installed');

  // ── Start background services ─────────────────────────────────────
  await checkpointer.start();
  scheduler.start();
  // Kick off one expiry scan on startup so cold-launch users see pending
  // reminders without waiting for the 07:15 daily trigger.
  try { expiryService.scanNow(); }
  catch (err) { logger.warn({ err }, 'initial_expiry_scan_failed'); }
  startupTimer.mark('services_started');

  // ── Dirty-shutdown restore flow ───────────────────────────────────
  const dirty = await detectDirtyShutdown();
  if (dirty) {
    const shouldRestore = await promptRestore(dirty.session);
    if (shouldRestore) {
      await applySession(dirty.session, {
        openWindow: (kind, init) =>
          windowManager.open(kind as 'dashboard' | 'contracts' | 'audit', init),
      });
    } else {
      await clearSession();
      windowManager.open('dashboard');
    }
  } else {
    windowManager.open('dashboard');
  }

  startupTimer.finish('first_window_ready');
  logger.info('bootstrap_complete');
});

// ── Shutdown hooks ────────────────────────────────────────────────────────
app.on('before-quit', () => {
  clearAllSessions();
});

// Prevent second instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = windowManager.all();
    if (wins.length > 0) {
      const w = wins[0];
      if (w.isMinimized()) w.restore();
      w.focus();
    } else {
      windowManager.open('dashboard');
    }
  });
}
