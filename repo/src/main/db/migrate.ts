import type { Database } from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger';

/* =========================================================================
 * Versioned Migration Runner
 *
 *  Guarantees:
 *
 *    • Per-migration atomic apply — each .sql runs inside BEGIN…COMMIT so
 *      a partial failure leaves the database unchanged.
 *    • Applied-version tracking via `schema_migrations` (version, checksum,
 *      applied_at).  Re-applies are skipped when the checksum matches.
 *    • Fail-fast integrity guard — if a previously-applied migration's
 *      checksum now differs on disk, we throw `migration_error:checksum_mismatch`
 *      instead of silently diverging.
 *    • Idempotent startup — calling applyMigrations() twice in a row is a
 *      no-op after the first call.
 *    • **Brownfield safety (re-audit fix)** — when the tracking table is
 *      empty but the database already has user tables, the runner will NOT
 *      automatically mark any migrations as applied.  The operator must
 *      supply an explicit `baseline: N` (or `LH_DB_BASELINE=N`) that names
 *      the highest version whose schema is already present.  Migrations
 *      1..N are marked applied without running SQL; migrations > N run
 *      normally.  The previous auto-backfill was unsafe because it also
 *      marked unapplied NEW migrations as applied, leaving the schema
 *      behind silently.  There is no way to trigger the unsafe path now —
 *      the default behaviour on a brownfield DB is to fail fast.
 *
 *  Version format: the numeric prefix at the start of each filename
 *  (e.g. `0001_init.sql` → version 1).  Missing / non-monotonic prefixes
 *  throw; this forces a clean monotonic history.
 * ========================================================================= */

export class MigrationError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(`migration_error:${code}${detail ? `:${detail}` : ''}`);
    this.name = 'MigrationError';
  }
}

export interface MigrationResult {
  applied:    Array<{ version: number; name: string; checksum: string; ms: number }>;
  skipped:    Array<{ version: number; name: string }>;
  baselined:  Array<{ version: number; name: string }>;
}

export interface ApplyOptions {
  /**
   * Explicit brownfield baseline.  When the tracking table is empty but
   * user tables already exist, migrations 1..baseline are treated as
   * already applied (SQL is NOT executed); migrations > baseline run
   * transactionally.  Set to 0 to assert "empty DB" and run every file.
   *
   * Accepts a positive integer equal to the prefix of an existing
   * migration file.  Supplying a baseline when the tracking table is
   * non-empty is an error (the DB is past brownfield — use normal apply).
   *
   * Can also be set via the `LH_DB_BASELINE` environment variable as a
   * numeric string.  An explicit `opts.baseline` takes precedence.
   */
  baseline?: number;
}

const CREATE_TRACKING = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    checksum    TEXT    NOT NULL,
    applied_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

interface MigrationFile { version: number; name: string; sql: string; checksum: string; }

export function applyMigrations(
  db: Database, migrationsDir: string, opts: ApplyOptions = {},
): MigrationResult {
  // 1. Ensure tracking table exists (outside any other migration so the table
  //    itself is always available before the per-migration transactions).
  db.exec(CREATE_TRACKING);

  const files = loadMigrationFiles(migrationsDir);

  const trackedCount = (db.prepare(
    'SELECT COUNT(*) AS n FROM schema_migrations',
  ).get() as { n: number }).n;
  const hasAnyUserTables = detectPreExistingUserTables(db);

  const result: MigrationResult = { applied: [], skipped: [], baselined: [] };

  // 2. Resolve the explicit baseline (opt-in) if present.  Env var is only
  //    consulted when opts doesn't supply one.
  const envBaseline = parseEnvBaseline(process.env.LH_DB_BASELINE);
  const baseline    = opts.baseline !== undefined ? opts.baseline : envBaseline;

  // 3. Brownfield guard — fail fast on a DB that already has user tables
  //    but no tracking rows UNLESS the operator has explicitly baselined.
  if (trackedCount === 0 && hasAnyUserTables && baseline === undefined) {
    throw new MigrationError(
      'brownfield_requires_baseline',
      'database has user tables but schema_migrations is empty; ' +
      'set opts.baseline or LH_DB_BASELINE=<highest already-applied version> ' +
      'after verifying the schema is at that version.  Use LH_DB_BASELINE=0 ' +
      'only if you are certain every migration still needs to run.',
    );
  }

  // 4. If a baseline was supplied, validate + apply it.  Post-baseline
  //    behaviour (normal apply for versions > baseline) falls through.
  if (baseline !== undefined) {
    if (trackedCount > 0) {
      throw new MigrationError(
        'baseline_conflicts_with_existing_tracking',
        `schema_migrations has ${trackedCount} row(s); baseline is only valid on an empty tracking table`,
      );
    }
    if (!Number.isInteger(baseline) || baseline < 0) {
      throw new MigrationError('bad_baseline', `${baseline}`);
    }
    const maxKnownVersion = files.length ? files[files.length - 1].version : 0;
    if (baseline > maxKnownVersion) {
      throw new MigrationError(
        'baseline_ahead_of_files',
        `baseline=${baseline} but the highest migration on disk is ${maxKnownVersion}`,
      );
    }

    if (baseline > 0) {
      const baselineVersions = new Set<number>();
      const toBaseline = files.filter((f) => f.version <= baseline);
      const tx = db.transaction(() => {
        for (const f of toBaseline) {
          db.prepare(`
            INSERT INTO schema_migrations (version, name, checksum)
            VALUES (?, ?, ?)
          `).run(f.version, f.name, f.checksum);
          baselineVersions.add(f.version);
          result.baselined.push({ version: f.version, name: f.name });
        }
      });
      tx();
      logger.warn(
        { baseline, baselinedCount: toBaseline.length },
        'migrations_baselined_manual',
      );

      // Safety check — baseline was supposed to cover every sequential
      // version from 1 up to `baseline`.  If the file list has a gap
      // that's invisible above, surface it.
      for (let v = 1; v <= baseline; v++) {
        if (!baselineVersions.has(v)) {
          throw new MigrationError(
            'baseline_missing_file',
            `no migration file found for version ${v} (baseline=${baseline})`,
          );
        }
      }
    } else {
      logger.info('migrations_baseline_zero_full_apply');
    }
  }

  // 5. Normal apply loop — runs for all files > baseline (and for every
  //    file when tracking was empty AND there were no user tables, which
  //    is the genuine fresh-install path).
  const getApplied = db.prepare(
    'SELECT version, name, checksum FROM schema_migrations WHERE version = ?',
  );
  const insertApplied = db.prepare(`
    INSERT INTO schema_migrations (version, name, checksum)
    VALUES (@version, @name, @checksum)
  `);

  for (const f of files) {
    const existing = getApplied.get(f.version) as
      { version: number; name: string; checksum: string } | undefined;

    if (existing) {
      if (existing.checksum !== f.checksum) {
        throw new MigrationError(
          'checksum_mismatch',
          `${f.name} (version ${f.version}): expected ${existing.checksum.slice(0, 12)}…, have ${f.checksum.slice(0, 12)}…`,
        );
      }
      // Only count it as "skipped" if we weren't the ones that just
      // baselined it — otherwise the reporting is noisy.
      if (!result.baselined.find((b) => b.version === f.version)) {
        result.skipped.push({ version: f.version, name: f.name });
      }
      continue;
    }

    const started = Date.now();
    const tx = db.transaction(() => {
      db.exec(f.sql);
      insertApplied.run({ version: f.version, name: f.name, checksum: f.checksum });
    });
    try {
      tx();
    } catch (err) {
      const e = err as Error;
      logger.error({ version: f.version, name: f.name, err: e.message }, 'migration_failed');
      throw new MigrationError('apply_failed', `${f.name}: ${e.message}`);
    }
    const ms = Date.now() - started;
    result.applied.push({ version: f.version, name: f.name, checksum: f.checksum, ms });
    logger.info({ version: f.version, name: f.name, ms }, 'migration_applied');
  }

  return result;
}

/* ------------------------------------------------------------------ *
 *  Helpers                                                            *
 * ------------------------------------------------------------------ */

function loadMigrationFiles(dir: string): MigrationFile[] {
  const names = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  let lastVersion = 0;
  for (const name of names) {
    const version = parseVersion(name);
    if (version <= lastVersion) {
      throw new MigrationError('non_monotonic_version', `${name} <= previous ${lastVersion}`);
    }
    lastVersion = version;
    const sql      = readFileSync(path.join(dir, name), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
    out.push({ version, name, sql, checksum });
  }
  return out;
}

/**
 * Treat any user-authored table as evidence of a brownfield DB.
 *
 * A fresh-install SQLite file has no tables before `applyMigrations` runs;
 * `schema_migrations` itself is filtered out because we just created it a
 * few lines earlier.  `sqlite_*` internal tables are also filtered.
 */
function detectPreExistingUserTables(db: Database): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
      FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name != 'schema_migrations'
  `).get() as { n: number };
  return row.n > 0;
}

function parseVersion(filename: string): number {
  const m = /^(\d+)[_-]/.exec(filename);
  if (!m) throw new MigrationError('bad_filename', `missing numeric prefix: ${filename}`);
  const v = parseInt(m[1], 10);
  if (!Number.isFinite(v) || v <= 0) throw new MigrationError('bad_filename', filename);
  return v;
}

function parseEnvBaseline(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== raw.trim()) {
    throw new MigrationError('bad_env_baseline', `LH_DB_BASELINE=${raw}`);
  }
  return n;
}
