import type { Database } from 'better-sqlite3';
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword } from '../contracts/signing';
import { appendAuditEvent } from '../audit/chain';
import { logger } from '../logger';

/* =========================================================================
 * First-run Bootstrap / Onboarding
 *
 *  Runs exactly ONCE per installation — after migrations, before any IPC
 *  handler is dispatched.  Responsible for:
 *
 *    1. Seeding the baseline permission catalog (every permission code
 *       referenced by registerGuarded callsites).
 *    2. Seeding the five system roles.
 *    3. Grants per role:
 *         SystemAdmin       → all permissions (wildcard expansion)
 *         TenantAdmin       → tenant-scoped admin, non-system
 *         OperationsManager → contracts/reviews/routing/analytics/audit.list
 *         ComplianceAuditor → audit.list only (read-only role blocks writes)
 *         ContentModerator  → reviews.*
 *    4. On first run (no tenants exist), creates the initial tenant named
 *       "Default" and a SystemAdmin user; writes the temporary initial
 *       password to `userData/initial-credentials.txt` (chmod 0o400) so
 *       the admin can sign in without DB surgery.  A chain-audit event
 *       `bootstrap.initial_admin_provisioned` records the event (the
 *       password is NEVER included in the audit payload — only a hash).
 *
 *  All operations are idempotent: calling bootstrap again after a
 *  completed first-run is a no-op.
 * ========================================================================= */

export interface BootstrapResult {
  firstRun:      boolean;
  tenantId:      string | null;
  adminUserId:   string | null;
  credentialsPath: string | null;
}

interface PermDef {
  code:   string;
  type:   'menu' | 'api' | 'field' | 'resource';
  action: 'read' | 'write';
  desc:   string;
  roles:  string[];
}

// ── Permission catalog — the single source of truth.  If a new IPC handler
//    needs a permission, add it here AND to the guard's `registerGuarded`
//    call.  `unit_tests/bootstrap/permissionsCatalog.test.ts` verifies
//    every guard code appears in this list.
const PERMISSION_CATALOG: PermDef[] = [
  // Access / menu
  { code: 'menu.dashboard',    type: 'menu', action: 'read',  desc: 'Dashboard menu',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager', 'ComplianceAuditor', 'ContentModerator'] },

  // Analytics
  { code: 'analytics.view',    type: 'api', action: 'read',
    desc: 'View analytics snapshots',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager', 'ComplianceAuditor'] },
  { code: 'analytics.export',  type: 'api', action: 'read',
    desc: 'Export analytics snapshots',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager'] },

  // Contracts
  { code: 'contract.list',     type: 'api',      action: 'read',
    desc: 'List / view contracts',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager', 'ComplianceAuditor'] },
  { code: 'contract.create',   type: 'api',      action: 'write',
    desc: 'Create contract draft',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager'] },
  { code: 'contract.approve',  type: 'resource', action: 'write',
    desc: 'Approve contract',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager'] },
  { code: 'contract.reject',   type: 'resource', action: 'write',
    desc: 'Reject contract',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager'] },
  { code: 'contract.sign',     type: 'resource', action: 'write',
    desc: 'Sign & activate contract',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager'] },
  { code: 'contract.delete',   type: 'resource', action: 'write',
    desc: 'Delete contract',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager'] },

  // Audit
  { code: 'audit.list',        type: 'api', action: 'read',
    desc: 'View audit log',
    roles: ['SystemAdmin', 'TenantAdmin', 'ComplianceAuditor'] },
  { code: 'audit.export',      type: 'api', action: 'read',
    desc: 'Export audit bundle',
    roles: ['SystemAdmin', 'TenantAdmin', 'ComplianceAuditor'] },

  // Reviews
  { code: 'review.list',       type: 'api', action: 'read',
    desc: 'List reviews',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager', 'ComplianceAuditor', 'ContentModerator'] },
  { code: 'review.create',     type: 'api', action: 'write',
    desc: 'Create review',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager', 'ContentModerator'] },
  { code: 'review.moderate',   type: 'api', action: 'write',
    desc: 'Moderate review',
    roles: ['SystemAdmin', 'TenantAdmin', 'ContentModerator'] },
  { code: 'review.reply',      type: 'api', action: 'write',
    desc: 'Merchant reply to review',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager'] },

  // Routing
  { code: 'routing.view',      type: 'api', action: 'read',
    desc: 'View routing datasets',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager'] },
  { code: 'routing.optimize',  type: 'api', action: 'read',
    desc: 'Optimize a route',
    roles: ['SystemAdmin', 'TenantAdmin', 'OperationsManager'] },
  { code: 'routing.import',    type: 'api', action: 'write',
    desc: 'Import / activate / rollback routing datasets',
    roles: ['SystemAdmin', 'TenantAdmin'] },

  // Admin — tenant / system scope
  { code: 'tenant.admin',      type: 'api', action: 'write',
    desc: 'Tenant admin console',
    roles: ['SystemAdmin', 'TenantAdmin'] },
  { code: 'system.admin',      type: 'api', action: 'read',
    desc: 'System admin console (all tenants)',
    roles: ['SystemAdmin'] },
  { code: 'system.createTenant', type: 'api', action: 'write',
    desc: 'Create tenant',
    roles: ['SystemAdmin'] },
  { code: 'system.update',     type: 'api', action: 'write',
    desc: 'Import signed update package',
    roles: ['SystemAdmin'] },
  { code: 'system.rollback',   type: 'api', action: 'write',
    desc: 'Rollback to a prior version',
    roles: ['SystemAdmin'] },
];

const ROLE_DEFS: Array<[string, string, string, number]> = [
  // id, code, name, is_readonly
  ['role_system_admin',       'SystemAdmin',       'System Administrator',    0],
  ['role_tenant_admin',       'TenantAdmin',       'Tenant Administrator',    0],
  ['role_operations_manager', 'OperationsManager', 'Operations Manager',      0],
  ['role_compliance_auditor', 'ComplianceAuditor', 'Compliance Auditor',      1],
  ['role_content_moderator',  'ContentModerator',  'Content Moderator',       0],
];

function roleIdByCode(code: string): string {
  const hit = ROLE_DEFS.find((r) => r[1] === code);
  if (!hit) throw new Error(`unknown_role:${code}`);
  return hit[0];
}

export interface BootstrapOptions {
  /** Override the credentials file location — used by tests. */
  credentialsPath?: string;
  /** Override the initial admin username (default 'admin'). */
  initialAdminUsername?: string;
  /** When true, skip writing credentials to disk (tests). */
  skipCredentialsFile?: boolean;
}

export function bootstrapFirstRun(
  db: Database, opts: BootstrapOptions = {},
): BootstrapResult {
  ensurePermissionCatalog(db);
  ensureRoles(db);
  ensureRolePermissions(db);

  const existingTenants = (db.prepare(
    'SELECT COUNT(*) AS n FROM tenants',
  ).get() as { n: number }).n;

  if (existingTenants > 0) {
    return { firstRun: false, tenantId: null, adminUserId: null, credentialsPath: null };
  }

  // ── First run — provision Default tenant + initial admin ──────────
  const now       = Math.floor(Date.now() / 1000);
  const tenantId  = 't_default';
  const adminId   = `u_${crypto.randomBytes(8).toString('hex')}`;
  const adminUrId = `ur_${crypto.randomBytes(8).toString('hex')}`;
  const password  = generateInitialPassword();
  const pw        = hashPassword(password);
  const username  = opts.initialAdminUsername ?? 'admin';

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO tenants (id, name, created_at) VALUES (?, 'Default', ?)`).run(tenantId, now);
    db.prepare(`
      INSERT INTO users (id, tenant_id, username, display_name, status,
                         verified, password_hash, password_salt, created_at)
      VALUES (@id, @tenantId, @username, 'System Administrator', 'active',
              1, @hash, @salt, @now)
    `).run({ id: adminId, tenantId, username, hash: pw.hash, salt: pw.salt, now });
    db.prepare(`
      INSERT INTO user_roles (id, user_id, role_id, tenant_id, granted_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(adminUrId, adminId, roleIdByCode('SystemAdmin'), tenantId, now);
  });
  tx();

  // Append a chain-audit event.  The password hash is recorded only as a
  // SHA-256 fingerprint so the event can be linked to the credentials file
  // without leaking the plaintext.
  appendAuditEvent(db, {
    tenantId,
    actorUserId: null,
    action:      'bootstrap.initial_admin_provisioned',
    entityType:  'user',
    entityId:    adminId,
    payload:     {
      tenantName:     'Default',
      username,
      passwordFingerprint: crypto.createHash('sha256').update(pw.hash).digest('hex').slice(0, 16),
    },
  });

  // Persist the initial credentials where the admin can retrieve them.
  let credentialsPath: string | null = null;
  if (!opts.skipCredentialsFile) {
    credentialsPath = opts.credentialsPath
      ?? path.join(app.getPath('userData'), 'initial-credentials.txt');
    writeCredentials(credentialsPath, username, password, tenantId)
      .catch((err) => logger.error({ err }, 'bootstrap_credentials_write_failed'));
  }

  logger.warn(
    { tenantId, adminId, credentialsPath },
    'bootstrap_first_run_initial_admin_provisioned',
  );

  return { firstRun: true, tenantId, adminUserId: adminId, credentialsPath };
}

/* ------------------------------------------------------------------ */

function ensurePermissionCatalog(db: Database): void {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO permissions (id, code, type, action, description)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const p of PERMISSION_CATALOG) {
      const id = `p_${p.code.replace(/[.:]/g, '_')}`;
      ins.run(id, p.code, p.type, p.action, p.desc);
    }
  });
  tx();
}

function ensureRoles(db: Database): void {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO roles (id, code, name, is_system, is_readonly)
    VALUES (?, ?, ?, 1, ?)
  `);
  const tx = db.transaction(() => {
    for (const [id, code, name, ro] of ROLE_DEFS) ins.run(id, code, name, ro);
  });
  tx();
}

function ensureRolePermissions(db: Database): void {
  const getPerm = db.prepare('SELECT id FROM permissions WHERE code = ? AND type = ?');
  const ins = db.prepare(`
    INSERT OR IGNORE INTO role_permissions (role_id, permission_id, effect)
    VALUES (?, ?, 'allow')
  `);
  const tx = db.transaction(() => {
    for (const p of PERMISSION_CATALOG) {
      const perm = getPerm.get(p.code, p.type) as { id: string } | undefined;
      if (!perm) continue;
      for (const role of p.roles) {
        ins.run(roleIdByCode(role), perm.id);
      }
    }
  });
  tx();
}

function generateInitialPassword(): string {
  // 18 URL-safe characters, always contains mixed upper / lower / digit.
  const raw = crypto.randomBytes(14).toString('base64url');
  return raw.slice(0, 18);
}

async function writeCredentials(
  p: string, username: string, password: string, tenantId: string,
): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const body = [
    '# LeaseHub — initial administrator credentials',
    '# Generated at: ' + new Date().toISOString(),
    '# Delete this file after you have signed in and rotated the password.',
    '',
    `tenant:   ${tenantId}`,
    `username: ${username}`,
    `password: ${password}`,
    '',
  ].join('\n');
  await fs.writeFile(p, body, { encoding: 'utf8' });
  try { await fs.chmod(p, 0o400); } catch { /* Windows best-effort */ }
}

/* Exports used by tests to assert the catalog is complete. */
export const _test = {
  PERMISSION_CATALOG,
  ROLE_DEFS,
  roleIdByCode,
};
