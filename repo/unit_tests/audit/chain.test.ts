import { describe, expect, it } from 'vitest';
import { appendAuditEvent, verifyAuditChain } from '../../src/main/audit/chain';
import { makeTestDb, seedAccessGraph } from '../_helpers/db';

/* =========================================================================
 *  Audit hash-chain — canonicalisation, per-tenant sequence, tamper detection.
 * ========================================================================= */

describe('appendAuditEvent()', () => {
  it('seq starts at 1 and increments', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const a = appendAuditEvent(db, { tenantId: ids.tenantId, action: 'a' });
    const b = appendAuditEvent(db, { tenantId: ids.tenantId, action: 'b' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it('links hash_prev to previous hash_curr', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const a = appendAuditEvent(db, { tenantId: ids.tenantId, action: 'a' });
    const b = appendAuditEvent(db, { tenantId: ids.tenantId, action: 'b' });
    expect(a.hash_prev).toBeNull();
    expect(b.hash_prev).toBe(a.hash_curr);
  });

  it('tenant sequences are independent', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const a = appendAuditEvent(db, { tenantId: ids.tenantId,      action: 'a' });
    const b = appendAuditEvent(db, { tenantId: ids.otherTenantId, action: 'b' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
    expect(b.hash_prev).toBeNull();
  });

  it('retain_until is ~7 years past occurred_at', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const at = 1_700_000_000;
    const row = appendAuditEvent(db, { tenantId: ids.tenantId, action: 'x', occurredAt: at });
    const diffYears = (row.retain_until! - at) / (365.25 * 24 * 3600);
    expect(diffYears).toBeGreaterThan(6.95);
    expect(diffYears).toBeLessThan(7.05);
  });

  it('hashes a JSON-stringified payload', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const row = appendAuditEvent(db, {
      tenantId: ids.tenantId, action: 'changed',
      payload: { before: 1, after: 2 },
    });
    expect(row.payload).toBe('{"before":1,"after":2}');
    expect(row.hash_curr).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyAuditChain()', () => {
  it('returns ok=true, totalEvents=0 on an empty chain', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const v = verifyAuditChain(db, ids.tenantId);
    expect(v.ok).toBe(true);
    expect(v.totalEvents).toBe(0);
  });

  it('verifies a healthy chain of many events', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    for (let i = 0; i < 12; i++) {
      appendAuditEvent(db, { tenantId: ids.tenantId, action: `a${i}`, payload: { i } });
    }
    const v = verifyAuditChain(db, ids.tenantId);
    expect(v.ok).toBe(true);
    expect(v.totalEvents).toBe(12);
    expect(v.firstSeq).toBe(1);
    expect(v.lastSeq).toBe(12);
  });

  it('detects hash tampering', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    // Insert three events directly (bypass triggers via a fresh in-memory DB).
    for (let i = 0; i < 3; i++) {
      appendAuditEvent(db, { tenantId: ids.tenantId, action: `a${i}` });
    }
    // Drop and recreate the append-only trigger so we can mutate the row.
    db.exec('DROP TRIGGER IF EXISTS audit_events_no_update');
    db.prepare('UPDATE audit_events SET action = ? WHERE seq = 2 AND tenant_id = ?')
      .run('tampered', ids.tenantId);

    const v = verifyAuditChain(db, ids.tenantId);
    expect(v.ok).toBe(false);
    expect(v.break?.reason).toBe('hash_mismatch');
    expect(v.break?.seq).toBe(2);
  });

  it('detects a broken previous-hash link', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    appendAuditEvent(db, { tenantId: ids.tenantId, action: 'a' });
    const b = appendAuditEvent(db, { tenantId: ids.tenantId, action: 'b' });
    db.exec('DROP TRIGGER IF EXISTS audit_events_no_update');
    db.prepare('UPDATE audit_events SET hash_prev = ? WHERE id = ?')
      .run('0'.repeat(64), b.id);
    const v = verifyAuditChain(db, ids.tenantId);
    expect(v.ok).toBe(false);
    // Either hash_mismatch (hash_curr was recomputed using hash_prev) or prev_mismatch;
    // both indicate a broken chain.
    expect(['hash_mismatch', 'prev_mismatch']).toContain(v.break?.reason);
  });

  it('honours the from/to range filter', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const t0 = 1_700_000_000;
    for (let i = 0; i < 5; i++) {
      appendAuditEvent(db, { tenantId: ids.tenantId, action: `a${i}`, occurredAt: t0 + i * 60 });
    }
    // Range covering events 2, 3 (by index).
    const v = verifyAuditChain(db, ids.tenantId, { from: t0 + 120, to: t0 + 240 });
    expect(v.ok).toBe(true);
    expect(v.totalEvents).toBe(2);
  });
});
