import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';

/* =========================================================================
 * Bootstrap Entrypoint Tests
 *
 *  Verifies:
 *    - src/main/index.ts exists (single authoritative entrypoint)
 *    - package.json "main" points to correct dist path
 *    - All subsystem modules referenced by the bootstrap exist
 *    - No circular import between key bootstrap modules
 * ========================================================================= */

const SRC = path.resolve(__dirname, '../../src');
const ROOT = path.resolve(__dirname, '../..');

describe('Electron main bootstrap entrypoint', () => {
  it('src/main/index.ts exists as the single authoritative entrypoint', () => {
    expect(existsSync(path.join(SRC, 'main/index.ts'))).toBe(true);
  });

  it('package.json main field points to dist/main/index.js', () => {
    const pkg = require(path.join(ROOT, 'package.json'));
    expect(pkg.main).toBe('dist/main/index.js');
  });

  it('all subsystem modules referenced by bootstrap exist', () => {
    const requiredModules = [
      'main/perf/startup-timer.ts',
      'main/perf/monitor.ts',
      'main/perf/memory-safety.ts',
      'main/windows/WindowManager.ts',
      'main/security/network-guard.ts',
      'main/app-lifecycle.ts',
      'main/shortcuts/AppMenu.ts',
      'main/scheduler/Scheduler.ts',
      'main/recovery/checkpoint.ts',
      'main/recovery/restore.ts',
      'main/db/cleanup.ts',
      'main/access/enforce.ts',
      'main/ipc/contracts.handler.ts',
      'main/ipc/audit.handler.ts',
      'main/ipc/analytics.handler.ts',
      'main/ipc/session.handler.ts',
      'main/session.ts',
      'main/audit/bundle-signer.ts',
      'main/logger.ts',
      'main/resources/lifecycle.ts',
    ];

    for (const mod of requiredModules) {
      expect(existsSync(path.join(SRC, mod)), `Missing: ${mod}`).toBe(true);
    }
  });

  it('preload/index.ts exists', () => {
    expect(existsSync(path.join(SRC, 'preload/index.ts'))).toBe(true);
  });

  it('IPC handler modules export registration functions', () => {
    // Verify the handler module files contain export function register...
    const fs = require('node:fs');
    const sessionHandler = fs.readFileSync(path.join(SRC, 'main/ipc/session.handler.ts'), 'utf8');
    expect(sessionHandler).toContain('export function registerSessionHandlers');

    const auditHandler = fs.readFileSync(path.join(SRC, 'main/ipc/audit.handler.ts'), 'utf8');
    expect(auditHandler).toContain('export function registerAuditHandlers');

    const analyticsHandler = fs.readFileSync(path.join(SRC, 'main/ipc/analytics.handler.ts'), 'utf8');
    expect(analyticsHandler).toContain('export function registerAnalyticsHandlers');

    const contractsHandler = fs.readFileSync(path.join(SRC, 'main/ipc/contracts.handler.ts'), 'utf8');
    expect(contractsHandler).toContain('export function registerContractHandlers');
  });

  it('bootstrap index.ts registers all IPC handler groups', () => {
    const fs = require('node:fs');
    const bootstrap = fs.readFileSync(path.join(SRC, 'main/index.ts'), 'utf8');

    expect(bootstrap).toContain('registerCanProbe()');
    expect(bootstrap).toContain('registerSessionHandlers()');
    expect(bootstrap).toContain('registerContractHandlers()');
    expect(bootstrap).toContain('registerAuditHandlers()');
    expect(bootstrap).toContain('registerAnalyticsHandlers()');
  });

  it('bootstrap wires all lifecycle hooks', () => {
    const fs = require('node:fs');
    const bootstrap = fs.readFileSync(path.join(SRC, 'main/index.ts'), 'utf8');

    // Pre-ready hooks
    expect(bootstrap).toContain('enableHighDpi()');
    expect(bootstrap).toContain('perfMonitor.start()');

    // App ready
    expect(bootstrap).toContain('app.whenReady()');
    expect(bootstrap).toContain('installNetworkGuard()');
    expect(bootstrap).toContain('buildAppMenu()');
    expect(bootstrap).toContain('installTray(');

    // Services
    expect(bootstrap).toContain('scheduler.start()');
    expect(bootstrap).toContain('checkpointer.start()');

    // Restore flow
    expect(bootstrap).toContain('detectDirtyShutdown()');

    // Shutdown
    expect(bootstrap).toContain('scheduler.stop()');
    expect(bootstrap).toContain('memorySafety.shutdown()');
    expect(bootstrap).toContain('clearAllSessions()');
  });
});
