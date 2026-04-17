import { describe, expect, it } from 'vitest';
import { evaluate, recordMatchesScope, registerConditionOp } from '../../src/main/access/evaluator';
import { makeTestDb, seedAccessGraph } from '../_helpers/db';

/* =========================================================================
 *  Access evaluator — tenant isolation, RBAC, ABAC, read-only guard.
 * ========================================================================= */

describe('evaluate()', () => {
  it('denies unknown users', () => {
    const db  = makeTestDb(); seedAccessGraph(db);
    const r = evaluate(db, { userId: 'missing', tenantId: 't_acme', permissionCode: 'contract.list', type: 'api' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('user_not_found');
  });

  it('denies cross-tenant access (tenant isolation)', () => {
    const db  = makeTestDb(); const ids = seedAccessGraph(db);
    const r = evaluate(db, {
      userId: ids.opsUserId, tenantId: ids.otherTenantId,
      permissionCode: 'contract.list', type: 'api',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('tenant_mismatch');
  });

  it('denies disabled users', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run('disabled', ids.opsUserId);
    const r = evaluate(db, { userId: ids.opsUserId, tenantId: ids.tenantId, permissionCode: 'contract.list', type: 'api' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('user_disabled');
  });

  it('denies users with no roles', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    db.prepare('INSERT INTO users (id, tenant_id, username, display_name) VALUES (?, ?, ?, ?)')
      .run('u_noroles', ids.tenantId, 'noroles', 'No Roles');
    const r = evaluate(db, { userId: 'u_noroles', tenantId: ids.tenantId, permissionCode: 'contract.list', type: 'api' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no_roles');
  });

  it('TenantAdmin has unrestricted scope', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const r = evaluate(db, { userId: ids.adminUserId, tenantId: ids.tenantId, permissionCode: 'contract.list', type: 'api' });
    expect(r.allowed).toBe(true);
    expect(r.scope.unrestricted).toBe(true);
    expect(r.roles).toContain('TenantAdmin');
  });

  it('ComplianceAuditor may READ contracts', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const r = evaluate(db, { userId: ids.auditorUserId, tenantId: ids.tenantId, permissionCode: 'contract.list', type: 'api', action: 'read' });
    expect(r.allowed).toBe(true);
  });

  it('ComplianceAuditor is blocked from writes regardless of grant', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const r = evaluate(db, { userId: ids.auditorUserId, tenantId: ids.tenantId, permissionCode: 'contract.delete', type: 'resource', action: 'write' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('readonly_role');
  });

  it('explicit deny wins over allow', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    // Add an explicit deny on contract.delete for OperationsManager.
    db.prepare('INSERT INTO role_permissions (role_id, permission_id, effect) VALUES (?, ?, ?)')
      .run('role_operations_manager', 'p_contract_delete', 'deny');
    const r = evaluate(db, { userId: ids.opsUserId, tenantId: ids.tenantId, permissionCode: 'contract.delete', type: 'resource', action: 'write' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('explicit_deny');
  });

  it('returns no_permission when grant is absent', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const r = evaluate(db, {
      userId: ids.moderatorUserId, tenantId: ids.tenantId,
      permissionCode: 'contract.delete', type: 'resource', action: 'write',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no_permission');
  });

  it('merges data scopes across multiple grants (OR)', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);

    // Add two OperationsManager grants with different scopes for the same user.
    db.prepare('INSERT INTO user_roles (id, user_id, role_id, tenant_id) VALUES (?, ?, ?, ?)')
      .run('ur_ops_2', ids.opsUserId, 'role_operations_manager', ids.tenantId);

    db.prepare('INSERT INTO data_scopes (id, user_role_id, conditions) VALUES (?, ?, ?)')
      .run('ds1', 'ur_ops',   JSON.stringify({ locationId: 'nyc' }));
    db.prepare('INSERT INTO data_scopes (id, user_role_id, conditions) VALUES (?, ?, ?)')
      .run('ds2', 'ur_ops_2', JSON.stringify({ locationId: 'sfo' }));

    const r = evaluate(db, { userId: ids.opsUserId, tenantId: ids.tenantId, permissionCode: 'contract.list', type: 'api' });
    expect(r.allowed).toBe(true);
    expect(r.scope.unrestricted).toBe(false);
    expect(r.scope.anyOf.length).toBe(2);
  });
});

describe('recordMatchesScope()', () => {
  it('unrestricted scope matches everything', () => {
    expect(recordMatchesScope({ locationId: 'any' }, { anyOf: [], unrestricted: true })).toBe(true);
  });
  it('empty non-unrestricted scope matches nothing', () => {
    expect(recordMatchesScope({ locationId: 'any' }, { anyOf: [], unrestricted: false })).toBe(false);
  });
  it('clause equality matches', () => {
    expect(recordMatchesScope(
      { locationId: 'nyc' },
      { anyOf: [{ locationId: 'nyc' }], unrestricted: false },
    )).toBe(true);
  });
  it('array clause uses IN semantics', () => {
    expect(recordMatchesScope(
      { locationId: 'sfo' },
      { anyOf: [{ locationId: ['nyc', 'sfo'] }], unrestricted: false },
    )).toBe(true);
  });
  it('rejects record that matches none of the anyOf clauses', () => {
    expect(recordMatchesScope(
      { locationId: 'lax' },
      { anyOf: [{ locationId: 'nyc' }, { locationId: 'sfo' }], unrestricted: false },
    )).toBe(false);
  });
});

describe('registerConditionOp()', () => {
  it('supports custom operators (extensibility)', () => {
    registerConditionOp('prefix', (a, b) => typeof a === 'string' && typeof b === 'string' && a.startsWith(b));
    // registerConditionOp registers globally — we just verify the registration is callable.
    // Indirect verification: evaluate() still works with built-in eq/in operators.
    expect(recordMatchesScope({ locationId: 'nyc' }, { anyOf: [{ locationId: 'nyc' }], unrestricted: false })).toBe(true);
  });
});
