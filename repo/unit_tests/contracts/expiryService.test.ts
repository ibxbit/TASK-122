import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* =========================================================================
 * expiry-service — the reminder pipeline wired to broadcast + tray badge.
 *
 *  Tests exercise the REAL service against a seeded in-memory DB.  We
 *  verify:
 *    - scanNow broadcasts one 'contracts:expiry_notification' per fired milestone
 *    - tray badge count increments per notification
 *    - an audit event is appended (chain producer path)
 *    - scheduler job spec is a daily job
 * ========================================================================= */

import { makeTestDb, seedAccessGraph, type SeededIds } from '../_helpers/db';
import { ExpiryService } from '../../src/main/contracts/expiry-service';

describe('ExpiryService — scheduler wiring + broadcast + audit chain', () => {
  let db: ReturnType<typeof makeTestDb>;
  let ids: SeededIds;

  beforeEach(() => {
    db = makeTestDb();
    ids = seedAccessGraph(db);
    // Seed template + active contract expiring in 6 days (triggers expiry_7)
    db.prepare(`
      INSERT INTO contract_templates (id, tenant_id, code, name, version, body, variables, status, published_at, created_at, updated_at)
      VALUES ('tpl_1', ?, 'LEASE', 'Lease', 1, '', '{}', 'published', 0, 0, 0)
    `).run(ids.tenantId);

    const now = Math.floor(Date.now() / 1000);
    const expire = now + 6 * 86400;
    db.prepare(`
      INSERT INTO contract_instances
        (id, tenant_id, template_id, instance_number, counterparty_user_id,
         status, rendered_body, variables, effective_from, effective_to, created_at, updated_at)
      VALUES ('ci_1', ?, 'tpl_1', 'C-1', ?, 'active', '', '{}', ?, ?, 0, 0)
    `).run(ids.tenantId, ids.adminUserId, now, expire);
  });

  afterEach(() => {
    db.close();
  });

  it('scanNow broadcasts expiry notification + increments tray badge + appends audit event', () => {
    const broadcasts: Array<{ ch: string; payload: unknown }> = [];
    const badgeCalls: number[] = [];
    const svc = new ExpiryService(db, {
      broadcast:   (ch, payload) => broadcasts.push({ ch, payload }),
      onTrayBadge: (c) => badgeCalls.push(c),
    });

    const res = svc.scanNow();
    expect(res.fired).toBeGreaterThan(0);

    const notif = broadcasts.find((b) => b.ch === 'contracts:expiry_notification');
    expect(notif).toBeDefined();
    expect((notif!.payload as { kind: string }).kind).toBe('expiry_7');

    expect(badgeCalls.length).toBeGreaterThan(0);
    expect(badgeCalls[badgeCalls.length - 1]).toBeGreaterThan(0);

    // Audit event appended through the chain producer
    const ae = db.prepare(`
      SELECT COUNT(*) AS n, MIN(seq) AS firstSeq, MAX(seq) AS lastSeq
        FROM audit_events
       WHERE action = 'contract.expiry_notified' AND tenant_id = ?
    `).get(ids.tenantId) as { n: number; firstSeq: number | null; lastSeq: number | null };
    expect(ae.n).toBeGreaterThan(0);
    expect(ae.firstSeq).not.toBeNull();
    expect(ae.lastSeq).not.toBeNull();
  });

  it('scan dedupes — repeat runs do not re-fire the same milestone', () => {
    const svc = new ExpiryService(db, { broadcast: () => {} });
    const first  = svc.scanNow();
    const second = svc.scanNow();
    expect(first.fired).toBeGreaterThan(0);
    expect(second.fired).toBe(0);
  });

  it('clearBadge resets tray badge count', () => {
    const badges: number[] = [];
    const svc = new ExpiryService(db, { broadcast: () => {}, onTrayBadge: (n) => badges.push(n) });
    svc.scanNow();
    svc.clearBadge();
    expect(badges[badges.length - 1]).toBe(0);
  });

  it('createScanJob returns a daily job spec', () => {
    const svc = new ExpiryService(db, { broadcast: () => {} });
    const job = svc.createScanJob();
    expect(job.id).toBe('contracts.expiry_scan');
    expect(job.spec.kind).toBe('daily');
    expect(job.spec.hour).toBeGreaterThanOrEqual(0);
    expect(job.spec.hour).toBeLessThan(24);
    expect(typeof job.run).toBe('function');
  });
});
