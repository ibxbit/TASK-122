import type { Database } from 'better-sqlite3';

/* =========================================================================
 * Analytics — SQL aggregations
 *
 *  All queries enforce tenant isolation (tenant_id = @tenantId) and honour
 *  the same filter shape.  Hours are extracted in LOCAL time so "hot time
 *  slots" align with the operator's working day.
 *
 *  Filter semantics: [from, to) — half-open interval, unix seconds.
 * ========================================================================= */

export interface MetricFilters {
  tenantId:    string;
  storeId?:    string;                 // org_unit_id
  from:        number;                 // inclusive, unix seconds
  to:          number;                 // exclusive, unix seconds
  hourOfDay?:  number;                 // 0–23
}

/** Local-time hour extraction for a unix-seconds column. */
const HOUR = (col: string) => `CAST(strftime('%H', ${col}, 'unixepoch', 'localtime') AS INTEGER)`;

/** Builds the common WHERE fragment for queries over the `orders` table. */
function orderPredicate(f: MetricFilters): { where: string; params: Record<string, unknown> } {
  const parts  = ['tenant_id = @tenantId', 'created_at >= @from', 'created_at < @to'];
  const params: Record<string, unknown> = { tenantId: f.tenantId, from: f.from, to: f.to };
  if (f.storeId)                     { parts.push('org_unit_id = @storeId'); params.storeId = f.storeId; }
  if (f.hourOfDay !== undefined)     { parts.push(`${HOUR('created_at')} = @hour`); params.hour = f.hourOfDay; }
  return { where: parts.join(' AND '), params };
}

/* ---------- 1. Orders ---------------------------------------------------- */

export interface OrdersTotal { total: number; completed: number; cancelled: number; }

export function queryOrdersTotal(db: Database, f: MetricFilters): OrdersTotal {
  const { where, params } = orderPredicate(f);
  return db.prepare(`
    SELECT
      COUNT(*)                                               AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)  AS completed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END)  AS cancelled
      FROM orders WHERE ${where}
  `).get(params) as OrdersTotal;
}

/* ---------- 2. Revenue --------------------------------------------------- */

export interface RevenueTotal { revenue_cents: number; currency: string; }

export function queryRevenue(db: Database, f: MetricFilters): RevenueTotal {
  const { where, params } = orderPredicate(f);
  return db.prepare(`
    SELECT
      COALESCE(SUM(amount_cents), 0) AS revenue_cents,
      COALESCE(MIN(currency), 'USD') AS currency
      FROM orders
     WHERE ${where} AND status IN ('approved','completed')
  `).get(params) as RevenueTotal;
}

/* ---------- 3. Occupancy rate ------------------------------------------- */

export interface OccupancyRate { avg_count: number; avg_capacity: number; occupancy_rate: number; }

export function queryOccupancyRate(db: Database, f: MetricFilters): OccupancyRate {
  const parts  = ['os.tenant_id = @tenantId', 'os.captured_at >= @from', 'os.captured_at < @to'];
  const params: Record<string, unknown> = { tenantId: f.tenantId, from: f.from, to: f.to };
  if (f.storeId)                 { parts.push('sr.org_unit_id = @storeId'); params.storeId = f.storeId; }
  if (f.hourOfDay !== undefined) { parts.push(`${HOUR('os.captured_at')} = @hour`); params.hour = f.hourOfDay; }

  const row = db.prepare(`
    SELECT AVG(os.occupancy_count) AS avg_count,
           AVG(os.capacity)        AS avg_capacity
      FROM occupancy_snapshots os
      JOIN seat_rooms sr ON sr.id = os.seat_room_id
     WHERE ${parts.join(' AND ')}
  `).get(params) as { avg_count: number | null; avg_capacity: number | null };

  const avg_count    = row.avg_count    ?? 0;
  const avg_capacity = row.avg_capacity ?? 0;
  return {
    avg_count, avg_capacity,
    occupancy_rate: avg_capacity === 0 ? 0 : avg_count / avg_capacity,
  };
}

/* ---------- 4. Hot time slots ------------------------------------------- */

export interface HotSlot { hour: number; orders: number; revenue_cents: number; }

export function queryHotTimeSlots(db: Database, f: MetricFilters): HotSlot[] {
  const { where, params } = orderPredicate(f);
  return db.prepare(`
    SELECT ${HOUR('created_at')}          AS hour,
           COUNT(*)                       AS orders,
           COALESCE(SUM(amount_cents), 0) AS revenue_cents
      FROM orders
     WHERE ${where}
     GROUP BY hour
     ORDER BY orders DESC, revenue_cents DESC
  `).all(params) as HotSlot[];
}

/* ---------- 4b. Hot seats / rooms --------------------------------------- */

export interface HotSeatRoom {
  seat_room_id:   string;
  code:           string;
  name:           string;
  kind:           string;
  capacity:       number;
  /** Average occupancy count across matching snapshots.  Zero-capacity
   *  rooms are filtered out so the rate is always defined. */
  avg_count:      number;
  avg_capacity:   number;
  occupancy_rate: number;
  /** Number of snapshot observations that contributed to the aggregation. */
  snapshot_count: number;
}

/**
 * Top N seat-rooms by observed occupancy over the filtered window.  Used
 * by the dashboard "Hottest seats / rooms" section.  Filter semantics
 * mirror queryOccupancyRate; `storeId` optionally scopes by org_unit_id
 * and `hourOfDay` optionally narrows to a single hour of day (LOCAL).
 */
export function queryHotSeatRooms(db: Database, f: MetricFilters, limit = 10): HotSeatRoom[] {
  const parts  = ['os.tenant_id = @tenantId', 'os.captured_at >= @from', 'os.captured_at < @to'];
  const params: Record<string, unknown> = { tenantId: f.tenantId, from: f.from, to: f.to };
  if (f.storeId)                 { parts.push('sr.org_unit_id = @storeId'); params.storeId = f.storeId; }
  if (f.hourOfDay !== undefined) { parts.push(`${HOUR('os.captured_at')} = @hour`); params.hour = f.hourOfDay; }

  return db.prepare(`
    SELECT sr.id                                  AS seat_room_id,
           sr.code                                AS code,
           sr.name                                AS name,
           sr.kind                                AS kind,
           sr.capacity                            AS capacity,
           AVG(os.occupancy_count)                AS avg_count,
           AVG(os.capacity)                       AS avg_capacity,
           COUNT(*)                               AS snapshot_count,
           CASE WHEN AVG(os.capacity) > 0
                THEN AVG(os.occupancy_count) * 1.0 / AVG(os.capacity)
                ELSE 0 END                        AS occupancy_rate
      FROM occupancy_snapshots os
      JOIN seat_rooms sr ON sr.id = os.seat_room_id
     WHERE ${parts.join(' AND ')}
     GROUP BY sr.id
     HAVING AVG(os.capacity) > 0
     ORDER BY occupancy_rate DESC, avg_count DESC
     LIMIT @limit
  `).all({ ...params, limit }) as HotSeatRoom[];
}

/* ---------- 5. Cancellation rate --------------------------------------- */

export interface CancellationRate { total: number; cancelled: number; rate: number; }

export function queryCancellationRate(db: Database, f: MetricFilters): CancellationRate {
  const t = queryOrdersTotal(db, f);
  return { total: t.total, cancelled: t.cancelled, rate: t.total === 0 ? 0 : t.cancelled / t.total };
}

/* ---------- 6. Repurchase rate ----------------------------------------- */

export interface RepurchaseRate { total_customers: number; repeat_customers: number; rate: number; }

export function queryRepurchaseRate(db: Database, f: MetricFilters): RepurchaseRate {
  const { where, params } = orderPredicate(f);
  const row = db.prepare(`
    WITH cust AS (
      SELECT subject_user_id, COUNT(*) AS c
        FROM orders
       WHERE ${where}
         AND subject_user_id IS NOT NULL
         AND status IN ('approved','completed')
       GROUP BY subject_user_id
    )
    SELECT COUNT(*)                                AS total_customers,
           SUM(CASE WHEN c >= 2 THEN 1 ELSE 0 END) AS repeat_customers
      FROM cust
  `).get(params) as { total_customers: number; repeat_customers: number | null };

  const repeat = row.repeat_customers ?? 0;
  return {
    total_customers:  row.total_customers,
    repeat_customers: repeat,
    rate: row.total_customers === 0 ? 0 : repeat / row.total_customers,
  };
}

/* =========================================================================
 *  Snapshot builder — bundles every metric for one (filter) tuple.
 *  ReportSnapshot is the immutable payload that the export service writes
 *  to disk.  The snapshotId doubles as the on-disk filename stem.
 * ========================================================================= */

export interface ReportSnapshot {
  snapshotId:   string;
  generatedAt:  number;                 // unix seconds
  filters:      MetricFilters;
  metrics: {
    orders:       OrdersTotal;
    revenue:      RevenueTotal;
    occupancy:    OccupancyRate;
    hotSlots:     HotSlot[];
    hotSeatRooms: HotSeatRoom[];
    cancellation: CancellationRate;
    repurchase:   RepurchaseRate;
  };
}

export function buildReportSnapshot(db: Database, filters: MetricFilters): ReportSnapshot {
  return {
    snapshotId:  generateSnapshotId(),
    generatedAt: Math.floor(Date.now() / 1000),
    filters,
    metrics: {
      orders:       queryOrdersTotal     (db, filters),
      revenue:      queryRevenue         (db, filters),
      occupancy:    queryOccupancyRate   (db, filters),
      hotSlots:     queryHotTimeSlots    (db, filters),
      hotSeatRooms: queryHotSeatRooms    (db, filters, 10),
      cancellation: queryCancellationRate(db, filters),
      repurchase:   queryRepurchaseRate  (db, filters),
    },
  };
}

function generateSnapshotId(): string {
  const t = Date.now().toString(36).padStart(8, '0');
  const r = Math.random().toString(36).slice(2, 12).padStart(10, '0');
  return `rpt_${t}_${r}`;
}
