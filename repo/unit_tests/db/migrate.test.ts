import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* =========================================================================
 * Versioned migration runner — brownfield-safety tests.
 *
 *  Uses a hand-rolled in-memory database stub that captures each executed
 *  SQL statement and tracking-table rows, so we can assert the runner's
 *  behaviour without pulling the better-sqlite3 native binding.
 *
 *  The critical property this suite proves is:
 *
 *    **When the tracking table is empty but user tables already exist,
 *    the runner refuses to silently back-fill tracking rows.**  Previously
 *    it would mark every on-disk migration as applied, which meant a NEW
 *    migration (version higher than what the legacy DB actually contained)
 *    would be skipped forever — schema drift.  The fix is an explicit
 *    `baseline` (or `LH_DB_BASELINE` env var).
 * ========================================================================= */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

import { applyMigrations, MigrationError } from '../../src/main/db/migrate';

interface Row { [k: string]: unknown }

class FakeDB {
  readonly exec: (sql: string) => void;
  readonly statements: Array<{ sql: string; params: unknown[] }> = [];
  readonly trackingRows: Row[] = [];
  readonly userTables = new Set<string>();

  constructor(opts?: { preexistingUserTables?: string[] }) {
    if (opts?.preexistingUserTables) {
      for (const t of opts.preexistingUserTables) this.userTables.add(t);
    }
    this.exec = (sql: string) => {
      this.statements.push({ sql, params: [] });
      // Track CREATE TABLE statements so the runner's user-table probe
      // observes them when migrations actually run.
      const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_][a-z0-9_]*)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) {
        const name = m[1].toLowerCase();
        if (name !== 'schema_migrations') this.userTables.add(name);
      }
    };
  }

  prepare(sql: string) {
    const self = this;
    const trimmed = sql.trim().replace(/\s+/g, ' ');
    return {
      run(...params: unknown[]) {
        self.statements.push({ sql: trimmed, params });
        if (/INSERT INTO schema_migrations/i.test(trimmed)) {
          const obj = params[0] as Row | undefined;
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            self.trackingRows.push(obj);
          } else if (params.length === 3) {
            self.trackingRows.push({ version: params[0], name: params[1], checksum: params[2] });
          }
        }
      },
      get(...params: unknown[]): Row | undefined {
        if (/SELECT COUNT\(\*\) AS n FROM schema_migrations/i.test(trimmed)) {
          return { n: self.trackingRows.length };
        }
        // User-table detector:
        //   SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'
        //     AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'
        if (/FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'/i.test(trimmed)) {
          return { n: self.userTables.size };
        }
        if (/SELECT version, name, checksum FROM schema_migrations WHERE version = \?/i.test(trimmed)) {
          const v = params[0];
          return self.trackingRows.find((r) => r.version === v);
        }
        return undefined;
      },
      all(): Row[] { return []; },
    } as unknown;
  }

  transaction<Fn extends (...a: unknown[]) => void>(fn: Fn): Fn {
    const wrapped = ((...a: unknown[]) => fn(...a)) as Fn;
    return wrapped;
  }
}

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lh-mig-'));
  await fs.writeFile(path.join(dir, '0001_init.sql'),
    `CREATE TABLE tenants (id TEXT);
     CREATE TABLE audit_events (id TEXT);`);
  await fs.writeFile(path.join(dir, '0002_extras.sql'),
    `CREATE TABLE extras (id TEXT);`);
  delete process.env.LH_DB_BASELINE;
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  delete process.env.LH_DB_BASELINE;
});

/* ==============================================================
 *  Fresh-install happy path — no user tables, applies every file
 * ============================================================== */
describe('applyMigrations — fresh install', () => {
  it('applies every migration in order and records tracking rows', () => {
    const db = new FakeDB();
    const result = applyMigrations(db as never, dir);

    expect(result.applied.map((a) => a.version)).toEqual([1, 2]);
    expect(result.skipped).toEqual([]);
    expect(result.baselined).toEqual([]);

    // Tracking insert fired for each migration
    const inserts = (db as never as FakeDB).statements.filter(
      (s) => /INSERT INTO schema_migrations/i.test(s.sql),
    );
    expect(inserts.length).toBe(2);
  });

  it('is idempotent on the second run (still works as before)', () => {
    const db = new FakeDB();
    applyMigrations(db as never, dir);
    const second = applyMigrations(db as never, dir);
    expect(second.applied).toEqual([]);
    expect(second.skipped.map((s) => s.version)).toEqual([1, 2]);
    expect(second.baselined).toEqual([]);
  });
});

/* ==============================================================
 *  Checksum integrity — unchanged from before
 * ============================================================== */
describe('applyMigrations — checksum integrity', () => {
  it('fails fast when a migration file changes checksum after being applied', async () => {
    const db = new FakeDB();
    applyMigrations(db as never, dir);
    await fs.writeFile(path.join(dir, '0001_init.sql'),
      `CREATE TABLE tenants (id TEXT); CREATE TABLE audit_events (id TEXT, extra TEXT);`);
    expect(() => applyMigrations(db as never, dir)).toThrow(MigrationError);
    expect(() => applyMigrations(db as never, dir)).toThrow(/checksum_mismatch/);
  });

  it('rejects non-monotonic migration versions', async () => {
    await fs.writeFile(path.join(dir, '0001_init.sql'), 'CREATE TABLE a (id TEXT);');
    await fs.writeFile(path.join(dir, '0001_duplicate.sql'), 'CREATE TABLE b (id TEXT);');
    const db = new FakeDB();
    expect(() => applyMigrations(db as never, dir)).toThrow(/non_monotonic_version|bad_filename/);
  });

  it('rejects migration files with no numeric prefix', async () => {
    await fs.writeFile(path.join(dir, 'malformed.sql'), 'CREATE TABLE c (id TEXT);');
    const db = new FakeDB();
    expect(() => applyMigrations(db as never, dir)).toThrow(/bad_filename/);
  });
});

/* ==============================================================
 *  Brownfield safety — the blocker this rerun fixes
 * ============================================================== */
describe('applyMigrations — brownfield safety', () => {
  it('FAILS FAST on a legacy DB with user tables and no baseline', () => {
    const db = new FakeDB({ preexistingUserTables: ['tenants', 'audit_events'] });
    expect(() => applyMigrations(db as never, dir))
      .toThrow(/brownfield_requires_baseline/);
    // Critically: no tracking rows were inserted — the unsafe silent
    // back-fill is gone.
    expect((db as never as FakeDB).trackingRows.length).toBe(0);
  });

  it('does NOT mark a NEW, unapplied migration as applied under any auto path', async () => {
    // Simulates the original blocker: operator has a legacy DB with only
    // version 1's schema applied, then we release a new 0002 and 0003
    // migration.  Old behaviour silently marked 2 and 3 as applied.
    await fs.writeFile(path.join(dir, '0003_future.sql'),
      `CREATE TABLE newly_required (id TEXT);`);
    const db = new FakeDB({ preexistingUserTables: ['tenants', 'audit_events'] });

    expect(() => applyMigrations(db as never, dir))
      .toThrow(/brownfield_requires_baseline/);
    expect((db as never as FakeDB).trackingRows.length).toBe(0);
  });

  it('throws bad_baseline for negative or non-integer values', () => {
    const db = new FakeDB({ preexistingUserTables: ['tenants'] });
    expect(() => applyMigrations(db as never, dir, { baseline: -1 }))
      .toThrow(/bad_baseline/);
    expect(() => applyMigrations(db as never, dir, { baseline: 1.5 }))
      .toThrow(/bad_baseline/);
  });

  it('throws baseline_ahead_of_files when baseline > max version on disk', () => {
    const db = new FakeDB({ preexistingUserTables: ['tenants'] });
    expect(() => applyMigrations(db as never, dir, { baseline: 9 }))
      .toThrow(/baseline_ahead_of_files/);
  });

  it('throws baseline_conflicts_with_existing_tracking when tracking is not empty', () => {
    const db = new FakeDB();
    applyMigrations(db as never, dir);            // applies normally
    expect(() => applyMigrations(db as never, dir, { baseline: 1 }))
      .toThrow(/baseline_conflicts_with_existing_tracking/);
  });

  it('with explicit baseline=1: marks only version 1 applied, RUNS version 2', async () => {
    const db = new FakeDB({ preexistingUserTables: ['tenants', 'audit_events'] });
    const result = applyMigrations(db as never, dir, { baseline: 1 });

    expect(result.baselined.map((b) => b.version)).toEqual([1]);
    expect(result.applied.map((a) => a.version)).toEqual([2]);  // new migration actually ran

    // The SQL body for 0001 must NOT have been executed — we baselined it.
    const execedSql = (db as never as FakeDB).statements
      .filter((s) => !/INSERT INTO schema_migrations/i.test(s.sql))
      .map((s) => s.sql).join('\n');
    expect(execedSql).not.toContain('CREATE TABLE tenants');
    // The SQL body for 0002 MUST have been executed.
    expect(execedSql).toContain('CREATE TABLE extras');

    // Tracking table has both versions
    const versions = (db as never as FakeDB).trackingRows.map((r) => r.version);
    expect(versions).toContain(1);
    expect(versions).toContain(2);
  });

  it('with baseline=0: runs every migration (asserts "empty DB despite user tables")', () => {
    // This is rare (e.g. the user tables were unrelated) but is the
    // escape hatch a knowledgeable operator has.
    const db = new FakeDB({ preexistingUserTables: ['unrelated_legacy'] });
    const result = applyMigrations(db as never, dir, { baseline: 0 });

    expect(result.baselined).toEqual([]);
    expect(result.applied.map((a) => a.version)).toEqual([1, 2]);
  });

  it('env var LH_DB_BASELINE matches the opts.baseline path', () => {
    process.env.LH_DB_BASELINE = '1';
    const db = new FakeDB({ preexistingUserTables: ['tenants', 'audit_events'] });
    const result = applyMigrations(db as never, dir);

    expect(result.baselined.map((b) => b.version)).toEqual([1]);
    expect(result.applied.map((a) => a.version)).toEqual([2]);
  });

  it('bad env var LH_DB_BASELINE is rejected', () => {
    process.env.LH_DB_BASELINE = 'notanumber';
    const db = new FakeDB({ preexistingUserTables: ['tenants'] });
    expect(() => applyMigrations(db as never, dir)).toThrow(/bad_env_baseline/);
  });

  it('opts.baseline takes precedence over the env var', () => {
    process.env.LH_DB_BASELINE = '2';
    const db = new FakeDB({ preexistingUserTables: ['tenants', 'audit_events'] });
    const result = applyMigrations(db as never, dir, { baseline: 1 });

    expect(result.baselined.map((b) => b.version)).toEqual([1]);
    expect(result.applied.map((a) => a.version)).toEqual([2]);
  });

  it('second call after baseline is a clean no-op (idempotent)', () => {
    const db = new FakeDB({ preexistingUserTables: ['tenants', 'audit_events'] });
    applyMigrations(db as never, dir, { baseline: 1 });
    const second = applyMigrations(db as never, dir);      // no opts needed
    expect(second.applied).toEqual([]);
    expect(second.baselined).toEqual([]);
    expect(second.skipped.map((s) => s.version)).toEqual([1, 2]);
  });

  it('checksum tampering of a baselined migration still fails fast on the next run', async () => {
    const db = new FakeDB({ preexistingUserTables: ['tenants', 'audit_events'] });
    applyMigrations(db as never, dir, { baseline: 2 });   // both baselined

    // Tamper with 0001 on disk
    await fs.writeFile(path.join(dir, '0001_init.sql'),
      `CREATE TABLE tenants (id TEXT); CREATE TABLE audit_events (id TEXT, extra TEXT);`);
    expect(() => applyMigrations(db as never, dir)).toThrow(/checksum_mismatch/);
  });
});
