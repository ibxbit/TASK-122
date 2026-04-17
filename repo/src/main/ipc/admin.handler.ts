import crypto from 'node:crypto';
import { registerGuarded, AccessDeniedError } from '../access/enforce';
import { getDb } from '../db';
import { hashPassword } from '../contracts/signing';
import { appendAuditEvent } from '../audit/chain';

/* =========================================================================
 * Admin IPC Handlers — tenant / user / role-grant / data-scope management.
 *
 *   admin:listTenants           TenantAdmin+  list tenants (system admins only see all)
 *   admin:listUsers             TenantAdmin+  users in the caller's tenant
 *   admin:createUser            TenantAdmin+  provision a new user (with password)
 *   admin:disableUser           TenantAdmin+  soft-disable a user (blocks login)
 *   admin:resetPassword         TenantAdmin+  force-reset password (admin-set)
 *   admin:grantRole             TenantAdmin+  grant (user, role) in current tenant
 *   admin:revokeRole            TenantAdmin+  revoke a grant
 *   admin:setDataScope          TenantAdmin+  set ABAC scope JSON for a user_role
 *   admin:policies              TenantAdmin+  list active sensitive_words (moderation policy)
 *   admin:addPolicyWord         TenantAdmin+  extend moderation dictionary
 *   admin:removePolicyWord      TenantAdmin+  retire a word
 *
 *   These are system-level operations — guarded by `system.admin` or
 *   `tenant.admin` permissions AND the underlying role check
 *   (TenantAdmin / SystemAdmin).  Every action is chain-audited.
 * ========================================================================= */

interface CreateTenantPayload {
  tenantId:       string;
  name:           string;
  initialAdmin:   { username: string; displayName: string; password: string; govIdLast4?: string };
}
interface ListPayload        { limit?: number; offset?: number; }
interface CreateUserPayload  {
  username:     string;
  displayName:  string;
  password:     string;
  verified?:    boolean;
  govIdLast4?:  string;
}
interface DisableUserPayload { userId: string; }
interface ResetPasswordPayload { userId: string; newPassword: string; }
interface GrantRolePayload   { userId: string; roleCode: string; }
interface RevokeRolePayload  { userRoleId: string; }
interface SetScopePayload    { userRoleId: string; conditions: Record<string, unknown>; }
interface AddWordPayload     { word: string; severity: 'soft'|'flag'|'block'; category?: string; }
interface RemoveWordPayload  { id: string; }

function requireAdmin(roles: string[], channel: string): void {
  if (!roles.includes('TenantAdmin') && !roles.includes('SystemAdmin')) {
    throw new AccessDeniedError('role_not_admin', channel);
  }
}

function requireSystemAdmin(roles: string[], channel: string): void {
  if (!roles.includes('SystemAdmin')) {
    throw new AccessDeniedError('role_not_system_admin', channel);
  }
}

const TENANT_ID_RE = /^[a-z0-9_][a-z0-9_\-]{1,47}$/;

export function registerAdminHandlers(): void {
  // ── admin:createTenant (SystemAdmin only) ────────────────────────────
  registerGuarded<CreateTenantPayload, unknown>(
    'admin:createTenant',
    { permission: 'system.createTenant', type: 'api', action: 'write' },
    (ctx, payload) => {
      requireSystemAdmin(ctx.roles, 'admin:createTenant');

      const { tenantId, name, initialAdmin } = payload;
      if (!tenantId || !name || !initialAdmin?.username || !initialAdmin?.displayName
          || !initialAdmin?.password) {
        return { ok: false, error: 'missing_fields' };
      }
      if (!TENANT_ID_RE.test(tenantId)) {
        return { ok: false, error: 'invalid_tenant_id' };
      }
      if (initialAdmin.password.length < 8) {
        return { ok: false, error: 'password_too_short' };
      }

      const db  = getDb();
      const now = Math.floor(Date.now() / 1000);
      const pw  = hashPassword(initialAdmin.password);
      const adminId = `u_${crypto.randomBytes(8).toString('hex')}`;
      const urId    = `ur_${crypto.randomBytes(8).toString('hex')}`;

      try {
        db.transaction(() => {
          db.prepare(`INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)`)
            .run(tenantId, name, now);
          db.prepare(`
            INSERT INTO users
              (id, tenant_id, username, display_name, status,
               verified, gov_id_last4, password_hash, password_salt, created_at)
            VALUES
              (@id, @tenantId, @username, @displayName, 'active',
               1, @govIdLast4, @hash, @salt, @now)
          `).run({
            id:          adminId,
            tenantId,
            username:    initialAdmin.username,
            displayName: initialAdmin.displayName,
            govIdLast4:  initialAdmin.govIdLast4 ?? null,
            hash:        pw.hash,
            salt:        pw.salt,
            now,
          });
          db.prepare(`
            INSERT INTO user_roles (id, user_id, role_id, tenant_id, granted_at)
            VALUES (?, ?, 'role_tenant_admin', ?, ?)
          `).run(urId, adminId, tenantId, now);
        })();
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
            || (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return { ok: false, error: 'tenant_exists' };
        }
        throw err;
      }

      appendAuditEvent(db, {
        tenantId,
        actorUserId: ctx.userId,
        action:      'admin.tenant_created',
        entityType:  'tenant',
        entityId:    tenantId,
        payload:     { name, initialAdminUserId: adminId, initialAdminUsername: initialAdmin.username },
      });

      return { ok: true, tenantId, initialAdminUserId: adminId };
    },
  );

  // ── admin:listTenants ────────────────────────────────────────────────
  registerGuarded<Record<string, never>, unknown[]>(
    'admin:listTenants',
    { permission: 'system.admin', type: 'api', action: 'read' },
    (ctx) => {
      const db = getDb();
      // Only SystemAdmin sees all tenants; TenantAdmin sees only their own.
      if (ctx.roles.includes('SystemAdmin')) {
        return db.prepare(`SELECT id, name, created_at AS createdAt FROM tenants ORDER BY name`).all();
      }
      return db.prepare(`
        SELECT id, name, created_at AS createdAt FROM tenants WHERE id = ?
      `).all(ctx.tenantId);
    },
  );

  // ── admin:listUsers ──────────────────────────────────────────────────
  registerGuarded<ListPayload, unknown[]>(
    'admin:listUsers',
    { permission: 'tenant.admin', type: 'api', action: 'read' },
    (ctx, payload) => {
      requireAdmin(ctx.roles, 'admin:listUsers');
      const limit  = Math.min(payload.limit ?? 200, 1000);
      const offset = payload.offset ?? 0;
      return getDb().prepare(`
        SELECT id, username, display_name AS displayName, status,
               verified, gov_id_last4 AS govIdLast4,
               created_at AS createdAt
          FROM users
         WHERE tenant_id = @tenantId
         ORDER BY username
         LIMIT @limit OFFSET @offset
      `).all({ tenantId: ctx.tenantId, limit, offset });
    },
  );

  // ── admin:createUser ─────────────────────────────────────────────────
  registerGuarded<CreateUserPayload, unknown>(
    'admin:createUser',
    { permission: 'tenant.admin', type: 'api', action: 'write' },
    (ctx, payload) => {
      requireAdmin(ctx.roles, 'admin:createUser');
      if (!payload.username || !payload.displayName || !payload.password) {
        return { ok: false, error: 'missing_fields' };
      }
      if (payload.password.length < 8) {
        return { ok: false, error: 'password_too_short' };
      }

      const db  = getDb();
      const id  = `u_${crypto.randomBytes(8).toString('hex')}`;
      const pw  = hashPassword(payload.password);
      const now = Math.floor(Date.now() / 1000);

      try {
        db.prepare(`
          INSERT INTO users
            (id, tenant_id, username, display_name, status,
             verified, gov_id_last4, password_hash, password_salt, created_at)
          VALUES
            (@id, @tenantId, @username, @displayName, 'active',
             @verified, @govIdLast4, @hash, @salt, @now)
        `).run({
          id,
          tenantId:    ctx.tenantId,
          username:    payload.username,
          displayName: payload.displayName,
          verified:    payload.verified ? 1 : 0,
          govIdLast4:  payload.govIdLast4 ?? null,
          hash:        pw.hash,
          salt:        pw.salt,
          now,
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return { ok: false, error: 'username_taken' };
        }
        throw err;
      }

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'admin.user_created',
        entityType:  'user',
        entityId:    id,
        payload:     { username: payload.username, displayName: payload.displayName },
      });
      return { ok: true, userId: id };
    },
  );

  // ── admin:disableUser ────────────────────────────────────────────────
  registerGuarded<DisableUserPayload, unknown>(
    'admin:disableUser',
    { permission: 'tenant.admin', type: 'api', action: 'write' },
    (ctx, payload) => {
      requireAdmin(ctx.roles, 'admin:disableUser');
      if (payload.userId === ctx.userId) {
        return { ok: false, error: 'cannot_disable_self' };
      }
      const db = getDb();
      const info = db.prepare(`
        UPDATE users SET status = 'disabled'
         WHERE id = @id AND tenant_id = @tenantId
      `).run({ id: payload.userId, tenantId: ctx.tenantId });

      if (info.changes === 0) return { ok: false, error: 'user_not_found' };

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'admin.user_disabled',
        entityType:  'user',
        entityId:    payload.userId,
      });
      return { ok: true };
    },
  );

  // ── admin:resetPassword ──────────────────────────────────────────────
  registerGuarded<ResetPasswordPayload, unknown>(
    'admin:resetPassword',
    { permission: 'tenant.admin', type: 'api', action: 'write' },
    (ctx, payload) => {
      requireAdmin(ctx.roles, 'admin:resetPassword');
      if (!payload.newPassword || payload.newPassword.length < 8) {
        return { ok: false, error: 'password_too_short' };
      }
      const db = getDb();
      const pw = hashPassword(payload.newPassword);

      const info = db.prepare(`
        UPDATE users
           SET password_hash = @hash, password_salt = @salt
         WHERE id = @id AND tenant_id = @tenantId
      `).run({ hash: pw.hash, salt: pw.salt, id: payload.userId, tenantId: ctx.tenantId });

      if (info.changes === 0) return { ok: false, error: 'user_not_found' };

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'admin.password_reset',
        entityType:  'user',
        entityId:    payload.userId,
      });
      return { ok: true };
    },
  );

  // ── admin:grantRole ──────────────────────────────────────────────────
  registerGuarded<GrantRolePayload, unknown>(
    'admin:grantRole',
    { permission: 'tenant.admin', type: 'api', action: 'write' },
    (ctx, payload) => {
      requireAdmin(ctx.roles, 'admin:grantRole');
      const db   = getDb();
      const role = db.prepare(`SELECT id FROM roles WHERE code = ?`).get(payload.roleCode) as
        { id: string } | undefined;
      if (!role) return { ok: false, error: 'role_not_found' };

      const user = db.prepare(`SELECT id FROM users WHERE id = ? AND tenant_id = ?`).get(
        payload.userId, ctx.tenantId,
      );
      if (!user) return { ok: false, error: 'user_not_found' };

      const urId = `ur_${crypto.randomBytes(8).toString('hex')}`;
      try {
        db.prepare(`
          INSERT INTO user_roles (id, user_id, role_id, tenant_id)
          VALUES (@id, @userId, @roleId, @tenantId)
        `).run({ id: urId, userId: payload.userId, roleId: role.id, tenantId: ctx.tenantId });
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return { ok: false, error: 'role_already_granted' };
        }
        throw err;
      }

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'admin.role_granted',
        entityType:  'user_role',
        entityId:    urId,
        payload:     { userId: payload.userId, roleCode: payload.roleCode },
      });
      return { ok: true, userRoleId: urId };
    },
  );

  // ── admin:revokeRole ─────────────────────────────────────────────────
  registerGuarded<RevokeRolePayload, unknown>(
    'admin:revokeRole',
    { permission: 'tenant.admin', type: 'api', action: 'write' },
    (ctx, payload) => {
      requireAdmin(ctx.roles, 'admin:revokeRole');
      const db = getDb();
      const info = db.prepare(`
        DELETE FROM user_roles WHERE id = @id AND tenant_id = @tenantId
      `).run({ id: payload.userRoleId, tenantId: ctx.tenantId });
      if (info.changes === 0) return { ok: false, error: 'grant_not_found' };

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'admin.role_revoked',
        entityType:  'user_role',
        entityId:    payload.userRoleId,
      });
      return { ok: true };
    },
  );

  // ── admin:setDataScope ───────────────────────────────────────────────
  registerGuarded<SetScopePayload, unknown>(
    'admin:setDataScope',
    { permission: 'tenant.admin', type: 'api', action: 'write' },
    (ctx, payload) => {
      requireAdmin(ctx.roles, 'admin:setDataScope');
      const db = getDb();

      // Verify the user_role belongs to this tenant (tenant isolation)
      const ur = db.prepare(`
        SELECT id FROM user_roles WHERE id = @id AND tenant_id = @tenantId
      `).get({ id: payload.userRoleId, tenantId: ctx.tenantId });
      if (!ur) return { ok: false, error: 'user_role_not_found' };

      const id  = `ds_${crypto.randomBytes(8).toString('hex')}`;
      const now = Math.floor(Date.now() / 1000);

      db.transaction(() => {
        db.prepare(`DELETE FROM data_scopes WHERE user_role_id = ?`).run(payload.userRoleId);
        db.prepare(`
          INSERT INTO data_scopes (id, user_role_id, conditions, created_at)
          VALUES (@id, @userRoleId, @conditions, @now)
        `).run({
          id, userRoleId: payload.userRoleId,
          conditions: JSON.stringify(payload.conditions ?? {}),
          now,
        });
      })();

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'admin.data_scope_set',
        entityType:  'user_role',
        entityId:    payload.userRoleId,
        payload:     { conditions: payload.conditions },
      });
      return { ok: true, dataScopeId: id };
    },
  );

  // ── admin:policies ───────────────────────────────────────────────────
  registerGuarded<Record<string, never>, unknown[]>(
    'admin:policies',
    { permission: 'tenant.admin', type: 'api', action: 'read' },
    (ctx) => {
      requireAdmin(ctx.roles, 'admin:policies');
      return getDb().prepare(`
        SELECT id, word, severity, category, active, created_at AS createdAt
          FROM sensitive_words
         WHERE tenant_id = @tenantId AND active = 1
         ORDER BY severity, word
      `).all({ tenantId: ctx.tenantId });
    },
  );

  // ── admin:addPolicyWord ──────────────────────────────────────────────
  registerGuarded<AddWordPayload, unknown>(
    'admin:addPolicyWord',
    { permission: 'tenant.admin', type: 'api', action: 'write' },
    (ctx, payload) => {
      requireAdmin(ctx.roles, 'admin:addPolicyWord');
      if (!payload.word || !['soft','flag','block'].includes(payload.severity)) {
        return { ok: false, error: 'invalid_input' };
      }
      const db = getDb();
      const id = `sw_${crypto.randomBytes(8).toString('hex')}`;
      try {
        db.prepare(`
          INSERT INTO sensitive_words (id, tenant_id, word, severity, category, active)
          VALUES (@id, @tenantId, @word, @severity, @category, 1)
        `).run({
          id, tenantId: ctx.tenantId,
          word:     payload.word.toLowerCase(),
          severity: payload.severity,
          category: payload.category ?? null,
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return { ok: false, error: 'word_exists' };
        }
        throw err;
      }

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'admin.policy_word_added',
        entityType:  'sensitive_word',
        entityId:    id,
        payload:     { word: payload.word, severity: payload.severity },
      });
      return { ok: true, id };
    },
  );

  // ── admin:removePolicyWord ───────────────────────────────────────────
  registerGuarded<RemoveWordPayload, unknown>(
    'admin:removePolicyWord',
    { permission: 'tenant.admin', type: 'api', action: 'write' },
    (ctx, payload) => {
      requireAdmin(ctx.roles, 'admin:removePolicyWord');
      const db = getDb();
      const info = db.prepare(`
        UPDATE sensitive_words SET active = 0
         WHERE id = @id AND tenant_id = @tenantId
      `).run({ id: payload.id, tenantId: ctx.tenantId });
      if (info.changes === 0) return { ok: false, error: 'not_found' };

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'admin.policy_word_removed',
        entityType:  'sensitive_word',
        entityId:    payload.id,
      });
      return { ok: true };
    },
  );
}
