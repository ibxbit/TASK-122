import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* =========================================================================
 * Object-level authorization at the HANDLER level.
 *
 *  We register the real contracts handler against an in-memory DB, seed a
 *  scoped user (OperationsManager limited to location loc_nyc via data_scopes),
 *  then confirm delete/approve/reject/sign against a contract at loc_sf are
 *  denied — even though the user has the role-level permission.
 * ========================================================================= */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, payload: unknown) => unknown) => handlers.set(ch, fn),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  app: { getPath: () => '/tmp/test', getVersion: () => '1.0.0', getAppPath: () => '/tmp/test', whenReady: () => Promise.resolve() },
  BrowserWindow: class { static getFocusedWindow() { return null; } },
}));
vi.mock('../../src/main/windows/WindowManager', () => ({
  windowManager: { open: vi.fn() },
}));

import { makeTestDb, seedAccessGraph, type SeededIds } from '../_helpers/db';
import { initDbLifecycle } from '../../src/main/db/cleanup';
import { setSession, clearAllSessions } from '../../src/main/session';
import { registerContractHandlers } from '../../src/main/ipc/contracts.handler';

function invoke(channel: string, senderId: number, payload: unknown = {}): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no_handler_for:${channel}`);
  return fn({ sender: { id: senderId } }, payload);
}

describe('Object-level ABAC at handler invocation', () => {
  let db: ReturnType<typeof makeTestDb>;
  let ids: SeededIds;

  beforeEach(() => {
    db = makeTestDb();
    ids = seedAccessGraph(db);
    try { initDbLifecycle({ db }); } catch { /* ok */ }

    // Seed a template + two contracts at different org units
    db.prepare(`
      INSERT INTO contract_templates (id, tenant_id, code, name, version, body, variables, status, published_at, created_at, updated_at)
      VALUES ('tpl_1', ?, 'LEASE_STD', 'Std Lease', 1, '', '{}', 'published', 0, 0, 0)
    `).run(ids.tenantId);
    db.prepare(`
      INSERT INTO org_units (id, tenant_id, kind, code, name, path, depth)
      VALUES ('loc_nyc', ?, 'location', 'NYC', 'New York', '/nyc', 1),
             ('loc_sf',  ?, 'location', 'SF',  'San Fran', '/sf',  1)
    `).run(ids.tenantId, ids.tenantId);
    db.prepare(`
      INSERT INTO contract_instances (id, tenant_id, template_id, instance_number, status, rendered_body, org_unit_id, variables, created_at, updated_at)
      VALUES ('ci_nyc', ?, 'tpl_1', 'C-NYC', 'draft', '', 'loc_nyc', '{}', 0, 0),
             ('ci_sf',  ?, 'tpl_1', 'C-SF',  'draft', '', 'loc_sf',  '{}', 0, 0)
    `).run(ids.tenantId, ids.tenantId);

    // Limit OperationsManager to loc_nyc via data_scopes.
    db.prepare(`
      INSERT INTO data_scopes (id, user_role_id, conditions) VALUES
        ('ds_1', 'ur_ops', '{"locationId":"loc_nyc"}')
    `).run();

    handlers.clear();
    clearAllSessions();
    registerContractHandlers();

    setSession(42, {
      userId: ids.opsUserId, tenantId: ids.tenantId,
      roles: ['OperationsManager'], loggedInAt: 0,
    });
  });

  afterEach(() => {
    clearAllSessions();
    db.close();
    handlers.clear();
  });

  it('delete denied on out-of-scope contract (loc_sf)', async () => {
    await expect(
      Promise.resolve(invoke('contracts:delete', 42, { contractId: 'ci_sf' })),
    ).rejects.toThrow(/access_denied:object_scope_denied/);

    // Record must still exist.
    const still = db.prepare('SELECT id FROM contract_instances WHERE id = ?').get('ci_sf');
    expect(still).toBeDefined();
  });

  it('delete allowed on in-scope contract (loc_nyc)', async () => {
    const r = await invoke('contracts:delete', 42, { contractId: 'ci_nyc' }) as { deleted: boolean };
    expect(r.deleted).toBe(true);
    const gone = db.prepare('SELECT id FROM contract_instances WHERE id = ?').get('ci_nyc');
    expect(gone).toBeUndefined();
  });

  it('approve denied on out-of-scope contract', async () => {
    await expect(
      Promise.resolve(invoke('contracts:approve', 42, { id: 'ci_sf' })),
    ).rejects.toThrow(/access_denied:object_scope_denied/);
  });

  it('reject denied on out-of-scope contract', async () => {
    await expect(
      Promise.resolve(invoke('contracts:reject', 42, { id: 'ci_sf' })),
    ).rejects.toThrow(/access_denied:object_scope_denied/);
  });

  it('get denied on out-of-scope contract', async () => {
    await expect(
      Promise.resolve(invoke('contracts:get', 42, { id: 'ci_sf' })),
    ).rejects.toThrow(/access_denied:object_scope_denied/);
  });

  it('approve allowed on in-scope contract transitions status', async () => {
    const r = await invoke('contracts:approve', 42, { id: 'ci_nyc' }) as { success: boolean };
    expect(r.success).toBe(true);
    const row = db.prepare('SELECT status FROM contract_instances WHERE id = ?').get('ci_nyc') as { status: string };
    expect(row.status).toBe('pending_signature');
  });
});
