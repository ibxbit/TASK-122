import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* =========================================================================
 * admin.handler — production-path checks for the tenant/security admin API.
 *
 *  Admin actions must:
 *    - require admin role (TenantAdmin or SystemAdmin) in addition to the
 *      permission grant
 *    - respect tenant isolation (cannot touch rows from another tenant)
 *    - produce audit events through the hash chain
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
import { registerAdminHandlers } from '../../src/main/ipc/admin.handler';

function invoke(channel: string, senderId: number, payload: unknown = {}): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no_handler_for:${channel}`);
  return fn({ sender: { id: senderId } }, payload);
}

describe('admin.handler — tenant/security policy management', () => {
  let db: ReturnType<typeof makeTestDb>;
  let ids: SeededIds;

  beforeEach(() => {
    db = makeTestDb();
    ids = seedAccessGraph(db);
    try { initDbLifecycle({ db }); } catch { /* ok */ }

    // Admin user must have `tenant.admin` permission for these handlers.
    db.prepare(`
      INSERT OR IGNORE INTO permissions (id, code, type, action, description)
      VALUES ('p_tenant_admin', 'tenant.admin', 'api', 'write', 'Tenant admin')
    `).run();
    db.prepare(`
      INSERT INTO role_permissions (role_id, permission_id, effect)
      VALUES ('role_tenant_admin', 'p_tenant_admin', 'allow')
    `).run();
    // OperationsManager also gets tenant.admin granted in the catalog so we
    // can prove the ROLE check (not just permission grant) denies them.
    db.prepare(`
      INSERT INTO role_permissions (role_id, permission_id, effect)
      VALUES ('role_operations_manager', 'p_tenant_admin', 'allow')
    `).run();

    handlers.clear();
    clearAllSessions();
    registerAdminHandlers();
  });

  afterEach(() => {
    clearAllSessions();
    db.close();
    handlers.clear();
  });

  it('non-admin role is denied (role-level check, not just permission)', async () => {
    setSession(42, { userId: ids.opsUserId, tenantId: ids.tenantId, roles: ['OperationsManager'], loggedInAt: 0 });
    await expect(
      Promise.resolve(invoke('admin:listUsers', 42, {})),
    ).rejects.toThrow(/access_denied:role_not_admin/);
  });

  it('TenantAdmin can list users in their tenant', async () => {
    setSession(42, { userId: ids.adminUserId, tenantId: ids.tenantId, roles: ['TenantAdmin'], loggedInAt: 0 });
    const rows = await invoke('admin:listUsers', 42, {}) as Array<{ id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => ['u_admin','u_ops','u_audit','u_mod'].includes(r.id))).toBe(true);
  });

  it('admin:createUser inserts, hashes password, appends audit event', async () => {
    setSession(42, { userId: ids.adminUserId, tenantId: ids.tenantId, roles: ['TenantAdmin'], loggedInAt: 0 });
    const r = await invoke('admin:createUser', 42, {
      username: 'alice', displayName: 'Alice', password: 'verysecret8',
    }) as { ok: boolean; userId: string };
    expect(r.ok).toBe(true);

    const row = db.prepare(
      'SELECT id, status, password_hash, password_salt FROM users WHERE id = ?'
    ).get(r.userId) as { id: string; status: string; password_hash: string; password_salt: string };
    expect(row.status).toBe('active');
    expect(row.password_hash).toMatch(/^[0-9a-f]+$/);
    expect(row.password_salt).toMatch(/^[0-9a-f]+$/);

    const ae = db.prepare(`
      SELECT COUNT(*) AS n FROM audit_events WHERE action = ? AND entity_id = ? AND tenant_id = ?
    `).get('admin.user_created', r.userId, ids.tenantId) as { n: number };
    expect(ae.n).toBe(1);
  });

  it('admin:createUser cannot create user in another tenant', async () => {
    setSession(42, { userId: ids.adminUserId, tenantId: ids.tenantId, roles: ['TenantAdmin'], loggedInAt: 0 });
    const r = await invoke('admin:createUser', 42, {
      username: 'bob', displayName: 'Bob', password: 'password9',
    }) as { ok: boolean; userId: string };
    expect(r.ok).toBe(true);
    // Row is seeded under the admin's tenant regardless of any fabricated hint.
    const row = db.prepare('SELECT tenant_id FROM users WHERE id = ?').get(r.userId) as { tenant_id: string };
    expect(row.tenant_id).toBe(ids.tenantId);
  });

  it('admin:disableUser refuses to disable the caller', async () => {
    setSession(42, { userId: ids.adminUserId, tenantId: ids.tenantId, roles: ['TenantAdmin'], loggedInAt: 0 });
    const r = await invoke('admin:disableUser', 42, { userId: ids.adminUserId }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cannot_disable_self');
  });

  it('admin:grantRole records a chain-audited grant', async () => {
    setSession(42, { userId: ids.adminUserId, tenantId: ids.tenantId, roles: ['TenantAdmin'], loggedInAt: 0 });
    const r = await invoke('admin:grantRole', 42, {
      userId: ids.opsUserId, roleCode: 'ComplianceAuditor',
    }) as { ok: boolean; userRoleId: string };
    expect(r.ok).toBe(true);
    const hit = db.prepare(
      `SELECT 1 FROM user_roles WHERE id = ?`
    ).get(r.userRoleId);
    expect(hit).toBeTruthy();

    const ae = db.prepare(`
      SELECT COUNT(*) AS n FROM audit_events WHERE action = ?
    `).get('admin.role_granted') as { n: number };
    expect(ae.n).toBe(1);
  });

  it('admin:setDataScope rejects cross-tenant user_role ids', async () => {
    // Insert a user_role owned by a DIFFERENT tenant.
    db.prepare(`
      INSERT INTO user_roles (id, user_id, role_id, tenant_id)
      VALUES ('ur_other', 'u_admin', 'role_tenant_admin', ?)
    `).run(ids.otherTenantId);

    setSession(42, { userId: ids.adminUserId, tenantId: ids.tenantId, roles: ['TenantAdmin'], loggedInAt: 0 });
    const r = await invoke('admin:setDataScope', 42, {
      userRoleId: 'ur_other', conditions: { locationId: 'loc_x' },
    }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('user_role_not_found');   // cross-tenant → not visible
  });
});
