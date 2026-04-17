import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/* =========================================================================
 * In-memory SQLite builder for tests.
 *
 *   makeTestDb()          — opens :memory:, applies every migration, returns
 *                           the Database and a seed() helper that inserts
 *                           a minimal tenant/user/roles graph.
 *
 * The file is consumed by both unit and integration tests, so it sits under
 * unit_tests/_helpers/ and is imported from integration_tests/ as well.
 * ========================================================================= */

export interface SeededIds {
  tenantId:      string;
  otherTenantId: string;
  adminUserId:   string;
  opsUserId:     string;
  auditorUserId: string;
  moderatorUserId: string;
}

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/main/db/migrations');

export function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    db.exec(sql);
  }
  return db;
}

/**
 * Seed a small tenant graph: two tenants, five users (one per role),
 * role rows, and user_role grants.  Returns the generated ids so tests can
 * assert against known values.
 */
export function seedAccessGraph(db: Database.Database): SeededIds {
  const ids: SeededIds = {
    tenantId:        't_acme',
    otherTenantId:   't_other',
    adminUserId:     'u_admin',
    opsUserId:       'u_ops',
    auditorUserId:   'u_audit',
    moderatorUserId: 'u_mod',
  };

  db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run(ids.tenantId, 'Acme');
  db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run(ids.otherTenantId, 'Other');

  // Baseline roles from migration 0001 — upsert so tests are idempotent.
  const insRole = db.prepare(`
    INSERT OR IGNORE INTO roles (id, code, name, is_system, is_readonly)
    VALUES (?, ?, ?, 1, ?)
  `);
  const seed: Array<[string, string, string, number]> = [
    ['role_system_admin',       'SystemAdmin',       'System Administrator',   0],
    ['role_tenant_admin',       'TenantAdmin',       'Tenant Administrator',   0],
    ['role_operations_manager', 'OperationsManager', 'Operations Manager',     0],
    ['role_compliance_auditor', 'ComplianceAuditor', 'Compliance Auditor',     1],
    ['role_content_moderator',  'ContentModerator',  'Content Moderator',      0],
  ];
  for (const r of seed) insRole.run(...r);

  const insUser = db.prepare(`
    INSERT INTO users (id, tenant_id, username, display_name, status) VALUES (?, ?, ?, ?, 'active')
  `);
  insUser.run(ids.adminUserId,     ids.tenantId, 'admin',     'Admin');
  insUser.run(ids.opsUserId,       ids.tenantId, 'ops',       'Ops Manager');
  insUser.run(ids.auditorUserId,   ids.tenantId, 'auditor',   'Compliance Auditor');
  insUser.run(ids.moderatorUserId, ids.tenantId, 'moderator', 'Content Moderator');

  const insUR = db.prepare(`
    INSERT INTO user_roles (id, user_id, role_id, tenant_id) VALUES (?, ?, ?, ?)
  `);
  insUR.run('ur_admin', ids.adminUserId,     'role_tenant_admin',        ids.tenantId);
  insUR.run('ur_ops',   ids.opsUserId,       'role_operations_manager',  ids.tenantId);
  insUR.run('ur_aud',   ids.auditorUserId,   'role_compliance_auditor',  ids.tenantId);
  insUR.run('ur_mod',   ids.moderatorUserId, 'role_content_moderator',   ids.tenantId);

  // Minimal permission catalog the tests reference.
  const insPerm = db.prepare(`
    INSERT INTO permissions (id, code, type, action, description) VALUES (?, ?, ?, ?, ?)
  `);
  insPerm.run('p_contract_list',   'contract.list',   'api',      'read',  'List contracts');
  insPerm.run('p_contract_delete', 'contract.delete', 'resource', 'write', 'Delete contract');
  insPerm.run('p_review_moderate', 'review.moderate', 'api',      'write', 'Moderate reviews');

  // OperationsManager: allow list + delete (no scope = unrestricted within tenant)
  // TenantAdmin:       allow list + delete
  // ComplianceAuditor: allow list ONLY (read-only role blocks all writes)
  // ContentModerator:  allow review.moderate
  const insRP = db.prepare('INSERT INTO role_permissions (role_id, permission_id, effect) VALUES (?, ?, ?)');
  insRP.run('role_tenant_admin',       'p_contract_list',   'allow');
  insRP.run('role_tenant_admin',       'p_contract_delete', 'allow');
  insRP.run('role_operations_manager', 'p_contract_list',   'allow');
  insRP.run('role_operations_manager', 'p_contract_delete', 'allow');
  insRP.run('role_compliance_auditor', 'p_contract_list',   'allow');
  insRP.run('role_compliance_auditor', 'p_contract_delete', 'allow');   // writes blocked by readonly
  insRP.run('role_content_moderator',  'p_review_moderate', 'allow');

  return ids;
}
