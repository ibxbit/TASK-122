import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* =========================================================================
 * admin:createTenant — authz, validation, audit.
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
import { bootstrapFirstRun } from '../../src/main/db/bootstrap';
import { setSession, clearAllSessions } from '../../src/main/session';
import { registerAdminHandlers } from '../../src/main/ipc/admin.handler';

function invoke(channel: string, senderId: number, payload: unknown = {}): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no_handler_for:${channel}`);
  return fn({ sender: { id: senderId } }, payload);
}

describe('admin:createTenant', () => {
  let db: ReturnType<typeof makeTestDb>;
  let ids: SeededIds;

  beforeEach(() => {
    db = makeTestDb();
    ids = seedAccessGraph(db);
    // Ensure the catalog + grants match production behaviour.
    bootstrapFirstRun(db);
    // Upgrade admin user to SystemAdmin for the positive test path.
    db.prepare(`
      INSERT INTO user_roles (id, user_id, role_id, tenant_id)
      VALUES ('ur_sysadmin', ?, 'role_system_admin', ?)
    `).run(ids.adminUserId, ids.tenantId);

    try { initDbLifecycle({ db }); } catch { /* already initialised */ }
    handlers.clear();
    clearAllSessions();
    registerAdminHandlers();
  });

  afterEach(() => {
    clearAllSessions();
    db.close();
    handlers.clear();
  });

  it('rejects non-SystemAdmin callers', async () => {
    setSession(42, {
      userId: ids.adminUserId, tenantId: ids.tenantId,
      roles: ['TenantAdmin'],   // granted but NOT SystemAdmin
      loggedInAt: 0,
    });
    await expect(
      Promise.resolve(invoke('admin:createTenant', 42, {
        tenantId: 't_alpha', name: 'Alpha',
        initialAdmin: { username: 'alice', displayName: 'Alice', password: 'correcthorse' },
      })),
    ).rejects.toThrow(/access_denied/);
  });

  it('rejects invalid tenant ids', async () => {
    setSession(42, {
      userId: ids.adminUserId, tenantId: ids.tenantId,
      roles: ['SystemAdmin'], loggedInAt: 0,
    });
    const r = await invoke('admin:createTenant', 42, {
      tenantId: 'NOT VALID!', name: 'X',
      initialAdmin: { username: 'a', displayName: 'A', password: 'longenough' },
    }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_tenant_id');
  });

  it('rejects short passwords', async () => {
    setSession(42, {
      userId: ids.adminUserId, tenantId: ids.tenantId,
      roles: ['SystemAdmin'], loggedInAt: 0,
    });
    const r = await invoke('admin:createTenant', 42, {
      tenantId: 't_beta', name: 'Beta',
      initialAdmin: { username: 'b', displayName: 'B', password: 'short' },
    }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('password_too_short');
  });

  it('creates tenant + TenantAdmin + audit chain event', async () => {
    setSession(42, {
      userId: ids.adminUserId, tenantId: ids.tenantId,
      roles: ['SystemAdmin'], loggedInAt: 0,
    });
    const r = await invoke('admin:createTenant', 42, {
      tenantId: 't_omega', name: 'Omega',
      initialAdmin: { username: 'omegadmin', displayName: 'Omega Admin', password: 'strongpassword1' },
    }) as { ok: boolean; tenantId?: string; initialAdminUserId?: string };
    expect(r.ok).toBe(true);
    expect(r.tenantId).toBe('t_omega');

    // Tenant row
    const t = db.prepare('SELECT name FROM tenants WHERE id = ?').get('t_omega') as { name: string };
    expect(t.name).toBe('Omega');

    // Admin user + grant (tenant-scoped)
    const grant = db.prepare(`
      SELECT ur.role_id FROM user_roles ur WHERE ur.user_id = ? AND ur.tenant_id = 't_omega'
    `).get(r.initialAdminUserId) as { role_id: string };
    expect(grant.role_id).toBe('role_tenant_admin');

    // Audit row
    const ae = db.prepare(`
      SELECT seq, action, entity_id FROM audit_events
       WHERE action = 'admin.tenant_created' AND tenant_id = 't_omega'
    `).get() as { seq: number; action: string; entity_id: string };
    expect(ae.entity_id).toBe('t_omega');
    expect(ae.seq).toBeGreaterThan(0);
  });

  it('rejects duplicate tenant ids with tenant_exists', async () => {
    setSession(42, {
      userId: ids.adminUserId, tenantId: ids.tenantId,
      roles: ['SystemAdmin'], loggedInAt: 0,
    });
    const first = await invoke('admin:createTenant', 42, {
      tenantId: 't_dup', name: 'Dup',
      initialAdmin: { username: 'dup', displayName: 'Dup', password: 'longenough1' },
    }) as { ok: boolean };
    expect(first.ok).toBe(true);

    const second = await invoke('admin:createTenant', 42, {
      tenantId: 't_dup', name: 'Dup2',
      initialAdmin: { username: 'dup2', displayName: 'Dup2', password: 'longenough2' },
    }) as { ok: boolean; error?: string };
    expect(second.ok).toBe(false);
    expect(second.error).toBe('tenant_exists');
  });
});
