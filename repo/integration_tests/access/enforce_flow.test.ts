import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/main/access/evaluator';
import { makeTestDb, seedAccessGraph } from '../../unit_tests/_helpers/db';

/* =========================================================================
 *  Access enforcement — simulates the gates registerGuarded applies before
 *  running an IPC handler.  Verifies the precedence rules end-to-end on a
 *  seeded RBAC graph.
 * ========================================================================= */

describe('evaluator precedence', () => {
  it('TenantAdmin > OperationsManager > ComplianceAuditor', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const asAdmin   = evaluate(db, { userId: ids.adminUserId,   tenantId: ids.tenantId, permissionCode: 'contract.list', type: 'api' });
    const asOps     = evaluate(db, { userId: ids.opsUserId,     tenantId: ids.tenantId, permissionCode: 'contract.list', type: 'api' });
    const asAuditor = evaluate(db, { userId: ids.auditorUserId, tenantId: ids.tenantId, permissionCode: 'contract.list', type: 'api' });

    expect(asAdmin.allowed).toBe(true);
    expect(asAdmin.scope.unrestricted).toBe(true);
    expect(asOps.allowed).toBe(true);
    expect(asAuditor.allowed).toBe(true);
  });

  it('write permission denied to ComplianceAuditor even when granted', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const r = evaluate(db, {
      userId: ids.auditorUserId, tenantId: ids.tenantId,
      permissionCode: 'contract.delete', type: 'resource', action: 'write',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('readonly_role');
  });

  it('explicit deny beats ABAC merge', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);

    // Grant allow with scope + add an explicit deny.
    db.prepare('INSERT INTO data_scopes (id, user_role_id, conditions) VALUES (?, ?, ?)')
      .run('ds1', 'ur_ops', JSON.stringify({ locationId: 'nyc' }));
    db.prepare('INSERT INTO role_permissions (role_id, permission_id, effect) VALUES (?, ?, ?)')
      .run('role_operations_manager', 'p_contract_delete', 'deny');

    const r = evaluate(db, {
      userId: ids.opsUserId, tenantId: ids.tenantId,
      permissionCode: 'contract.delete', type: 'resource', action: 'write',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('explicit_deny');
  });
});
