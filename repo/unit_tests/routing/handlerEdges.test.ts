import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* =========================================================================
 * routing.handler — production-path edge-case coverage.
 *
 *  Covers:
 *    • routing:datasets  → empty list before any imports
 *    • routing:activate  → dataset_not_found for unknown id
 *    • routing:activate  → atomic switch: exactly one active row after
 *    • routing:rollback  → no_previous_dataset when only one exists
 *    • routing:optimize  → invalid_stop_count for too few / too many stops
 *    • Every write produces a chain-audit event with a valid seq + hash
 * ========================================================================= */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, payload: unknown) => unknown) => handlers.set(ch, fn),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  app: { getPath: () => '/tmp/test', getVersion: () => '1.0.0', getAppPath: () => '/tmp/test', whenReady: () => Promise.resolve() },
}));

import { makeTestDb, seedAccessGraph, type SeededIds } from '../_helpers/db';
import { initDbLifecycle } from '../../src/main/db/cleanup';
import { setSession, clearAllSessions } from '../../src/main/session';
import { registerRoutingHandlers } from '../../src/main/ipc/routing.handler';

function invoke(channel: string, senderId: number, payload: unknown = {}): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no_handler_for:${channel}`);
  return fn({ sender: { id: senderId } }, payload);
}

describe('routing.handler — edge cases + audit emission', () => {
  let db: ReturnType<typeof makeTestDb>;
  let ids: SeededIds;

  beforeEach(() => {
    db = makeTestDb();
    ids = seedAccessGraph(db);
    try { initDbLifecycle({ db }); } catch { /* already initialised */ }

    // Grant OperationsManager routing.view + routing.optimize + routing.import.
    db.prepare(`INSERT OR IGNORE INTO permissions (id, code, type, action, description) VALUES
      ('p_route_view',     'routing.view',     'api', 'read',  'View routing'),
      ('p_route_import',   'routing.import',   'api', 'write', 'Import dataset'),
      ('p_route_optimize', 'routing.optimize', 'api', 'read',  'Optimize')`).run();
    db.prepare(`INSERT INTO role_permissions (role_id, permission_id, effect) VALUES
      ('role_operations_manager', 'p_route_view',     'allow'),
      ('role_operations_manager', 'p_route_import',   'allow'),
      ('role_operations_manager', 'p_route_optimize', 'allow')`).run();

    handlers.clear();
    clearAllSessions();
    registerRoutingHandlers();

    setSession(11, {
      userId: ids.opsUserId, tenantId: ids.tenantId,
      roles: ['OperationsManager'], loggedInAt: 0,
    });
  });

  afterEach(() => {
    clearAllSessions();
    db.close();
    handlers.clear();
  });

  it('routing:datasets returns [] when no datasets have been imported', async () => {
    const rows = await invoke('routing:datasets', 11, {}) as unknown[];
    expect(rows).toEqual([]);
  });

  it('routing:activeDataset returns null when nothing is active', async () => {
    const v = await invoke('routing:activeDataset', 11, {}) as unknown;
    expect(v).toBeNull();
  });

  it('routing:activate reports dataset_not_found for unknown id', async () => {
    const r = await invoke('routing:activate', 11, { datasetId: 'rd_missing' }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('dataset_not_found');
    // No audit event emitted for the failure path (nothing happened)
    const n = (db.prepare(`
      SELECT COUNT(*) AS n FROM audit_events WHERE action = 'routing.dataset_activated'
    `).get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('routing:activate atomically switches the active flag and appends a chain-audit event', async () => {
    // Seed two datasets directly — bypasses the file loader for this unit test.
    db.prepare(`INSERT INTO route_datasets (id, name, version, imported_at, active) VALUES
      ('rd_1', 'us_east', '1.0.0', 1000, 1),
      ('rd_2', 'us_east', '1.1.0', 2000, 0)`).run();

    const r = await invoke('routing:activate', 11, { datasetId: 'rd_2' }) as { ok: boolean; activated: string; previous: string };
    expect(r.ok).toBe(true);
    expect(r.activated).toBe('rd_2');
    expect(r.previous).toBe('rd_1');

    const activeRows = db.prepare('SELECT id FROM route_datasets WHERE active = 1').all() as Array<{ id: string }>;
    expect(activeRows.length).toBe(1);
    expect(activeRows[0].id).toBe('rd_2');

    const ae = db.prepare(`
      SELECT seq, hash_curr FROM audit_events
       WHERE action = 'routing.dataset_activated' AND entity_id = 'rd_2'
    `).get() as { seq: number; hash_curr: string } | undefined;
    expect(ae).toBeDefined();
    expect(ae!.seq).toBeGreaterThan(0);
    expect(ae!.hash_curr).toMatch(/^[0-9a-f]{64}$/);
  });

  it('routing:rollback fails when only one dataset exists', async () => {
    db.prepare(`INSERT INTO route_datasets (id, name, version, imported_at, active) VALUES
      ('rd_solo', 'us_east', '1.0.0', 1000, 1)`).run();

    const r = await invoke('routing:rollback', 11, {}) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_previous_dataset');
  });

  it('routing:rollback switches to the second-most-recent dataset and audits', async () => {
    db.prepare(`INSERT INTO route_datasets (id, name, version, imported_at, active) VALUES
      ('rd_prev',    'us_east', '1.0.0', 1000, 0),
      ('rd_current', 'us_east', '1.1.0', 2000, 1)`).run();

    const r = await invoke('routing:rollback', 11, {}) as { ok: boolean; rolledBackTo: string; from: string };
    expect(r.ok).toBe(true);
    expect(r.rolledBackTo).toBe('rd_prev');
    expect(r.from).toBe('rd_current');

    const ae = db.prepare(`
      SELECT seq FROM audit_events WHERE action = 'routing.dataset_rollback'
    `).get() as { seq: number } | undefined;
    expect(ae?.seq).toBeGreaterThan(0);
  });

  it('routing:optimize rejects zero / one stop', async () => {
    const zero = await invoke('routing:optimize', 11, {
      stops: [], optimizeBy: 'time',
    }) as { ok: boolean; error?: string };
    expect(zero.ok).toBe(false);
    expect(zero.error).toBe('invalid_stop_count');

    const one = await invoke('routing:optimize', 11, {
      stops: [{ nodeId: 1, label: 'a' }], optimizeBy: 'time',
    }) as { ok: boolean; error?: string };
    expect(one.ok).toBe(false);
  });

  it('routing:optimize rejects more than MAX_STOPS (25)', async () => {
    const stops = Array.from({ length: 26 }, (_, i) => ({ nodeId: i + 1, label: `s${i}` }));
    const r = await invoke('routing:optimize', 11, { stops, optimizeBy: 'time' }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_stop_count');
  });
});
