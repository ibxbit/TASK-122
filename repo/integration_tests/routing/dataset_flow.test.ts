import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  importRouteDataset, resolveAddress, DatasetLoadError,
} from '../../src/main/routing/dataset-loader';
import { optimizeRoute } from '../../src/main/routing/optimizer';
import { makeTestDb } from '../../unit_tests/_helpers/db';

/* =========================================================================
 *  Routing — import a dataset, then optimise a route over the loaded graph.
 * ========================================================================= */

async function writeDatasetDir(dir: string, files: Record<string, string | Buffer>) {
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    name: 'test-ds',
    version: '1.0',
    generatedAt: new Date().toISOString(),
    files: [] as Array<{ name: string; sha256: string; size_bytes: number }>,
  };
  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    await fs.writeFile(path.join(dir, name), buf);
    manifest.files.push({
      name,
      sha256:     crypto.createHash('sha256').update(buf).digest('hex'),
      size_bytes: buf.length,
    });
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}

describe('importRouteDataset() + optimize flow', () => {
  it('imports a valid dataset and optimiser can plan over it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lh-rds-'));
    try {
      await writeDatasetDir(dir, {
        'nodes.csv': 'node_id,lat,lon\n1,0,0\n2,0,1\n3,1,1\n',
        'edges.csv': [
          'edge_id,from_node_id,to_node_id,length_meters,speed_kph,toll_cents,road_class,one_way',
          '1,1,2,1000,60,0,primary,0',
          '2,2,3,1200,60,0,primary,0',
          '3,1,3,2500,60,50,primary,0',
        ].join('\n') + '\n',
        'addresses.csv': 'address_key,display,node_id\n100 main st,100 Main Street,1\n200 oak ave,200 Oak Ave,3\n',
      });

      const db = makeTestDb();
      const imported = await importRouteDataset(db, dir, 'u_tester');
      expect(imported.counts).toEqual({ nodes: 3, edges: 3, addresses: 2, restrictions: 0 });

      const match = resolveAddress(db, 'main', 5);
      expect(match.length).toBeGreaterThan(0);
      expect(match[0].display).toContain('100 Main Street');

      const r = optimizeRoute(db, [
        { nodeId: 1, label: 'A' },
        { nodeId: 3, label: 'C' },
      ], { optimizeBy: 'distance', startIndex: 0 });
      expect(r.totals.distanceMeters).toBeGreaterThan(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects datasets with hash mismatches', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lh-rds-bad-'));
    try {
      await fs.writeFile(path.join(dir, 'nodes.csv'),     'node_id,lat,lon\n1,0,0\n');
      await fs.writeFile(path.join(dir, 'edges.csv'),     'edge_id,from_node_id,to_node_id,length_meters,speed_kph,toll_cents,road_class,one_way\n1,1,1,0,60,0,p,0\n');
      await fs.writeFile(path.join(dir, 'addresses.csv'), 'address_key,display,node_id\n');

      // Corrupt manifest: declare wrong sha.
      await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
        name: 'bad', version: '1', generatedAt: 'now',
        files: [
          { name: 'nodes.csv',     sha256: '0'.repeat(64), size_bytes: (await fs.stat(path.join(dir, 'nodes.csv'))).size },
          { name: 'edges.csv',     sha256: '0'.repeat(64), size_bytes: (await fs.stat(path.join(dir, 'edges.csv'))).size },
          { name: 'addresses.csv', sha256: '0'.repeat(64), size_bytes: (await fs.stat(path.join(dir, 'addresses.csv'))).size },
        ],
      }));

      const db = makeTestDb();
      await expect(importRouteDataset(db, dir, 'u_tester')).rejects.toBeInstanceOf(DatasetLoadError);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
