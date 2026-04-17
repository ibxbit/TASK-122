import type { Database } from 'better-sqlite3';

/* =========================================================================
 * Permission Evaluator
 *  - Strict tenant isolation (user.tenant must match requested tenant)
 *  - Explicit deny wins over allow
 *  - ComplianceAuditor is ALWAYS read-only (hard block on write)
 *  - Data scopes merge across user_role grants (OR); empty scope per grant = unrestricted
 *  - Extensible ABAC operators via registerConditionOp()
 * ========================================================================= */

export type PermissionType = 'menu' | 'api' | 'field' | 'resource';
export type Action = 'read' | 'write';

export interface EvalInput {
  userId: string;
  tenantId: string;
  permissionCode: string;
  type: PermissionType;
  action?: Action;              // default 'read'
}

export type ScopeClause = Record<string, unknown>;

export interface ScopeFilter {
  /** OR of AND-clauses.  Empty + unrestricted=false => no data visible. */
  anyOf: ScopeClause[];
  /** True if at least one grant has no scope restriction. */
  unrestricted: boolean;
}

export interface EvalResult {
  allowed: boolean;
  reason: string;
  scope: ScopeFilter;
  roles: string[];
}

const READONLY_ROLES = new Set<string>(['ComplianceAuditor']);

export function evaluate(db: Database, input: EvalInput): EvalResult {
  const action: Action = input.action ?? 'read';

  // 1. Tenant isolation
  const user = db.prepare('SELECT tenant_id, status FROM users WHERE id = ?').get(input.userId) as
    { tenant_id: string; status: string } | undefined;
  if (!user)                               return deny('user_not_found');
  if (user.status !== 'active')            return deny('user_disabled');
  if (user.tenant_id !== input.tenantId)   return deny('tenant_mismatch');

  // 2. Roles the user holds inside this tenant
  const roleRows = db.prepare(`
    SELECT r.code AS code
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ? AND ur.tenant_id = ?
  `).all(input.userId, input.tenantId) as Array<{ code: string }>;
  if (roleRows.length === 0) return deny('no_roles');
  const roles = roleRows.map((r) => r.code);

  // 3. Read-only guard — any read-only role blocks ALL writes for the user
  if (action === 'write' && roles.some((c) => READONLY_ROLES.has(c))) {
    return { allowed: false, reason: 'readonly_role', scope: emptyScope(), roles };
  }

  // 4. Explicit deny wins
  const denied = db.prepare(`
    SELECT 1
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.effect = 'deny'
      JOIN permissions p       ON p.id = rp.permission_id AND p.code = ? AND p.type = ?
     WHERE ur.user_id = ? AND ur.tenant_id = ?
     LIMIT 1
  `).get(input.permissionCode, input.type, input.userId, input.tenantId);
  if (denied) return { allowed: false, reason: 'explicit_deny', scope: emptyScope(), roles };

  // 5. Allow grants + ABAC merge.  LEFT JOIN so a grant with 0 scopes => unrestricted.
  const allowRows = db.prepare(`
    SELECT ur.id AS ur_id, ds.conditions AS conditions
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.effect = 'allow'
      JOIN permissions p       ON p.id = rp.permission_id AND p.code = ? AND p.type = ?
      LEFT JOIN data_scopes ds ON ds.user_role_id = ur.id
     WHERE ur.user_id = ? AND ur.tenant_id = ?
  `).all(input.permissionCode, input.type, input.userId, input.tenantId) as
    Array<{ ur_id: string; conditions: string | null }>;

  if (allowRows.length === 0) {
    return { allowed: false, reason: 'no_permission', scope: emptyScope(), roles };
  }

  // Admin escape — SystemAdmin / TenantAdmin are unrestricted inside the tenant.
  if (roles.includes('SystemAdmin') || roles.includes('TenantAdmin')) {
    return { allowed: true, reason: 'ok', scope: { anyOf: [], unrestricted: true }, roles };
  }

  // Group by user_role_id: if ANY grant has no scope row => unrestricted.
  const grants = new Map<string, ScopeClause[]>();
  for (const r of allowRows) {
    const bucket = grants.get(r.ur_id) ?? [];
    if (r.conditions !== null) bucket.push(safeParse(r.conditions));
    grants.set(r.ur_id, bucket);
  }
  let unrestricted = false;
  const anyOf: ScopeClause[] = [];
  for (const clauses of grants.values()) {
    if (clauses.length === 0) { unrestricted = true; continue; }
    anyOf.push(...clauses);
  }

  return { allowed: true, reason: 'ok', scope: { anyOf, unrestricted }, roles };
}

/* ------------------------------------------------------------------ *
 *  Extensible condition operators for record-level matching           *
 * ------------------------------------------------------------------ */

export type ConditionOp = (recordVal: unknown, clauseVal: unknown) => boolean;

const ops: Record<string, ConditionOp> = {
  eq: (a, b) => a === b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
};

export function registerConditionOp(name: string, fn: ConditionOp): void {
  ops[name] = fn;
}

/** Evaluate a single record against a ScopeFilter (in-memory ABAC check). */
export function recordMatchesScope(record: Record<string, unknown>, filter: ScopeFilter): boolean {
  if (filter.unrestricted) return true;
  if (filter.anyOf.length === 0) return false;
  return filter.anyOf.some((clause) =>
    Object.entries(clause).every(([k, v]) =>
      Array.isArray(v) ? ops.in(record[k], v) : ops.eq(record[k], v)
    )
  );
}

/* ------------------------------------------------------------------ */

function deny(reason: string): EvalResult {
  return { allowed: false, reason, scope: emptyScope(), roles: [] };
}
function emptyScope(): ScopeFilter {
  return { anyOf: [], unrestricted: false };
}
function safeParse(s: string): ScopeClause {
  try { return JSON.parse(s) as ScopeClause; } catch { return {}; }
}
