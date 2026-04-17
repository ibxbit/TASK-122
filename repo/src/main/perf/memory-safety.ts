import { logger } from '../logger';
import {
  resourceRegistry,
  type StatementCache, type ImageBufferCache, type RegistryStats,
} from '../resources/lifecycle';
import { perfMonitor, type PressureEvent } from './monitor';
import { getDbLifecycle, hasDbLifecycle } from '../db/cleanup';

/* =========================================================================
 * Memory Safety — the single coordinator for tracking + cleanup.
 *
 *  Inspects & enforces across three risk areas:
 *    1. DB prepared-statement caches
 *    2. Image-buffer caches + tracked buffers in ResourceRegistry
 *    3. Subsystem-specific disposables (via registerCleanupHook)
 *
 *  Binds automatically to:
 *    • perfMonitor pressure events (warn / critical) → trim / clear
 *    • application shutdown lifecycle               → full drain + DB close
 *
 *  Use this module as the PRIMARY pressure responder.  If used,
 *  perfMonitor.registerCaches({...}) can be skipped since memorySafety
 *  owns the same concern at a higher level.
 * ========================================================================= */

export type CleanupReason = 'shutdown' | 'pressure_warn' | 'pressure_critical' | 'manual';

export interface CleanupHook {
  id:    string;
  label: string;
  run:   (reason: CleanupReason) => void | Promise<void>;
}

export interface MemorySnapshot {
  statementCaches: Array<{ id: string; size: number }>;
  imageCaches:     Array<{ id: string; size: number; bytes: number }>;
  registry:        RegistryStats;
  hooks:           Array<{ id: string; label: string }>;
}

class MemorySafety {
  private readonly hooks           = new Map<string, CleanupHook>();
  private readonly statementCaches = new Map<string, StatementCache>();
  private readonly imageCaches     = new Map<string, ImageBufferCache>();

  private unsubscribePressure: (() => void) | null = null;
  private cleanupInFlight = false;

  /* ---- Lifecycle -------------------------------------------------- */

  install(): void {
    if (this.unsubscribePressure) return;
    this.unsubscribePressure = perfMonitor.onPressure((e) => this.onPressure(e));
    logger.info('memory_safety_installed');
  }

  uninstall(): void {
    this.unsubscribePressure?.();
    this.unsubscribePressure = null;
  }

  /* ---- Tracking --------------------------------------------------- */

  trackStatementCache(id: string, cache: StatementCache): void {
    this.statementCaches.set(id, cache);
  }

  untrackStatementCache(id: string): void {
    this.statementCaches.delete(id);
  }

  trackImageCache(id: string, cache: ImageBufferCache): void {
    this.imageCaches.set(id, cache);
  }

  untrackImageCache(id: string): void {
    this.imageCaches.delete(id);
  }

  /** Register a subsystem cleanup hook. Returns an unregister function. */
  registerCleanupHook(hook: CleanupHook): () => void {
    this.hooks.set(hook.id, hook);
    return () => { this.hooks.delete(hook.id); };
  }

  /* ---- Inspection ------------------------------------------------- */

  snapshot(): MemorySnapshot {
    return {
      statementCaches: [...this.statementCaches.entries()].map(([id, c]) => ({
        id, size: c.size(),
      })),
      imageCaches: [...this.imageCaches.entries()].map(([id, c]) => ({
        id, size: c.size(), bytes: c.totalBytes(),
      })),
      registry: resourceRegistry.stats(),
      hooks:    [...this.hooks.values()].map((h) => ({ id: h.id, label: h.label })),
    };
  }

  /* ---- Enforcement ------------------------------------------------ */

  async runCleanup(reason: CleanupReason): Promise<void> {
    if (this.cleanupInFlight) return;             // coalesce
    this.cleanupInFlight = true;
    try {
      logger.info({ reason, before: this.snapshot() }, 'memory_cleanup_start');

      // 1. User hooks — let subsystems release their own resources first.
      for (const hook of this.hooks.values()) {
        try { await hook.run(reason); }
        catch (err) { logger.error({ err, hook: hook.id }, 'cleanup_hook_failed'); }
      }

      const hard = reason === 'shutdown' || reason === 'pressure_critical';

      // 2. Statement caches — trim on warn, clear on critical/shutdown.
      for (const [id, c] of this.statementCaches) {
        if (hard) { c.clear(); logger.info({ id }, 'statement_cache_cleared'); }
        else       {
          const evicted = c.trim(Math.floor(c.size() / 2));
          if (evicted) logger.info({ id, evicted }, 'statement_cache_trimmed');
        }
      }

      // 3. Image caches.
      for (const [id, c] of this.imageCaches) {
        if (hard) { c.clear(); logger.info({ id }, 'image_cache_cleared'); }
        else       {
          const evicted = c.trim(Math.floor(c.totalBytes() / 2));
          if (evicted) logger.info({ id, evicted }, 'image_cache_trimmed');
        }
      }

      // 4. Registry-tracked image buffers — disposed only on hard cleanup.
      if (hard) {
        const n = await resourceRegistry.disposeByKind('image-buffer');
        if (n) logger.info({ disposed: n }, 'image_buffers_disposed');
      }

      logger.info({ reason, after: this.snapshot() }, 'memory_cleanup_done');
    } finally {
      this.cleanupInFlight = false;
    }
  }

  /**
   * Full drain then close the DB.  Call ONCE from the application shutdown
   * lifecycle (`app.on('before-quit')` → `checkpointer.stop` → `memorySafety.shutdown`).
   */
  async shutdown(): Promise<void> {
    await this.runCleanup('shutdown');
    if (hasDbLifecycle()) {
      try { await getDbLifecycle().shutdown(); }
      catch (err) { logger.error({ err }, 'memory_safety_db_close_failed'); }
    } else {
      logger.warn('memory_safety_no_db_lifecycle');
    }
  }

  /* ---- Pressure hook --------------------------------------------- */

  private onPressure(e: PressureEvent): void {
    if (e.level === 'ok') return;
    const reason: CleanupReason =
      e.level === 'critical' ? 'pressure_critical' : 'pressure_warn';
    void this.runCleanup(reason);
  }
}

export const memorySafety = new MemorySafety();
