import { describe, expect, it } from 'vitest';
import { buildReportSnapshot } from '../../src/main/analytics/metrics';
import { makeTestDb, seedAccessGraph } from '../../unit_tests/_helpers/db';

/* =========================================================================
 *  Analytics — buildReportSnapshot returns a fully-populated ReportSnapshot.
 * ========================================================================= */

describe('buildReportSnapshot()', () => {
  it('aggregates orders, revenue, and hot slots over the filter window', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const now = Math.floor(Date.now() / 1000);

    const stmt = db.prepare(`
      INSERT INTO orders (id, tenant_id, order_number, kind, status, subject_user_id, amount_cents, currency, created_at, updated_at)
      VALUES (?, ?, ?, 'lease', ?, ?, ?, 'USD', ?, ?)
    `);
    stmt.run('o1', ids.tenantId, '1', 'approved',  ids.opsUserId, 1_000, now - 3600, now - 3600);
    stmt.run('o2', ids.tenantId, '2', 'completed', ids.opsUserId, 2_000, now - 1800, now - 1800);
    stmt.run('o3', ids.tenantId, '3', 'cancelled', ids.opsUserId, 0,     now -  600, now -  600);

    const snap = buildReportSnapshot(db, { tenantId: ids.tenantId, from: now - 7200, to: now + 60 });
    expect(snap.metrics.orders.total).toBe(3);
    expect(snap.metrics.orders.completed).toBe(1);
    expect(snap.metrics.orders.cancelled).toBe(1);
    expect(snap.metrics.revenue.revenue_cents).toBe(3_000);
    expect(snap.metrics.hotSlots.length).toBeGreaterThan(0);
    expect(snap.snapshotId).toMatch(/^rpt_/);
  });
});
