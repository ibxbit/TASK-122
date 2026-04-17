import type { Database } from 'better-sqlite3';

/* =========================================================================
 * Route Optimizer  (up to 25 stops, fully offline)
 *
 *   1. loadGraph(db, datasetId, atUnix)
 *        • edges loaded in-memory as adjacency list
 *        • versioned restrictions applied:
 *            - closure / truck_only / low_clearance → edge dropped
 *            - detour                                → edge replaced with composite
 *   2. dijkstra() from every stop                   (Binary heap)
 *   3. nearestNeighbour tour                         (O(n²))
 *   4. 2-opt improvement                             (until no gain)
 *   5. Reconstruct per-leg paths from Dijkstra parents
 *
 *  Edge-cost metric is selectable: time | distance | cost (per-mile + tolls).
 * ========================================================================= */

export const MAX_STOPS = 25;

export interface Stop { nodeId: number; label: string; }

export interface OptimizeOptions {
  optimizeBy:      'time' | 'distance' | 'cost';
  startIndex?:     number;
  returnToStart?:  boolean;
  departAtUnix?:   number;       // selects the restriction slice
  perMileCents?:   number;       // required when optimizeBy = 'cost'
}

export interface PathLeg {
  fromIndex:       number;
  toIndex:         number;
  distanceMeters:  number;
  timeSeconds:     number;
  tollCents:       number;
  pathNodes:       number[];
  edgeIds:         number[];
}

export interface OptimizeResult {
  datasetId: string;
  order:     number[];           // permutation of stop indices
  legs:      PathLeg[];
  totals: {
    distanceMeters: number;
    timeSeconds:    number;
    tollCents:      number;
  };
  computeMs: number;
}

export function optimizeRoute(
  db: Database,
  stops: Stop[],
  options: OptimizeOptions,
): OptimizeResult {
  if (stops.length < 2)          throw new Error('stops_too_few');
  if (stops.length > MAX_STOPS)  throw new Error(`stops_exceeded:${stops.length}>${MAX_STOPS}`);

  const started = Date.now();
  const ds = db.prepare('SELECT id FROM route_datasets WHERE active = 1 LIMIT 1')
               .get() as { id: string } | undefined;
  if (!ds) throw new Error('no_active_dataset');

  const departAt = options.departAtUnix ?? Math.floor(Date.now() / 1000);
  const graph    = loadGraph(db, ds.id, departAt);
  const metric   = options.optimizeBy;
  const perMi    = options.perMileCents ?? 0;

  // Dijkstra from each stop.  Retain full result so legs can be reconstructed.
  const results = stops.map((s) => dijkstra(graph, s.nodeId, metric, perMi));

  // Build cost matrix (Infinity when unreachable).
  const N = stops.length;
  const cost: number[][] = Array.from({ length: N }, () => new Array(N).fill(Infinity));
  for (let i = 0; i < N; i++) {
    cost[i][i] = 0;
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const c = results[i].cost.get(stops[j].nodeId);
      if (c !== undefined) cost[i][j] = c;
    }
  }

  const startIdx = Math.min(Math.max(options.startIndex ?? 0, 0), N - 1);
  let order      = nearestNeighbour(cost, startIdx);
  order          = twoOpt(order, cost, options.returnToStart ?? false);

  // Reconstruct leg paths.
  const legs: PathLeg[] = [];
  let totalDist = 0, totalTime = 0, totalToll = 0;
  const emitLeg = (fromIdx: number, toIdx: number) => {
    const leg = reconstructLeg(results[fromIdx], stops[toIdx].nodeId, fromIdx, toIdx);
    legs.push(leg);
    totalDist += leg.distanceMeters;
    totalTime += leg.timeSeconds;
    totalToll += leg.tollCents;
  };
  for (let i = 0; i < order.length - 1; i++) emitLeg(order[i], order[i + 1]);
  if (options.returnToStart) emitLeg(order[order.length - 1], order[0]);

  return {
    datasetId: ds.id,
    order,
    legs,
    totals: { distanceMeters: totalDist, timeSeconds: totalTime, tollCents: totalToll },
    computeMs: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ *
 *  Graph loader + restriction application                             *
 * ------------------------------------------------------------------ */

interface GraphEdge {
  edgeId:    number;       // -1 for synthesised detour
  to:        number;
  distanceM: number;
  timeS:     number;
  tollC:     number;
  viaEdges?: number[];     // underlying edge_ids (for detours)
}
interface Graph {
  adjacency: Map<number, GraphEdge[]>;
}

function loadGraph(db: Database, datasetId: string, atUnix: number): Graph {
  // 1. Pull the live restriction slice.
  const restrictions = db.prepare(`
    SELECT edge_id, kind, detour_path
      FROM route_restrictions
     WHERE dataset_id = ? AND superseded_by IS NULL
       AND (valid_from IS NULL OR valid_from <= ?)
       AND (valid_to   IS NULL OR valid_to   >= ?)
  `).all(datasetId, atUnix, atUnix) as Array<{
    edge_id: number; kind: string; detour_path: string | null;
  }>;
  const dropped = new Set<number>();
  const detours = new Map<number, number[]>();
  for (const r of restrictions) {
    if (r.kind === 'closure' || r.kind === 'truck_only' || r.kind === 'low_clearance') {
      dropped.add(r.edge_id);
    } else if (r.kind === 'detour' && r.detour_path) {
      detours.set(r.edge_id, JSON.parse(r.detour_path) as number[]);
    }
  }

  // 2. Load all edges.
  const edges = db.prepare(`
    SELECT edge_id, from_node_id, to_node_id, length_meters, speed_kph, toll_cents, one_way
      FROM route_edges WHERE dataset_id = ?
  `).all(datasetId) as Array<{
    edge_id: number; from_node_id: number; to_node_id: number;
    length_meters: number; speed_kph: number; toll_cents: number; one_way: number;
  }>;

  const edgeById = new Map<number, typeof edges[0]>();
  for (const e of edges) edgeById.set(e.edge_id, e);

  const adjacency = new Map<number, GraphEdge[]>();
  const addEdge = (from: number, e: GraphEdge) => {
    let arr = adjacency.get(from);
    if (!arr) { arr = []; adjacency.set(from, arr); }
    arr.push(e);
  };

  const edgeMetrics = (e: typeof edges[0]) => {
    const speedMs = Math.max(1, e.speed_kph) * 1000 / 3600;
    return { distanceM: e.length_meters, timeS: e.length_meters / speedMs, tollC: e.toll_cents };
  };

  for (const e of edges) {
    if (dropped.has(e.edge_id)) continue;

    // If a detour replaces this edge, synthesise a composite edge from its path.
    if (detours.has(e.edge_id)) {
      const composite = synthDetour(detours.get(e.edge_id)!, edgeById, dropped);
      if (composite) {
        addEdge(e.from_node_id, { ...composite, to: e.to_node_id });
        if (!e.one_way) addEdge(e.to_node_id, { ...composite, to: e.from_node_id });
        continue;
      }
      // detour invalid → fall through to direct edge (soft-fail)
    }

    const m = edgeMetrics(e);
    addEdge(e.from_node_id, { edgeId: e.edge_id, to: e.to_node_id, ...m });
    if (!e.one_way) addEdge(e.to_node_id, { edgeId: e.edge_id, to: e.from_node_id, ...m });
  }

  return { adjacency };
}

function synthDetour(
  edgeIds: number[],
  edgeById: Map<number, { length_meters: number; speed_kph: number; toll_cents: number }>,
  dropped: Set<number>,
): Omit<GraphEdge, 'to'> | null {
  let distanceM = 0, timeS = 0, tollC = 0;
  for (const id of edgeIds) {
    if (dropped.has(id)) return null;
    const e = edgeById.get(id);
    if (!e) return null;
    const speedMs = Math.max(1, e.speed_kph) * 1000 / 3600;
    distanceM += e.length_meters;
    timeS     += e.length_meters / speedMs;
    tollC     += e.toll_cents;
  }
  return { edgeId: -1, distanceM, timeS, tollC, viaEdges: edgeIds.slice() };
}

/* ------------------------------------------------------------------ *
 *  Dijkstra + binary heap                                             *
 * ------------------------------------------------------------------ */

interface DijkstraResult {
  cost:   Map<number, number>;
  dist:   Map<number, number>;
  time:   Map<number, number>;
  toll:   Map<number, number>;
  parent: Map<number, { from: number; via: GraphEdge }>;
}

function dijkstra(graph: Graph, start: number, metric: 'time'|'distance'|'cost', perMileCents: number): DijkstraResult {
  const cost   = new Map<number, number>([[start, 0]]);
  const dist   = new Map<number, number>([[start, 0]]);
  const time   = new Map<number, number>([[start, 0]]);
  const toll   = new Map<number, number>([[start, 0]]);
  const parent = new Map<number, { from: number; via: GraphEdge }>();
  const heap   = new MinHeap<number>();
  heap.push(0, start);

  const costOf = (e: GraphEdge): number => {
    if (metric === 'distance') return e.distanceM;
    if (metric === 'time')     return e.timeS;
    return (e.distanceM * 0.000621371) * perMileCents + e.tollC;     // cents
  };

  while (heap.size() > 0) {
    const top = heap.pop()!;
    const u   = top.value;
    if (top.key > (cost.get(u) ?? Infinity)) continue;
    const neighbours = graph.adjacency.get(u);
    if (!neighbours) continue;
    for (const e of neighbours) {
      const nc = top.key + costOf(e);
      if (nc < (cost.get(e.to) ?? Infinity)) {
        cost.set(e.to, nc);
        dist.set(e.to, (dist.get(u) ?? 0) + e.distanceM);
        time.set(e.to, (time.get(u) ?? 0) + e.timeS);
        toll.set(e.to, (toll.get(u) ?? 0) + e.tollC);
        parent.set(e.to, { from: u, via: e });
        heap.push(nc, e.to);
      }
    }
  }
  return { cost, dist, time, toll, parent };
}

function reconstructLeg(r: DijkstraResult, toNode: number, fromIdx: number, toIdx: number): PathLeg {
  const pathNodes: number[] = [];
  const edgeIds:   number[] = [];
  let cur: number | undefined = toNode;
  while (cur !== undefined && r.parent.has(cur)) {
    pathNodes.unshift(cur);
    // Explicit annotation: stricter TS (5.5+) otherwise infers `p` as
    // `any` because `cur` is re-assigned from `p.from` in the loop body,
    // which the control-flow analyser flags as self-referential.
    const p: { from: number; via: GraphEdge } = r.parent.get(cur)!;
    if (p.via.viaEdges) edgeIds.unshift(...p.via.viaEdges);
    else if (p.via.edgeId >= 0) edgeIds.unshift(p.via.edgeId);
    cur = p.from;
  }
  if (cur !== undefined) pathNodes.unshift(cur);
  return {
    fromIndex:       fromIdx,
    toIndex:         toIdx,
    distanceMeters:  r.dist.get(toNode) ?? 0,
    timeSeconds:     r.time.get(toNode) ?? 0,
    tollCents:       r.toll.get(toNode) ?? 0,
    pathNodes,
    edgeIds,
  };
}

/* ------------------------------------------------------------------ *
 *  TSP heuristics                                                     *
 * ------------------------------------------------------------------ */

function nearestNeighbour(matrix: number[][], start: number): number[] {
  const n = matrix.length;
  const visited = new Array<boolean>(n).fill(false);
  const tour: number[] = [start];
  visited[start] = true;
  let cur = start;
  for (let step = 1; step < n; step++) {
    let best = -1, bestC = Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited[j] && matrix[cur][j] < bestC) { best = j; bestC = matrix[cur][j]; }
    }
    if (best === -1) break;                    // unreachable stops are left off
    tour.push(best); visited[best] = true; cur = best;
  }
  return tour;
}

function twoOpt(tour: number[], matrix: number[][], closeLoop: boolean): number[] {
  const cost = (t: number[]): number => {
    let c = 0;
    for (let i = 0; i < t.length - 1; i++) c += matrix[t[i]][t[i + 1]];
    if (closeLoop) c += matrix[t[t.length - 1]][t[0]];
    return c;
  };
  let best = tour.slice();
  let bestCost = cost(best);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i)
                         .concat(best.slice(i, k + 1).reverse())
                         .concat(best.slice(k + 1));
        const c = cost(cand);
        if (c < bestCost - 1e-9) { best = cand; bestCost = c; improved = true; }
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 *  Binary MinHeap                                                     *
 * ------------------------------------------------------------------ */

class MinHeap<T> {
  private arr: Array<{ key: number; value: T }> = [];
  size(): number { return this.arr.length; }

  push(key: number, value: T): void {
    this.arr.push({ key, value });
    this.bubbleUp(this.arr.length - 1);
  }

  pop(): { key: number; value: T } | undefined {
    if (this.arr.length === 0) return undefined;
    const top  = this.arr[0];
    const last = this.arr.pop()!;
    if (this.arr.length > 0) { this.arr[0] = last; this.bubbleDown(0); }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.arr[p].key <= this.arr[i].key) break;
      [this.arr[p], this.arr[i]] = [this.arr[i], this.arr[p]];
      i = p;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.arr.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let s = i;
      if (l < n && this.arr[l].key < this.arr[s].key) s = l;
      if (r < n && this.arr[r].key < this.arr[s].key) s = r;
      if (s === i) break;
      [this.arr[s], this.arr[i]] = [this.arr[i], this.arr[s]];
      i = s;
    }
  }
}
