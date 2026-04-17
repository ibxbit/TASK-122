import { sqliteTable, integer, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { Database } from 'better-sqlite3';

/* =========================================================================
 * Access-Control Schema
 *  - Strict tenant isolation (every user + grant is tenant-scoped)
 *  - Permissions are typed: menu | api | field | resource
 *  - ABAC via data_scopes.conditions (JSON, extensible)
 * ========================================================================= */

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  username: text('username').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => ({
  uqTenantUsername: uniqueIndex('uq_users_tenant_username').on(t.tenantId, t.username),
  ixTenant: index('ix_users_tenant').on(t.tenantId),
}));

export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  code: text('code', {
    enum: ['SystemAdmin', 'TenantAdmin', 'OperationsManager', 'ComplianceAuditor', 'ContentModerator'],
  }).notNull().unique(),
  name: text('name').notNull(),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(true),
  isReadonly: integer('is_readonly', { mode: 'boolean' }).notNull().default(false),
});

export const permissions = sqliteTable('permissions', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),                                  // e.g. 'contract.delete'
  type: text('type', { enum: ['menu', 'api', 'field', 'resource'] }).notNull(),
  action: text('action', { enum: ['read', 'write'] }).notNull().default('read'),
  description: text('description'),
}, (t) => ({
  uqCodeType: uniqueIndex('uq_permissions_code_type').on(t.code, t.type),
}));

export const rolePermissions = sqliteTable('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permissionId: text('permission_id').notNull().references(() => permissions.id, { onDelete: 'cascade' }),
  effect: text('effect', { enum: ['allow', 'deny'] }).notNull().default('allow'),
}, (t) => ({
  pk: uniqueIndex('pk_role_permissions').on(t.roleId, t.permissionId),
}));

export const userRoles = sqliteTable('user_roles', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  grantedAt: integer('granted_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => ({
  uqUserRoleTenant: uniqueIndex('uq_user_roles').on(t.userId, t.roleId, t.tenantId),
  ixTenant: index('ix_user_roles_tenant').on(t.tenantId),
}));

/**
 * ABAC — conditions is a JSON object.  Multiple rows per user_role = OR.
 * Known attributes: locationId, departmentId (scalar or string[]).
 * Additional keys are allowed — evaluator merges via extensible operators.
 */
export const dataScopes = sqliteTable('data_scopes', {
  id: text('id').primaryKey(),
  userRoleId: text('user_role_id').notNull().references(() => userRoles.id, { onDelete: 'cascade' }),
  conditions: text('conditions').notNull(),                     // JSON-encoded
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => ({
  ixUserRole: index('ix_data_scopes_user_role').on(t.userRoleId),
}));

/* ------------------------------------------------------------------ *
 *  Baseline seed — 5 fixed roles.  Idempotent.                       *
 * ------------------------------------------------------------------ */
export function seedAccessBaseline(db: Database): void {
  const upsert = db.prepare(
    'INSERT OR IGNORE INTO roles (id, code, name, is_system, is_readonly) VALUES (?, ?, ?, 1, ?)'
  );
  const seed: Array<[string, string, string, number]> = [
    ['role_system_admin',       'SystemAdmin',       'System Administrator',   0],
    ['role_tenant_admin',       'TenantAdmin',       'Tenant Administrator',   0],
    ['role_operations_manager', 'OperationsManager', 'Operations Manager',     0],
    ['role_compliance_auditor', 'ComplianceAuditor', 'Compliance Auditor',     1],  // read-only
    ['role_content_moderator',  'ContentModerator',  'Content Moderator',      0],
  ];
  const tx = db.transaction((rows: typeof seed) => rows.forEach((r) => upsert.run(...r)));
  tx(seed);
}
