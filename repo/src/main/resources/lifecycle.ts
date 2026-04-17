import { logger } from '../logger';
import type { Statement } from 'better-sqlite3';

/* =========================================================================
 * Resource Lifecycle System
 *
 *  Three primitives:
 *    • ResourceScope / using()  — RAII-style scoped disposal (LIFO)
 *    • ResourceRegistry         — long-lived, labelled, byte-accounted
 *    • StatementCache / ImageBufferCache — the two concrete release targets
 *      called out by the spec ("release image buffers / DB statements")
 *
 *  Every cache exposes `size()`, `trim(target)`, and `clear()` so the perf
 *  monitor can enforce memory pressure without owning cache internals.
 * ========================================================================= */

/* ---- Disposable contract ------------------------------------------- */

export interface Disposable {
  dispose(): void | Promise<void>;
}

export type DisposeFn = () => void | Promise<void>;

/* ---- Scoped disposal ----------------------------------------------- */

export class ResourceScope implements Disposable {
  private readonly entries: Array<{ fn: DisposeFn; label?: string }> = [];
  private disposed = false;

  register<T extends Disposable>(r: T, label?: string): T {
    this.ensureAlive();
    this.entries.push({ fn: () => r.dispose(), label });
    return r;
  }

  registerFn(fn: DisposeFn, label?: string): void {
    this.ensureAlive();
    this.entries.push({ fn, label });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // LIFO — inner resources released before outer.
    while (this.entries.length > 0) {
      const { fn, label } = this.entries.pop()!;
      try   { await fn(); }
      catch (err) { logger.error({ err, label }, 'resource_dispose_failed'); }
    }
  }

  private ensureAlive(): void {
    if (this.disposed) throw new Error('resource_scope_disposed');
  }
}

/** Scope helper — dispose runs even when `fn` throws. */
export async function using<R>(
  fn: (scope: ResourceScope) => R | Promise<R>,
): Promise<R> {
  const scope = new ResourceScope();
  try       { return await fn(scope); }
  finally   { await scope.dispose(); }
}

/* ---- Global registry ----------------------------------------------- */

export interface TrackingHandle {
  readonly id:         string;
  readonly kind:       string;
  readonly label:      string;
  readonly bytes?:     number;
  readonly createdAt:  number;
}

interface RegistryEntry extends TrackingHandle { fn: DisposeFn; }

export interface RegistryStats {
  totalCount:  number;
  totalBytes:  number;
  byKind:      Record<string, { count: number; bytes: number }>;
}

export class ResourceRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private seq = 0;

  track(opts: { kind: string; label: string; dispose: DisposeFn; bytes?: number }): TrackingHandle {
    const id = `${opts.kind}_${++this.seq}`;
    const entry: RegistryEntry = {
      id, kind: opts.kind, label: opts.label, bytes: opts.bytes,
      createdAt: Date.now(), fn: opts.dispose,
    };
    this.entries.set(id, entry);
    return entry;
  }

  async untrack(handle: TrackingHandle): Promise<void> {
    const e = this.entries.get(handle.id);
    if (!e) return;
    this.entries.delete(handle.id);
    try   { await e.fn(); }
    catch (err) { logger.error({ err, id: e.id, label: e.label }, 'resource_untrack_failed'); }
  }

  async disposeByKind(kind: string): Promise<number> {
    const ids = [...this.entries.values()].filter((e) => e.kind === kind).map((e) => e.id);
    return this.disposeIds(ids);
  }

  async disposeAll(): Promise<number> {
    return this.disposeIds([...this.entries.keys()]);
  }

  stats(): RegistryStats {
    const byKind: Record<string, { count: number; bytes: number }> = {};
    let totalBytes = 0;
    for (const e of this.entries.values()) {
      const row = (byKind[e.kind] ??= { count: 0, bytes: 0 });
      row.count += 1;
      if (e.bytes) { row.bytes += e.bytes; totalBytes += e.bytes; }
    }
    return { totalCount: this.entries.size, totalBytes, byKind };
  }

  private async disposeIds(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e) continue;
      this.entries.delete(id);
      try   { await e.fn(); n++; }
      catch (err) { logger.error({ err, id, label: e.label }, 'resource_dispose_failed'); }
    }
    return n;
  }
}

export const resourceRegistry = new ResourceRegistry();

/* ---- StatementCache — prepared SQL, LRU by count ------------------- */

export interface StatementCacheOptions {
  maxEntries?: number;                   // default 256
  onEvict?: (sql: string) => void;
}

export class StatementCache {
  private readonly max: number;
  private readonly onEvict?: (sql: string) => void;
  // Map preserves insertion order → used as LRU.
  private readonly map = new Map<string, Statement>();

  constructor(options: StatementCacheOptions = {}) {
    this.max     = options.maxEntries ?? 256;
    this.onEvict = options.onEvict;
  }

  /** Fetch a prepared statement, preparing on miss.  LRU-touches on hit. */
  get(sql: string, prepare: () => Statement): Statement {
    const hit = this.map.get(sql);
    if (hit) {
      this.map.delete(sql); this.map.set(sql, hit);     // touch
      return hit;
    }
    const stmt = prepare();
    this.map.set(sql, stmt);
    while (this.map.size > this.max) this.evictOldest();
    return stmt;
  }

  size(): number { return this.map.size; }

  /** Evict oldest entries until count ≤ target. */
  trim(target: number): number {
    let evicted = 0;
    while (this.map.size > target) {
      this.evictOldest();
      evicted += 1;
    }
    return evicted;
  }

  clear(): void {
    for (const k of this.map.keys()) this.onEvict?.(k);
    this.map.clear();
  }

  private evictOldest(): void {
    const k = this.map.keys().next().value;
    if (k === undefined) return;
    this.map.delete(k);
    this.onEvict?.(k);
    // better-sqlite3 Statements hold native refs released on GC — nulling the
    // Map entry is all we need to do.
  }
}

/* ---- ImageBufferCache — LRU by total bytes ------------------------- */

export interface ImageBufferCacheOptions {
  maxBytes?: number;                      // default 64 MiB
}

export class ImageBufferCache {
  private readonly max: number;
  private readonly map = new Map<string, Buffer>();
  private bytesInUse = 0;

  constructor(options: ImageBufferCacheOptions = {}) {
    this.max = options.maxBytes ?? 64 * 1024 * 1024;
  }

  get(key: string): Buffer | undefined {
    const v = this.map.get(key);
    if (v) { this.map.delete(key); this.map.set(key, v); }      // touch
    return v;
  }

  set(key: string, buf: Buffer): void {
    const prev = this.map.get(key);
    if (prev) { this.bytesInUse -= prev.byteLength; this.map.delete(key); }
    this.map.set(key, buf);
    this.bytesInUse += buf.byteLength;
    while (this.bytesInUse > this.max && this.map.size > 0) this.evictOldest();
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (!v) return;
    this.bytesInUse -= v.byteLength;
    this.map.delete(key);
  }

  size(): number { return this.map.size; }
  totalBytes(): number { return this.bytesInUse; }

  /** Evict oldest entries until bytes ≤ targetBytes. */
  trim(targetBytes: number): number {
    let evicted = 0;
    while (this.bytesInUse > targetBytes && this.map.size > 0) {
      this.evictOldest();
      evicted += 1;
    }
    return evicted;
  }

  clear(): void {
    this.map.clear();
    this.bytesInUse = 0;
  }

  private evictOldest(): void {
    const k = this.map.keys().next().value;
    if (k === undefined) return;
    const v = this.map.get(k)!;
    this.map.delete(k);
    this.bytesInUse -= v.byteLength;
  }
}
