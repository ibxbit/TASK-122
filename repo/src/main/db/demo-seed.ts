import type { Database } from 'better-sqlite3';
import crypto from 'node:crypto';
import { hashPassword } from '../contracts/signing';
import { appendAuditEvent } from '../audit/chain';
import { logger } from '../logger';

/* =========================================================================
 * Deterministic Demo Seed
 *
 *  Populates the Default tenant with ONE user per role and a fixed,
 *  documented password so reviewers can exercise every role without
 *  reading the generated `initial-credentials.txt`.  The seed is
 *  idempotent and opt-in via `LH_DEMO_SEED=1` (the Docker image sets
 *  this by default so `docker-compose up` lands on a fully-usable app).
 *
 *  Demo credentials (tenant = `t_default`):
 *
 *    SystemAdmin       demo_sysadmin   / demo-sysadmin-pass
 *    TenantAdmin       demo_admin      / demo-admin-pass
 *    OperationsManager demo_ops        / demo-ops-pass
 *    ComplianceAuditor demo_auditor    / demo-auditor-pass
 *    ContentModerator  demo_moderator  / demo-moderator-pass
 *
 *  These are advertised in README.md.  Production installs should NOT
 *  set `LH_DEMO_SEED`; the first-run bootstrap handles real provisioning.
 * ========================================================================= */

const DEMO_TENANT_ID = 't_default';

interface DemoUser {
  username:  string;
  password:  string;
  display:   string;
  roleCode:  string;
  roleId:    string;
}

const DEMO_USERS: DemoUser[] = [
  { username: 'demo_sysadmin',   password: 'demo-sysadmin-pass',  display: 'Demo System Administrator',  roleCode: 'SystemAdmin',       roleId: 'role_system_admin' },
  { username: 'demo_admin',      password: 'demo-admin-pass',     display: 'Demo Tenant Administrator',  roleCode: 'TenantAdmin',       roleId: 'role_tenant_admin' },
  { username: 'demo_ops',        password: 'demo-ops-pass',       display: 'Demo Operations Manager',    roleCode: 'OperationsManager', roleId: 'role_operations_manager' },
  { username: 'demo_auditor',    password: 'demo-auditor-pass',   display: 'Demo Compliance Auditor',    roleCode: 'ComplianceAuditor', roleId: 'role_compliance_auditor' },
  { username: 'demo_moderator',  password: 'demo-moderator-pass', display: 'Demo Content Moderator',     roleCode: 'ContentModerator',  roleId: 'role_content_moderator' },
];

export interface DemoSeedResult {
  tenantId:      string;
  createdUsers:  string[];           // userIds inserted on this call
  skippedUsers:  string[];           // usernames that already existed
}

/**
 * Idempotent.  Creates any of DEMO_USERS whose username is not yet
 * present in the Default tenant, and grants the matching role.  Records
 * each creation in the audit chain.  The five credentials above are
 * contractual — do not change them without also updating README.md.
 */
export function seedDemoCredentials(db: Database): DemoSeedResult {
  const created: string[] = [];
  const skipped: string[] = [];

  // The bootstrap() path guarantees the Default tenant + role rows exist
  // before this is called, but we guard defensively.
  const tenantExists = db.prepare('SELECT 1 AS ok FROM tenants WHERE id = ?').get(DEMO_TENANT_ID);
  if (!tenantExists) {
    logger.warn('demo_seed_skipped_no_default_tenant');
    return { tenantId: DEMO_TENANT_ID, createdUsers: [], skippedUsers: DEMO_USERS.map((u) => u.username) };
  }

  const now  = Math.floor(Date.now() / 1000);
  const findUser = db.prepare(
    'SELECT id FROM users WHERE tenant_id = ? AND username = ?',
  );
  const findRole = db.prepare('SELECT id FROM roles WHERE code = ?');
  const insertUser = db.prepare(`
    INSERT INTO users (id, tenant_id, username, display_name, status,
                       verified, password_hash, password_salt, created_at)
    VALUES (@id, @tenantId, @username, @display, 'active',
            1, @hash, @salt, @now)
  `);
  const findGrant = db.prepare(
    'SELECT id FROM user_roles WHERE user_id = ? AND role_id = ? AND tenant_id = ?',
  );
  const insertGrant = db.prepare(`
    INSERT INTO user_roles (id, user_id, role_id, tenant_id, granted_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const u of DEMO_USERS) {
    const existing = findUser.get(DEMO_TENANT_ID, u.username) as { id: string } | undefined;
    const role     = findRole.get(u.roleCode) as { id: string } | undefined;
    if (!role) {
      logger.warn({ roleCode: u.roleCode }, 'demo_seed_role_missing');
      continue;
    }

    let userId: string;
    if (existing) {
      skipped.push(u.username);
      userId = existing.id;
    } else {
      userId = `u_demo_${u.roleCode.toLowerCase()}_${crypto.randomBytes(4).toString('hex')}`;
      const pw = hashPassword(u.password);
      db.transaction(() => {
        insertUser.run({
          id: userId, tenantId: DEMO_TENANT_ID,
          username: u.username, display: u.display,
          hash: pw.hash, salt: pw.salt, now,
        });
      })();
      created.push(userId);

      appendAuditEvent(db, {
        tenantId:    DEMO_TENANT_ID,
        actorUserId: null,
        action:      'demo_seed.user_provisioned',
        entityType:  'user',
        entityId:    userId,
        payload:     { username: u.username, roleCode: u.roleCode },
      });
    }

    // Always ensure the (user, role) grant exists — a user left over
    // from an earlier seed without a grant (e.g. manual DB surgery) is
    // repaired here.
    const grant = findGrant.get(userId, role.id, DEMO_TENANT_ID);
    if (!grant) {
      const urId = `ur_demo_${crypto.randomBytes(6).toString('hex')}`;
      insertGrant.run(urId, userId, role.id, DEMO_TENANT_ID, now);
    }
  }

  return { tenantId: DEMO_TENANT_ID, createdUsers: created, skippedUsers: skipped };
}

/** Exposed for tests that assert the documented shape. */
export const DEMO_CREDENTIALS = DEMO_USERS.map((u) => ({
  username: u.username,
  password: u.password,
  role:     u.roleCode,
  tenant:   DEMO_TENANT_ID,
}));
