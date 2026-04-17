import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

import { makeTestDb } from '../_helpers/db';
import { bootstrapFirstRun } from '../../src/main/db/bootstrap';
import { seedDemoCredentials, DEMO_CREDENTIALS } from '../../src/main/db/demo-seed';

/* =========================================================================
 * seedDemoCredentials — deterministic demo accounts (one per role).
 *
 *  Verifies:
 *    • Every DEMO_CREDENTIALS entry lands as an active user with the
 *      correct role grant.
 *    • Passwords hashed with PBKDF2-SHA256 match the documented value.
 *    • Re-running the seeder is a safe no-op (skippedUsers populated).
 *    • Missing Default tenant → the seeder returns cleanly without throw.
 *    • A chain-audit event `demo_seed.user_provisioned` is produced for
 *      each newly-inserted user.
 * ========================================================================= */

const PBKDF2_ITER = 100_000;
const PBKDF2_KEYLEN = 32;
function verifyPw(plain: string, hashHex: string, saltHex: string): boolean {
  const derived = crypto.pbkdf2Sync(
    plain, Buffer.from(saltHex, 'hex'),
    PBKDF2_ITER, PBKDF2_KEYLEN, 'sha256',
  );
  const known = Buffer.from(hashHex, 'hex');
  return derived.length === known.length && crypto.timingSafeEqual(derived, known);
}

describe('seedDemoCredentials', () => {
  let db: ReturnType<typeof makeTestDb>;

  beforeEach(() => {
    db = makeTestDb();
    // bootstrap creates the Default tenant + role catalog
    bootstrapFirstRun(db, { skipCredentialsFile: true });
  });
  afterEach(() => { db.close(); });

  it('creates all five demo users, each with correct role grant and password', () => {
    const r = seedDemoCredentials(db);
    expect(r.createdUsers.length).toBe(5);
    expect(r.skippedUsers).toEqual([]);

    for (const cred of DEMO_CREDENTIALS) {
      const u = db.prepare(`
        SELECT id, status, password_hash, password_salt
          FROM users WHERE tenant_id = ? AND username = ?
      `).get(cred.tenant, cred.username) as
        { id: string; status: string; password_hash: string; password_salt: string } | undefined;
      expect(u, `missing demo user ${cred.username}`).toBeDefined();
      expect(u!.status).toBe('active');
      expect(verifyPw(cred.password, u!.password_hash, u!.password_salt)).toBe(true);

      const grant = db.prepare(`
        SELECT r.code FROM user_roles ur
          JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = ? AND ur.tenant_id = ?
      `).get(u!.id, cred.tenant) as { code: string } | undefined;
      expect(grant?.code).toBe(cred.role);
    }

    // Exactly 5 chain-audit rows
    const auditCount = db.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'demo_seed.user_provisioned'`,
    ).get() as { n: number };
    expect(auditCount.n).toBe(5);
  });

  it('is idempotent — re-running seeds zero new users', () => {
    seedDemoCredentials(db);
    const second = seedDemoCredentials(db);
    expect(second.createdUsers).toEqual([]);
    expect(second.skippedUsers.length).toBe(5);
  });

  it('repairs a pre-existing demo user with no role grant', () => {
    // Pre-insert a demo user WITHOUT a grant
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO users (id, tenant_id, username, display_name, status, verified,
                         password_hash, password_salt, created_at)
      VALUES ('u_manual', 't_default', 'demo_admin', 'Manual', 'active', 1,
              'aa', 'bb', ?)
    `).run(now);

    const r = seedDemoCredentials(db);
    expect(r.skippedUsers).toContain('demo_admin');

    const grant = db.prepare(`
      SELECT r.code FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = 'u_manual'
    `).get() as { code: string } | undefined;
    expect(grant?.code).toBe('TenantAdmin');
  });

  it('returns early with skippedUsers when the Default tenant is missing', () => {
    // Wipe the tenant.  Bootstrap left audit_events with tenant_id='t_default'
    // and those rows cannot be removed (audit_events is append-only by
    // trigger).  Disable FK enforcement for the teardown so the orphan
    // audit rows are acceptable — the seeder's guard only inspects
    // tenants(id), which is what the test is exercising.
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM user_roles WHERE tenant_id = ?').run('t_default');
    db.prepare('DELETE FROM users      WHERE tenant_id = ?').run('t_default');
    db.prepare('DELETE FROM tenants    WHERE id = ?').run('t_default');
    db.pragma('foreign_keys = ON');

    const r = seedDemoCredentials(db);
    expect(r.createdUsers).toEqual([]);
    expect(r.skippedUsers.length).toBe(5);
  });

  it('DEMO_CREDENTIALS lines up with README.md (ids, passwords, tenant)', () => {
    const names = DEMO_CREDENTIALS.map((c) => c.username).sort();
    expect(names).toEqual([
      'demo_admin', 'demo_auditor', 'demo_moderator', 'demo_ops', 'demo_sysadmin',
    ]);
    for (const c of DEMO_CREDENTIALS) {
      expect(c.password.startsWith('demo-')).toBe(true);
      expect(c.tenant).toBe('t_default');
    }
  });
});
