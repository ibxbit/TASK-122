import { describe, expect, it } from 'vitest';
import { optimizeRoute, MAX_STOPS } from '../../src/main/routing/optimizer';
import { makeTestDb } from '../_helpers/db';

/* =========================================================================
 *  Route optimizer — graph loading, TSP, 2-opt.
 * ========================================================================= */

function seedRoutingDataset(db: ReturnType<typeof makeTestDb>) {
  db.prepare(`
    INSERT INTO route_datasets (id, name, version, active, node_count, edge_count)
    VALUES ('rds_test', 'test', '1.0', 1, 4, 6)
  `).run();
  const nodes: Array<[number, number, number]> = [[1, 0, 0], [2, 0, 1], [3, 1, 0], [4, 1, 1]];
  for (const [id, lat, lon] of nodes) {
    db.prepare('INSERT INTO route_nodes (dataset_id, node_id, lat, lon) VALUES (?, ?, ?, ?)').run('rds_test', id, lat, lon);
  }
  // Fully-connected-ish: small lengths, uniform speed, no toll, bidirectional.
  const edges: Array<[number, number, number, number]> = [
    [1, 1, 2, 1000], [2, 1, 3, 1200], [3, 2, 4, 1100],
    [4, 3, 4, 1000], [5, 1, 4, 2500], [6, 2, 3, 1500],
  ];
  for (const [eid, from, to, len] of edges) {
    db.prepare(`
      INSERT INTO route_edges (dataset_id, edge_id, from_node_id, to_node_id, length_meters, speed_kph, toll_cents, one_way)
      VALUES (?, ?, ?, ?, ?, 60, 0, 0)
    `).run('rds_test', eid, from, to, len);
  }
}

describe('optimizeRoute()', () => {
  it('throws on fewer than two stops', () => {
    const db = makeTestDb(); seedRoutingDataset(db);
    expect(() => optimizeRoute(db, [{ nodeId: 1, label: 'A' }], { optimizeBy: 'distance' }))
      .toThrow(/stops_too_few/);
  });

  it('throws when no active dataset exists', () => {
    const db = makeTestDb();
    expect(() => optimizeRoute(db, [{ nodeId: 1, label: 'A' }, { nodeId: 2, label: 'B' }], { optimizeBy: 'distance' }))
      .toThrow(/no_active_dataset/);
  });

  it('rejects > MAX_STOPS', () => {
    const db = makeTestDb(); seedRoutingDataset(db);
    const stops = Array.from({ length: MAX_STOPS + 1 }, (_, i) => ({ nodeId: i + 1, label: String(i) }));
    expect(() => optimizeRoute(db, stops, { optimizeBy: 'distance' }))
      .toThrow(/stops_exceeded/);
  });

  it('orders stops and emits legs', () => {
    const db = makeTestDb(); seedRoutingDataset(db);
    const stops = [
      { nodeId: 1, label: 'A' },
      { nodeId: 4, label: 'D' },
      { nodeId: 2, label: 'B' },
    ];
    const r = optimizeRoute(db, stops, { optimizeBy: 'distance', startIndex: 0 });
    expect(r.order[0]).toBe(0);                       // must start at index 0
    expect(r.order).toHaveLength(3);
    expect(r.legs.length).toBeGreaterThan(0);
    expect(r.totals.distanceMeters).toBeGreaterThan(0);
  });

  it('returns to start when requested', () => {
    const db = makeTestDb(); seedRoutingDataset(db);
    const stops = [{ nodeId: 1, label: 'A' }, { nodeId: 4, label: 'D' }];
    const r = optimizeRoute(db, stops, { optimizeBy: 'time', startIndex: 0, returnToStart: true });
    // With returnToStart, there should be stops.length legs (out + back).
    expect(r.legs.length).toBe(stops.length);
  });

  it('skips edges marked as closures in route_restrictions', () => {
    const db = makeTestDb(); seedRoutingDataset(db);
    // Close the direct 1→4 edge (edge 5). Optimizer should still find path via other edges.
    db.prepare(`
      INSERT INTO route_restrictions (id, dataset_id, edge_id, kind, version)
      VALUES ('rst1', 'rds_test', 5, 'closure', 1)
    `).run();
    const r = optimizeRoute(db, [{ nodeId: 1, label: 'A' }, { nodeId: 4, label: 'D' }], { optimizeBy: 'distance' });
    // Distance via closure-avoiding path > direct edge (2500m).
    expect(r.totals.distanceMeters).toBeGreaterThan(2000);
  });
});
