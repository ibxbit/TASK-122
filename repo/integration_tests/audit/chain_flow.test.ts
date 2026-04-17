import { describe, expect, it } from 'vitest';
import { appendAuditEvent, verifyAuditChain } from '../../src/main/audit/chain';
import { makeTestDb, seedAccessGraph } from '../../unit_tests/_helpers/db';

/* =========================================================================
 *  Audit chain — end-to-end append + verify over hundreds of events.
 * ========================================================================= */

describe('append → verify large chains', () => {
  it('stays intact across 500 events', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    for (let i = 0; i < 500; i++) {
      appendAuditEvent(db, {
        tenantId: ids.tenantId,
        action:   `event.${i % 10}`,
        payload:  { i, actor: 'u_ops' },
        windowKind: 'audit',
      });
    }
    const v = verifyAuditChain(db, ids.tenantId);
    expect(v.ok).toBe(true);
    expect(v.totalEvents).toBe(500);
    expect(v.firstSeq).toBe(1);
    expect(v.lastSeq).toBe(500);
  });

  it('multi-tenant chains are completely independent', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    for (let i = 0; i < 50; i++) {
      appendAuditEvent(db, { tenantId: ids.tenantId,      action: 'a' });
      appendAuditEvent(db, { tenantId: ids.otherTenantId, action: 'b' });
    }
    expect(verifyAuditChain(db, ids.tenantId).ok).toBe(true);
    expect(verifyAuditChain(db, ids.otherTenantId).ok).toBe(true);
  });

  it('head row tracks latest seq + hash per tenant', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    for (let i = 0; i < 3; i++) appendAuditEvent(db, { tenantId: ids.tenantId, action: 'x' });
    const head = db.prepare('SELECT * FROM audit_chain_heads WHERE tenant_id = ?').get(ids.tenantId) as any;
    expect(head.seq).toBe(3);
    expect(head.head_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
