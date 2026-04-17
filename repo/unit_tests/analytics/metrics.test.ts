import { describe, expect, it } from 'vitest';
import {
  queryOrdersTotal, queryRevenue, queryCancellationRate,
  queryRepurchaseRate, queryHotTimeSlots, queryOccupancyRate,
  buildReportSnapshot,
} from '../../src/main/analytics/metrics';
import { makeTestDb, seedAccessGraph } from '../_helpers/db';

/* =========================================================================
 *  Analytics aggregations — verified against a seeded set of orders.
 * ========================================================================= */

function seedOrders(db: ReturnType<typeof makeTestDb>, tenantId: string) {
  const now  = Math.floor(Date.now() / 1000);
  const base = now - 86_400;        // 1 day ago
  const rows: Array<{ id: string; status: string; amount: number; customer: string | null; at: number }> = [
    { id: 'o1', status: 'completed', amount: 10_000, customer: 'c1', at: base + 3600 },
    { id: 'o2', status: 'completed', amount: 5_000,  customer: 'c1', at: base + 7200 },      // repeat
    { id: 'o3', status: 'approved',  amount: 20_000, customer: 'c2', at: base + 10_800 },
    { id: 'o4', status: 'cancelled', amount: 0,      customer: 'c3', at: base + 14_400 },
    { id: 'o5', status: 'completed', amount: 3_000,  customer: 'c2', at: base + 18_000 },    // repeat
  ];
  // orders.subject_user_id has an FK to users(id) — seed the three customers
  // first so the inserts below don't trip FOREIGN KEY constraint failed.
  const insUser = db.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, status) VALUES (?, ?, ?, ?, 'active')`,
  );
  for (const c of ['c1', 'c2', 'c3']) insUser.run(c, tenantId, c, c);

  const stmt = db.prepare(`
    INSERT INTO orders (id, tenant_id, order_number, kind, status, subject_user_id, amount_cents, currency, created_at, updated_at)
    VALUES (?, ?, ?, 'lease', ?, ?, ?, 'USD', ?, ?)
  `);
  rows.forEach((r, i) => stmt.run(r.id, tenantId, `N${i}`, r.status, r.customer, r.amount, r.at, r.at));

  return { from: base, to: now + 3600 };
}

describe('analytics metrics', () => {
  it('counts orders by status', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const range = seedOrders(db, ids.tenantId);
    const t = queryOrdersTotal(db, { tenantId: ids.tenantId, ...range });
    expect(t.total).toBe(5);
    expect(t.completed).toBe(3);
    expect(t.cancelled).toBe(1);
  });

  it('sums revenue only from approved+completed', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const range = seedOrders(db, ids.tenantId);
    const rev = queryRevenue(db, { tenantId: ids.tenantId, ...range });
    expect(rev.revenue_cents).toBe(10_000 + 5_000 + 20_000 + 3_000);
  });

  it('cancellation rate = cancelled / total', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const range = seedOrders(db, ids.tenantId);
    const c = queryCancellationRate(db, { tenantId: ids.tenantId, ...range });
    expect(c.rate).toBeCloseTo(1 / 5);
  });

  it('repurchase rate = customers with ≥ 2 approved/completed', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const range = seedOrders(db, ids.tenantId);
    const r = queryRepurchaseRate(db, { tenantId: ids.tenantId, ...range });
    expect(r.total_customers).toBe(2);                 // c1 + c2 (c3 was cancelled only)
    expect(r.repeat_customers).toBe(2);
    expect(r.rate).toBeCloseTo(1);
  });

  it('hot time slots groups orders by hour', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const range = seedOrders(db, ids.tenantId);
    const slots = queryHotTimeSlots(db, { tenantId: ids.tenantId, ...range });
    const total = slots.reduce((a, s) => a + s.orders, 0);
    expect(total).toBe(5);
  });

  it('occupancy rate = avg(count) / avg(capacity)', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);

    // Minimal seeding of an org unit + seat room.
    db.prepare('INSERT INTO org_units (id, tenant_id, kind, code, name, path) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ou_root', ids.tenantId, 'location', 'ou', 'hq', '/ou');
    db.prepare(`
      INSERT INTO seat_rooms (id, tenant_id, org_unit_id, code, name, kind, capacity)
      VALUES ('sr1', ?, 'ou_root', 'sr1', 'Seat 1', 'seat', 4)
    `).run(ids.tenantId);

    const at = Math.floor(Date.now() / 1000) - 600;
    db.prepare(`
      INSERT INTO occupancy_snapshots (id, tenant_id, seat_room_id, captured_at, occupancy_count, capacity, source)
      VALUES ('os1', ?, 'sr1', ?, 2, 4, 'manual')
    `).run(ids.tenantId, at);
    db.prepare(`
      INSERT INTO occupancy_snapshots (id, tenant_id, seat_room_id, captured_at, occupancy_count, capacity, source)
      VALUES ('os2', ?, 'sr1', ?, 3, 4, 'manual')
    `).run(ids.tenantId, at + 60);

    const r = queryOccupancyRate(db, {
      tenantId: ids.tenantId,
      from: at - 1,
      to:   at + 1000,
    });
    expect(r.occupancy_rate).toBeCloseTo(2.5 / 4);
  });

  it('buildReportSnapshot bundles every metric', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const range = seedOrders(db, ids.tenantId);
    const snap = buildReportSnapshot(db, { tenantId: ids.tenantId, ...range });
    expect(snap.snapshotId).toMatch(/^rpt_/);
    expect(snap.metrics.orders.total).toBe(5);
    expect(snap.metrics.hotSlots).toBeDefined();
  });
});
