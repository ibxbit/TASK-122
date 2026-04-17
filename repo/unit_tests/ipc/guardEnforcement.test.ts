import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* =========================================================================
 * Guard enforcement — EVERY guarded channel must deny when no session is
 * present.  We walk the actual registerGuarded output, not a reimplementation.
 * ========================================================================= */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, payload: unknown) => unknown) => handlers.set(ch, fn),
    on: vi.fn(),
    removeListener: vi.fn(),
    webContents: { getAllWebContents: () => [] },
  },
  app: { getPath: () => '/tmp/test', getVersion: () => '1.0.0', getAppPath: () => '/tmp/test', whenReady: () => Promise.resolve() },
  BrowserWindow: class { static getFocusedWindow() { return null; } },
  dialog: { showSaveDialog: vi.fn().mockResolvedValue({ canceled: true, filePath: undefined }) },
}));

// WindowManager is dragged in by the contracts handler (for contracts:open)
vi.mock('../../src/main/windows/WindowManager', () => ({
  windowManager: { open: vi.fn() },
  enableHighDpi: vi.fn(),
}));

import { makeTestDb, seedAccessGraph } from '../_helpers/db';
import { initDbLifecycle } from '../../src/main/db/cleanup';
import { clearAllSessions } from '../../src/main/session';

import { registerContractHandlers } from '../../src/main/ipc/contracts.handler';
import { registerAuditHandlers }    from '../../src/main/ipc/audit.handler';
import { registerAnalyticsHandlers } from '../../src/main/ipc/analytics.handler';
import { registerReviewsHandlers }  from '../../src/main/ipc/reviews.handler';
import { registerRoutingHandlers }  from '../../src/main/ipc/routing.handler';
import { registerUpdatesHandlers }  from '../../src/main/ipc/updates.handler';
import { registerAdminHandlers }    from '../../src/main/ipc/admin.handler';
import { registerCanProbe }         from '../../src/main/access/enforce';

const SENSITIVE_CHANNELS = [
  'contracts:list', 'contracts:get', 'contracts:delete', 'contracts:approve',
  'contracts:reject', 'contracts:sign', 'contracts:newDraft', 'contracts:expiring',
  'contracts:export', 'contracts:open',
  'audit:list', 'audit:verify', 'audit:export',
  'analytics:snapshot', 'analytics:export',
  'reviews:list', 'reviews:get', 'reviews:create', 'reviews:moderate',
  'reviews:reply', 'reviews:resolveFollowUp', 'reviews:flags',
  'routing:datasets', 'routing:activeDataset', 'routing:import',
  'routing:activate', 'routing:rollback', 'routing:optimize',
  'updates:registry', 'updates:versions', 'updates:import',
  'updates:rollback', 'updates:cancel',
  'admin:listTenants', 'admin:listUsers', 'admin:createUser',
  'admin:disableUser', 'admin:resetPassword',
  'admin:grantRole', 'admin:revokeRole', 'admin:setDataScope',
  'admin:policies', 'admin:addPolicyWord', 'admin:removePolicyWord',
];

function invoke(channel: string, senderId: number, payload: unknown = {}): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no_handler_for:${channel}`);
  return fn({ sender: { id: senderId } }, payload);
}

describe('Guard enforcement — every sensitive channel', () => {
  beforeEach(() => {
    const db = makeTestDb();
    seedAccessGraph(db);
    try { initDbLifecycle({ db }); } catch { /* already initialised */ }

    handlers.clear();
    clearAllSessions();

    // Register the full sensitive surface once.
    registerCanProbe();
    registerContractHandlers();
    registerAuditHandlers();
    registerAnalyticsHandlers();
    registerReviewsHandlers();
    registerRoutingHandlers();
    registerUpdatesHandlers();
    registerAdminHandlers();
  });

  afterEach(() => {
    clearAllSessions();
    handlers.clear();
  });

  it('registers every sensitive channel', () => {
    for (const ch of SENSITIVE_CHANNELS) {
      expect(handlers.has(ch), `missing handler: ${ch}`).toBe(true);
    }
  });

  it('every sensitive channel throws access_denied:no_session when no session is set', async () => {
    const results = await Promise.all(SENSITIVE_CHANNELS.map(async (ch) => {
      try {
        await Promise.resolve(invoke(ch, 1, {}));
        return { ch, ok: false as const, reason: 'did_not_throw' };
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        return { ch, ok: msg.includes('access_denied:no_session'), reason: msg };
      }
    }));
    const bad = results.filter((r) => !r.ok);
    expect(bad, bad.map((b) => `${b.ch} → ${b.reason}`).join('\n')).toEqual([]);
  });

  it('access:can reports allowed=false with reason=no_session when unauthenticated', async () => {
    const r = await invoke('access:can', 1, {
      permission: 'contract.list', type: 'api', action: 'read',
    }) as { allowed: boolean; reason: string };
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no_session');
  });
});
