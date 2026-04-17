import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';

vi.mock('electron', () => ({
  app: { getPath: () => tmpUserData },
}));

let tmpUserData = '';

import { makeTestDb, seedAccessGraph } from '../_helpers/db';
import { bootstrapFirstRun, _test } from '../../src/main/db/bootstrap';

/* =========================================================================
 * Bootstrap tests — verify:
 *   • first run provisions Default tenant + SystemAdmin user
 *   • initial credentials are written atomically to userData
 *   • audit chain records the provisioning event
 *   • re-running is a safe no-op (idempotent)
 *   • permission catalog covers every role reference
 * ========================================================================= */

describe('bootstrapFirstRun', () => {
  let db: ReturnType<typeof makeTestDb>;

  beforeEach(() => {
    tmpUserData = mkdtempSync(path.join(os.tmpdir(), 'lh-boot-'));
    db = makeTestDb();
  });

  afterEach(() => {
    db.close();
    try { rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('on a fresh DB seeds tenant + admin user + SystemAdmin role grant and writes credentials', () => {
    const result = bootstrapFirstRun(db);
    expect(result.firstRun).toBe(true);
    expect(result.tenantId).toBe('t_default');
    expect(result.adminUserId).toMatch(/^u_/);
    expect(result.credentialsPath).toMatch(/initial-credentials\.txt$/);

    const tenant = db.prepare('SELECT id, name FROM tenants WHERE id = ?')
      .get(result.tenantId) as { id: string; name: string };
    expect(tenant.name).toBe('Default');

    const admin = db.prepare(`
      SELECT u.status, u.verified, ur.role_id
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
       WHERE u.id = ?
    `).get(result.adminUserId) as { status: string; verified: number; role_id: string };
    expect(admin.status).toBe('active');
    expect(admin.verified).toBe(1);
    expect(admin.role_id).toBe('role_system_admin');

    // Credentials file exists and is readable
    expect(existsSync(result.credentialsPath!)).toBe(true);
    const body = readFileSync(result.credentialsPath!, 'utf8');
    expect(body).toContain('username: admin');
    expect(body).toMatch(/password:\s+\S+/);

    // Chain-audited event produced
    const row = db.prepare(`
      SELECT seq, hash_curr, action FROM audit_events
       WHERE action = 'bootstrap.initial_admin_provisioned' AND tenant_id = ?
    `).get(result.tenantId) as { seq: number; hash_curr: string; action: string };
    expect(row.seq).toBeGreaterThan(0);
    expect(row.hash_curr).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent — calling again returns firstRun=false and doesn\'t duplicate rows', () => {
    bootstrapFirstRun(db);
    const second = bootstrapFirstRun(db);
    expect(second.firstRun).toBe(false);
    const tenants = db.prepare('SELECT COUNT(*) AS n FROM tenants').get() as { n: number };
    expect(tenants.n).toBe(1);
    const admins = db.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE username = 'admin'`,
    ).get() as { n: number };
    expect(admins.n).toBe(1);
  });

  it('ensures permission catalog + roles even on a pre-seeded DB (no first-run)', () => {
    seedAccessGraph(db);
    const result = bootstrapFirstRun(db);
    expect(result.firstRun).toBe(false);

    // All permission codes we guard against must exist.
    const expected = ['system.createTenant', 'tenant.admin', 'review.moderate', 'contract.sign', 'audit.list'];
    for (const code of expected) {
      const hit = db.prepare('SELECT 1 AS ok FROM permissions WHERE code = ?').get(code);
      expect(hit, `missing permission code: ${code}`).toBeTruthy();
    }

    // SystemAdmin should have `system.createTenant`
    const grant = db.prepare(`
      SELECT 1 AS ok FROM role_permissions rp
        JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = 'role_system_admin' AND p.code = 'system.createTenant'
    `).get();
    expect(grant).toBeTruthy();
  });

  it('permission catalog covers every role referenced by registerGuarded', () => {
    // Static snapshot of every permission code referenced from the handler
    // modules.  When a new handler is added its code must appear in
    // PERMISSION_CATALOG — otherwise bootstrap won't grant it to any role
    // and the handler becomes unreachable.
    const catalogCodes = new Set(_test.PERMISSION_CATALOG.map((p) => p.code));
    const expected = [
      'menu.dashboard',
      'analytics.view', 'analytics.export',
      'contract.list', 'contract.create', 'contract.approve',
      'contract.reject', 'contract.sign', 'contract.delete',
      'audit.list', 'audit.export',
      'review.list', 'review.create', 'review.moderate', 'review.reply',
      'routing.view', 'routing.optimize', 'routing.import',
      'tenant.admin', 'system.admin', 'system.createTenant',
      'system.update', 'system.rollback',
    ];
    for (const code of expected) {
      expect(catalogCodes.has(code), `missing ${code} in PERMISSION_CATALOG`).toBe(true);
    }
  });
});
