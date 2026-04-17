import type { Database } from 'better-sqlite3';
import { logger } from '../logger';
import type { StatementCache } from '../resources/lifecycle';

/* =========================================================================
 * DB Lifecycle — owns the Database handle and every registered statement
 * cache, providing a single shutdown path that releases them all.
 *
 *  better-sqlite3 finalises all prepared statements when Database.close()
 *  is called, so correctness is guaranteed at shutdown.  This module
 *  handles the orthogonal concern: long-running sessions where statements
 *  accumulate in caches until the process dies.
 *
 *    drainStatementCaches()  — release cached statements while keeping the
 *                              connection open (used on memory pressure)
 *    shutdown()              — drain + PRAGMA optimize + close; idempotent
 *
 *  Also exposes getDb() as a convenience for modules that previously
 *  referenced a bare `getDb()` helper.
 * ========================================================================= */

export interface DbLifecycleDeps {
  db:               Database;
  statementCaches?: StatementCache[];
  optimiseOnClose?: boolean;        // default true
}

export class DbLifecycle {
  private _closed = false;
  private readonly caches: StatementCache[];

  constructor(private readonly deps: DbLifecycleDeps) {
    this.caches = [...(deps.statementCaches ?? [])];
  }

  get db(): Database { return this.deps.db; }
  get isOpen(): boolean { return !this._closed && this.deps.db.open; }

  registerStatementCache(cache: StatementCache): void {
    this.caches.push(cache);
  }

  /** Evict every cached prepared statement.  Keeps the connection open. */
  drainStatementCaches(): number {
    let n = 0;
    for (const c of this.caches) { n += c.size(); c.clear(); }
    if (n > 0) logger.info({ cleared: n }, 'db_statements_drained');
    return n;
  }

  /** Close the DB connection.  Idempotent.  Finalises every prepared statement. */
  async shutdown(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    this.drainStatementCaches();

    if (this.deps.optimiseOnClose !== false) {
      try { this.deps.db.pragma('optimize'); }
      catch (err) { logger.warn({ err }, 'db_optimize_failed'); }
    }

    try {
      this.deps.db.close();
      logger.info('db_closed');
    } catch (err) {
      logger.error({ err }, 'db_close_failed');
    }
  }

  stats(): { cachedStatements: number; open: boolean } {
    return {
      cachedStatements: this.caches.reduce((a, c) => a + c.size(), 0),
      open:             this.isOpen,
    };
  }
}

/* ------------------------------------------------------------------ *
 *  Singleton wiring — other modules import getDb() without threading. *
 * ------------------------------------------------------------------ */

let instance: DbLifecycle | null = null;

export function initDbLifecycle(deps: DbLifecycleDeps): DbLifecycle {
  if (instance) throw new Error('db_lifecycle_already_initialised');
  instance = new DbLifecycle(deps);
  return instance;
}

export function getDbLifecycle(): DbLifecycle {
  if (!instance) throw new Error('db_lifecycle_not_initialised');
  return instance;
}

export function getDb(): Database {
  return getDbLifecycle().db;
}

export function hasDbLifecycle(): boolean { return instance !== null; }
