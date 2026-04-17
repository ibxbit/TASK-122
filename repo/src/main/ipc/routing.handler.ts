import path from 'node:path';
import { registerGuarded } from '../access/enforce';
import { getDb } from '../db';
import { importRouteDataset } from '../routing/dataset-loader';
import { optimizeRoute, MAX_STOPS, type Stop, type OptimizeOptions } from '../routing/optimizer';
import { appendAuditEvent } from '../audit/chain';

/* =========================================================================
 * Routing IPC Handlers — dataset import + optimization + active-strategy
 * switching + rollback.
 *
 *   routing:datasets           (read)  list available datasets
 *   routing:activeDataset      (read)  currently-active dataset id
 *   routing:import             (write) admin-triggered offline import
 *   routing:activate           (write) switch active dataset (strategy)
 *   routing:rollback           (write) revert to previous dataset
 *   routing:optimize           (read)  TSP + Dijkstra over active dataset
 *
 *   All writes produce chain-linked audit events.
 * ========================================================================= */

interface ImportPayload   { sourcePath: string; }
interface ActivatePayload { datasetId: string; }
interface OptimizePayload {
  datasetId?:      string;
  stops?:          Stop[];
  /** Alternative to `stops` — supply free-text addresses and let the
   *  handler resolve each one against route_addresses before optimising. */
  addresses?:      string[];
  optimizeBy:      'time' | 'distance' | 'cost';
  startIndex?:     number;
  returnToStart?:  boolean;
  departAtUnix?:   number;
  perMileCents?:   number;
}

interface ResolveAddressPayload { query: string; limit?: number; }

export function registerRoutingHandlers(): void {
  // ── routing:datasets ─────────────────────────────────────────────────
  registerGuarded<Record<string, never>, unknown[]>(
    'routing:datasets',
    { permission: 'routing.view', type: 'api', action: 'read' },
    () => {
      return getDb().prepare(`
        SELECT id, name, version, imported_at AS importedAt,
               imported_by AS importedBy, node_count AS nodeCount,
               edge_count AS edgeCount, active
          FROM route_datasets
         ORDER BY imported_at DESC
      `).all();
    },
  );

  // ── routing:activeDataset ────────────────────────────────────────────
  registerGuarded<Record<string, never>, unknown>(
    'routing:activeDataset',
    { permission: 'routing.view', type: 'api', action: 'read' },
    () => {
      return getDb().prepare(`
        SELECT id, name, version FROM route_datasets WHERE active = 1 LIMIT 1
      `).get() ?? null;
    },
  );

  // ── routing:import ───────────────────────────────────────────────────
  registerGuarded<ImportPayload, unknown>(
    'routing:import',
    { permission: 'routing.import', type: 'api', action: 'write' },
    async (ctx, payload) => {
      // Canonicalize the source path to prevent traversal tricks at audit time
      const src = path.resolve(payload.sourcePath);
      const result = await importRouteDataset(getDb(), src, ctx.userId);

      appendAuditEvent(getDb(), {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'routing.dataset_imported',
        entityType:  'route_dataset',
        entityId:    result.datasetId,
        payload: {
          name:      result.name,
          version:   result.version,
          counts:    result.counts,
          sourcePath: src,
          durationMs: result.durationMs,
        },
      });
      return result;
    },
  );

  // ── routing:activate (strategy switch) ───────────────────────────────
  registerGuarded<ActivatePayload, unknown>(
    'routing:activate',
    { permission: 'routing.import', type: 'api', action: 'write' },
    (ctx, payload) => {
      const db = getDb();

      const target = db.prepare('SELECT id, active FROM route_datasets WHERE id = ?').get(payload.datasetId) as
        { id: string; active: number } | undefined;
      if (!target) return { ok: false, error: 'dataset_not_found' };

      const current = db.prepare('SELECT id FROM route_datasets WHERE active = 1 LIMIT 1').get() as
        { id: string } | undefined;

      db.transaction(() => {
        db.prepare('UPDATE route_datasets SET active = 0 WHERE active = 1').run();
        db.prepare('UPDATE route_datasets SET active = 1 WHERE id = ?').run(payload.datasetId);
      })();

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'routing.dataset_activated',
        entityType:  'route_dataset',
        entityId:    payload.datasetId,
        payload: { from: current?.id ?? null, to: payload.datasetId },
      });
      return { ok: true, activated: payload.datasetId, previous: current?.id ?? null };
    },
  );

  // ── routing:rollback ────────────────────────────────────────────────
  registerGuarded<Record<string, never>, unknown>(
    'routing:rollback',
    { permission: 'routing.import', type: 'api', action: 'write' },
    (ctx) => {
      const db = getDb();
      // Rollback = switch to the second-most-recent imported dataset.
      const rows = db.prepare(`
        SELECT id FROM route_datasets ORDER BY imported_at DESC LIMIT 2
      `).all() as Array<{ id: string }>;
      if (rows.length < 2) return { ok: false, error: 'no_previous_dataset' };

      const current  = rows[0].id;
      const previous = rows[1].id;

      db.transaction(() => {
        db.prepare('UPDATE route_datasets SET active = 0 WHERE active = 1').run();
        db.prepare('UPDATE route_datasets SET active = 1 WHERE id = ?').run(previous);
      })();

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'routing.dataset_rollback',
        entityType:  'route_dataset',
        entityId:    previous,
        payload: { from: current, to: previous },
      });
      return { ok: true, rolledBackTo: previous, from: current };
    },
  );

  // ── routing:resolveAddress ──────────────────────────────────────────
  //  Prefix + substring search against the active dataset's address book.
  //  Returns up to `limit` candidates (default 10).  The UI uses this to
  //  power the address-driven planner — users type, we suggest resolved
  //  nodeIds, then optimize() runs over the resolved stops.
  registerGuarded<ResolveAddressPayload, unknown>(
    'routing:resolveAddress',
    { permission: 'routing.optimize', type: 'api', action: 'read' },
    (_ctx, payload) => {
      const q = (payload.query ?? '').trim().toLowerCase();
      if (!q) return { ok: false, error: 'empty_query', matches: [] };

      const limit = Math.min(payload.limit ?? 10, 50);
      const db    = getDb();

      const active = db.prepare(
        `SELECT id FROM route_datasets WHERE active = 1 LIMIT 1`,
      ).get() as { id: string } | undefined;
      if (!active) return { ok: false, error: 'no_active_dataset', matches: [] };

      const like = `%${q}%`;
      const rows = db.prepare(`
        SELECT address_key AS key, display, node_id AS nodeId
          FROM route_addresses
         WHERE dataset_id = @ds
           AND (address_key LIKE @like OR LOWER(display) LIKE @like)
         ORDER BY
           CASE WHEN address_key LIKE @prefix THEN 0
                WHEN LOWER(display) LIKE @prefix THEN 1
                ELSE 2 END,
           display
         LIMIT @limit
      `).all({ ds: active.id, like, prefix: `${q}%`, limit }) as
        Array<{ key: string; display: string; nodeId: number }>;

      return { ok: true, datasetId: active.id, matches: rows };
    },
  );

  // ── routing:optimize ────────────────────────────────────────────────
  registerGuarded<OptimizePayload, unknown>(
    'routing:optimize',
    { permission: 'routing.optimize', type: 'api', action: 'read' },
    (_ctx, payload) => {
      const db = getDb();
      let stops: Stop[];

      // Address-driven planning path: resolve the supplied strings into
      // concrete node ids using the active dataset's address book.
      if (Array.isArray(payload.addresses) && payload.addresses.length) {
        const active = db.prepare(`SELECT id FROM route_datasets WHERE active = 1 LIMIT 1`)
          .get() as { id: string } | undefined;
        if (!active) return { ok: false, error: 'no_active_dataset' };

        const stmt = db.prepare(`
          SELECT display, node_id AS nodeId FROM route_addresses
           WHERE dataset_id = ? AND address_key = ? LIMIT 1
        `);
        const unresolved: string[] = [];
        stops = [];
        for (const raw of payload.addresses) {
          const key = (raw ?? '').trim().toLowerCase();
          if (!key) { unresolved.push(raw); continue; }
          const hit = stmt.get(active.id, key) as { display: string; nodeId: number } | undefined;
          if (!hit) { unresolved.push(raw); continue; }
          stops.push({ nodeId: hit.nodeId, label: hit.display });
        }
        if (unresolved.length > 0) {
          return { ok: false, error: 'address_not_found', unresolved };
        }
      } else if (Array.isArray(payload.stops)) {
        stops = payload.stops;
      } else {
        return { ok: false, error: 'missing_stops_or_addresses' };
      }

      if (stops.length < 2 || stops.length > MAX_STOPS) {
        return { ok: false, error: 'invalid_stop_count' };
      }

      const opts: OptimizeOptions = {
        optimizeBy:     payload.optimizeBy,
        startIndex:     payload.startIndex,
        returnToStart:  payload.returnToStart,
        departAtUnix:   payload.departAtUnix,
        perMileCents:   payload.perMileCents,
      };

      const result = optimizeRoute(db, stops, opts);
      return { ok: true, result };
    },
  );
}
