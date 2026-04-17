import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { logger } from '../logger';

/* =========================================================================
 * Dataset Loader — imports a USB-mounted road dataset directory.
 *
 *  Expected layout (sha256 of every listed file verified against manifest):
 *    <sourceDir>/
 *      manifest.json       { name, version, generatedAt, files:[{name,sha256,size_bytes}] }
 *      nodes.csv           node_id,lat,lon
 *      edges.csv           edge_id,from_node_id,to_node_id,length_meters,speed_kph,toll_cents,road_class,one_way
 *      addresses.csv       address_key,display,node_id
 *      restrictions.json   (optional)  [{ edge_id, kind, valid_from, valid_to, version, detour_path }]
 *
 *  Inserts happen in one synchronous transaction (better-sqlite3 serialises),
 *  so concurrent readers never see a half-loaded dataset.
 * ========================================================================= */

export interface DatasetImportResult {
  datasetId:  string;
  name:       string;
  version:    string;
  counts:     { nodes: number; edges: number; addresses: number; restrictions: number };
  durationMs: number;
}

interface ManifestFile { name: string; sha256: string; size_bytes: number; }
interface Manifest     { name: string; version: string; generatedAt: string; files: ManifestFile[]; }

export class DatasetLoadError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(`dataset_load:${code}${detail ? `:${detail}` : ''}`);
    this.name = 'DatasetLoadError';
  }
}

export async function importRouteDataset(
  db: Database,
  sourceDir: string,
  importedBy?: string,
): Promise<DatasetImportResult> {
  const started = Date.now();

  // ── 1. Manifest + hash verification ─────────────────────────────────────
  const manifestBuf = await fs.readFile(path.join(sourceDir, 'manifest.json'));
  const manifest    = JSON.parse(manifestBuf.toString('utf8')) as Manifest;
  if (!manifest?.name || !manifest.version || !Array.isArray(manifest.files)) {
    throw new DatasetLoadError('manifest_invalid');
  }

  const fileBuffers = new Map<string, Buffer>();
  for (const f of manifest.files) {
    const buf = await fs.readFile(path.join(sourceDir, f.name));
    if (buf.length !== f.size_bytes) throw new DatasetLoadError('size_mismatch', f.name);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== f.sha256) throw new DatasetLoadError('sha256_mismatch', f.name);
    fileBuffers.set(f.name, buf);
  }

  // ── 2. Parse CSVs + optional restrictions ───────────────────────────────
  const nodes     = parseCsv(fileBuffers.get('nodes.csv'),     ['node_id','lat','lon']);
  const edges     = parseCsv(fileBuffers.get('edges.csv'),     ['edge_id','from_node_id','to_node_id','length_meters','speed_kph','toll_cents','road_class','one_way']);
  const addresses = parseCsv(fileBuffers.get('addresses.csv'), ['address_key','display','node_id']);

  let restrictions: Array<{
    edge_id: number; kind: string;
    valid_from?: number | null; valid_to?: number | null;
    detour_path?: number[] | null; version?: number;
  }> = [];
  try {
    const raw = await fs.readFile(path.join(sourceDir, 'restrictions.json'), 'utf8');
    restrictions = JSON.parse(raw);
    if (!Array.isArray(restrictions)) throw new DatasetLoadError('restrictions_shape');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // ── 3. Persist in one synchronous transaction ───────────────────────────
  const datasetId = `rds_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  const aggSha    = crypto.createHash('sha256');
  for (const f of manifest.files) aggSha.update(f.sha256);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO route_datasets
        (id, name, version, source_path, file_sha256, imported_by, active)
      VALUES (@id, @name, @version, @src, @sha, @by, 0)
    `).run({
      id: datasetId, name: manifest.name, version: manifest.version,
      src: sourceDir, sha: aggSha.digest('hex'), by: importedBy ?? null,
    });

    const insNode = db.prepare(`INSERT INTO route_nodes (dataset_id,node_id,lat,lon) VALUES (?,?,?,?)`);
    for (const r of nodes) insNode.run(datasetId, +r.node_id, +r.lat, +r.lon);

    const insEdge = db.prepare(`
      INSERT INTO route_edges
        (dataset_id,edge_id,from_node_id,to_node_id,length_meters,speed_kph,toll_cents,road_class,one_way)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    for (const r of edges) insEdge.run(
      datasetId, +r.edge_id, +r.from_node_id, +r.to_node_id,
      +r.length_meters, +r.speed_kph, +r.toll_cents,
      r.road_class || null, +r.one_way ? 1 : 0,
    );

    const insAddr = db.prepare(`
      INSERT OR REPLACE INTO route_addresses (dataset_id,address_key,display,node_id)
      VALUES (?,?,?,?)
    `);
    for (const r of addresses) insAddr.run(datasetId, r.address_key.toLowerCase(), r.display, +r.node_id);

    const insRestriction = db.prepare(`
      INSERT INTO route_restrictions
        (id, dataset_id, edge_id, kind, valid_from, valid_to, version, detour_path)
      VALUES (@id, @ds, @edge, @kind, @vf, @vt, @v, @dp)
    `);
    for (const r of restrictions) {
      insRestriction.run({
        id: `rst_${crypto.randomBytes(8).toString('hex')}`,
        ds: datasetId, edge: r.edge_id, kind: r.kind,
        vf: r.valid_from ?? null, vt: r.valid_to ?? null,
        v:  r.version ?? 1,
        dp: r.detour_path ? JSON.stringify(r.detour_path) : null,
      });
    }

    db.prepare(`UPDATE route_datasets SET active = 0 WHERE id != ?`).run(datasetId);
    db.prepare(`
      UPDATE route_datasets
         SET active = 1, node_count = ?, edge_count = ?
       WHERE id = ?
    `).run(nodes.length, edges.length, datasetId);
  })();

  const result: DatasetImportResult = {
    datasetId, name: manifest.name, version: manifest.version,
    counts: {
      nodes:        nodes.length,
      edges:        edges.length,
      addresses:    addresses.length,
      restrictions: restrictions.length,
    },
    durationMs: Date.now() - started,
  };
  logger.info({ datasetId, ...result.counts, durationMs: result.durationMs }, 'route_dataset_imported');
  return result;
}

/* ------------------------------------------------------------------ *
 *  Address resolution — powers the "manual address" input flow.      *
 * ------------------------------------------------------------------ */

export interface AddressMatch { nodeId: number; display: string; }

export function resolveAddress(db: Database, query: string, limit = 20): AddressMatch[] {
  const ds = db.prepare(`SELECT id FROM route_datasets WHERE active = 1 LIMIT 1`)
               .get() as { id: string } | undefined;
  if (!ds) return [];
  const norm = query.trim().toLowerCase();
  if (!norm) return [];
  return db.prepare(`
    SELECT node_id AS nodeId, display
      FROM route_addresses
     WHERE dataset_id = ?
       AND (address_key LIKE ? OR LOWER(display) LIKE ?)
     LIMIT ?
  `).all(ds.id, `%${norm}%`, `%${norm}%`, limit) as AddressMatch[];
}

/* ------------------------------------------------------------------ *
 *  CSV parsing — minimal RFC 4180 within a single line.              *
 * ------------------------------------------------------------------ */

function parseCsv(buf: Buffer | undefined, required: string[]): Array<Record<string, string>> {
  if (!buf) throw new DatasetLoadError('csv_missing', required[0]);
  const text = buf.toString('utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = parseLine(lines[0]).map((s) => s.trim());
  for (const h of required) {
    if (!headers.includes(h)) throw new DatasetLoadError('csv_header_missing', h);
  }
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => { row[h] = cells[j] ?? ''; });
    out.push(row);
  }
  return out;
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else                      inQ = false;
      } else cur += c;
    } else {
      if (c === ',')                     { out.push(cur); cur = ''; }
      else if (c === '"' && cur === '')  { inQ = true; }
      else                               cur += c;
    }
  }
  out.push(cur);
  return out;
}
