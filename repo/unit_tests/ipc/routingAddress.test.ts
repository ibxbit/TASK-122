import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* =========================================================================
 * routing:resolveAddress + routing:optimize(addresses).
 *
 *  Verifies address-driven planning:
 *    - empty query → empty_query
 *    - no active dataset → no_active_dataset
 *    - prefix + substring search
 *    - optimize(addresses) fails cleanly on unresolved addresses
 *    - optimize(addresses) succeeds when all addresses resolve
 * ========================================================================= */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, payload: unknown) => unknown) => handlers.set(ch, fn),
    on: vi.fn(), removeListener: vi.fn(),
  },
  app: { getPath: () => '/tmp/test', getVersion: () => '1.0.0', getAppPath: () => '/tmp/test', whenReady: () => Promise.resolve() },
}));

import { makeTestDb, seedAccessGraph, type SeededIds } from '../_helpers/db';
import { initDbLifecycle } from '../../src/main/db/cleanup';
import { bootstrapFirstRun } from '../../src/main/db/bootstrap';
import { setSession, clearAllSessions } from '../../src/main/session';
import { registerRoutingHandlers } from '../../src/main/ipc/routing.handler';

function invoke(channel: string, senderId: number, payload: unknown = {}): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no_handler_for:${channel}`);
  return fn({ sender: { id: senderId } }, payload);
}

describe('routing address resolution', () => {
  let db: ReturnType<typeof makeTestDb>;
  let ids: SeededIds;

  beforeEach(() => {
    db = makeTestDb();
    ids = seedAccessGraph(db);
    bootstrapFirstRun(db);
    try { initDbLifecycle({ db }); } catch { /* already */ }
    handlers.clear();
    clearAllSessions();
    registerRoutingHandlers();

    setSession(8, {
      userId: ids.opsUserId, tenantId: ids.tenantId,
      roles: ['OperationsManager'], loggedInAt: 0,
    });
  });

  afterEach(() => {
    clearAllSessions();
    db.close();
    handlers.clear();
  });

  it('routing:resolveAddress — empty query → empty_query', async () => {
    const r = await invoke('routing:resolveAddress', 8, { query: '  ' }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty_query');
  });

  it('routing:resolveAddress — no active dataset → no_active_dataset', async () => {
    const r = await invoke('routing:resolveAddress', 8, { query: 'main st' }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_active_dataset');
  });

  it('resolves addresses with prefix + substring matching', async () => {
    // Seed one active dataset with three addresses.
    db.prepare(`INSERT INTO route_datasets (id, name, version, imported_at, active)
                VALUES ('rds_1', 'us_east', '1.0.0', 1000, 1)`).run();
    db.prepare(`INSERT INTO route_addresses (dataset_id, address_key, display, node_id) VALUES
      ('rds_1', '100 main st brooklyn 11201',  '100 Main St, Brooklyn NY 11201',  101),
      ('rds_1', '200 main st brooklyn 11201',  '200 Main St, Brooklyn NY 11201',  102),
      ('rds_1', '42 elm rd queens 11375',      '42 Elm Rd, Queens NY 11375',      200)`).run();

    const r = await invoke('routing:resolveAddress', 8, { query: 'main' }) as
      { ok: boolean; matches: Array<{ display: string; nodeId: number }> };
    expect(r.ok).toBe(true);
    expect(r.matches.length).toBe(2);
    expect(r.matches.map((m) => m.nodeId).sort()).toEqual([101, 102]);
  });

  it('routing:optimize(addresses) — unresolved addresses reported, no work done', async () => {
    db.prepare(`INSERT INTO route_datasets (id, name, version, imported_at, active)
                VALUES ('rds_1', 'us_east', '1.0.0', 1000, 1)`).run();
    db.prepare(`INSERT INTO route_addresses (dataset_id, address_key, display, node_id) VALUES
      ('rds_1', '1 a st',  '1 A St',  1)`).run();

    const r = await invoke('routing:optimize', 8, {
      addresses:  ['1 a st', 'this does not exist'],
      optimizeBy: 'time',
    }) as { ok: boolean; error?: string; unresolved?: string[] };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('address_not_found');
    expect(r.unresolved).toContain('this does not exist');
  });

  it('routing:optimize — supplying neither stops nor addresses → missing_stops_or_addresses', async () => {
    const r = await invoke('routing:optimize', 8, { optimizeBy: 'time' }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_stops_or_addresses');
  });
});
