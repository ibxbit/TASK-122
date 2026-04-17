import { app } from 'electron';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { logger } from '../logger';
import {
  resourceRegistry,
  type RegistryStats,
  type StatementCache,
  type ImageBufferCache,
} from '../resources/lifecycle';

/* =========================================================================
 * Performance Monitor
 *
 *  • Cold-start phase tracking  → validate < 3 s target
 *  • Memory sampling (self + all Electron processes) → enforce < 300 MB
 *  • Event-loop-delay histogram → surfaces main-process stalls
 *  • Timed wrappers for hot paths
 *  • Memory-pressure hooks that automatically trim or clear registered
 *    StatementCache + ImageBufferCache (the two release targets from spec)
 * ========================================================================= */

export interface PhaseMark {
  phase:    string;
  at:       number;       // ms since process start (performance.now)
  deltaMs:  number;       // since prior phase
}

export interface MetricSample {
  name:     string;
  valueMs:  number;
  tags?:    Record<string, string>;
  at:       number;
}

export interface MemorySample {
  rssMb:           number;
  heapUsedMb:      number;
  heapTotalMb:     number;
  externalMb:      number;
  arrayBuffersMb:  number;
  at:              number;
}

export interface AppMemorySample {
  processes: Array<{ type: string; pid: number; name?: string; memoryMb: number }>;
  totalMb:   number;
  at:        number;
}

export type PressureLevel = 'ok' | 'warn' | 'critical';

export interface PressureEvent {
  level:   PressureLevel;
  prior:   PressureLevel;
  rssMb:   number;
  totalMb: number;
  at:      number;
}

export interface PerfSnapshot {
  coldStart: {
    phases:         PhaseMark[];
    totalMs:        number | null;          // first → last phase
    underTargetMs:  boolean;
  };
  memory:     MemorySample;
  appMemory:  AppMemorySample;
  eventLoop:  { meanMs: number; p99Ms: number; maxMs: number };
  metrics:    MetricSample[];
  resources:  RegistryStats;
  pressure:   PressureLevel;
}

/* =========================================================================
 *  Thresholds — target is 300 MB, so warn at 80 % and critical at 95 %.
 * ========================================================================= */

export const COLD_START_TARGET_MS       = 3_000;
export const MEMORY_BUDGET_MB           = 300;
export const MEMORY_WARN_MB             = 240;      // 80 %
export const MEMORY_CRITICAL_MB         = 285;      // 95 %
export const MEMORY_SAMPLE_INTERVAL_MS  = 30_000;   // periodic memory log cadence
export const EVENT_LOOP_LAG_WARN_MS     = 50;

const METRICS_RING = 500;

class PerfMonitor {
  private phases:       PhaseMark[]    = [];
  private lastPhaseAt:  number | null  = null;
  private metrics:      MetricSample[] = [];

  private loopMon        = monitorEventLoopDelay({ resolution: 20 });
  private memTimer:       NodeJS.Timeout | null = null;
  private loopCheckTimer: NodeJS.Timeout | null = null;

  private pressureLevel: PressureLevel = 'ok';
  private readonly pressureListeners = new Set<(e: PressureEvent) => void>();

  private caches: { statements?: StatementCache; images?: ImageBufferCache } = {};

  /** Call from main before app.whenReady(). */
  start(): void {
    this.loopMon.enable();
    this.memTimer       = setInterval(() => this.periodicSample(),  MEMORY_SAMPLE_INTERVAL_MS);
    this.loopCheckTimer = setInterval(() => this.checkEventLoop(),  15_000);
    this.memTimer.unref();
    this.loopCheckTimer.unref();
    this.markColdStart('monitor_started');
  }

  stop(): void {
    this.loopMon.disable();
    if (this.memTimer)       clearInterval(this.memTimer);
    if (this.loopCheckTimer) clearInterval(this.loopCheckTimer);
    this.memTimer = this.loopCheckTimer = null;
  }

  /* ---------- Cold-start phase marks ------------------------------ */

  markColdStart(phase: string): PhaseMark {
    const at      = Math.round(performance.now());
    const deltaMs = this.lastPhaseAt === null ? at : at - this.lastPhaseAt;
    const mark: PhaseMark = { phase, at, deltaMs };
    this.phases.push(mark);
    this.lastPhaseAt = at;

    if (phase === 'app_ready') {
      this.recordMetric('cold_start_total_ms', at);
      if (at > COLD_START_TARGET_MS) {
        logger.warn({ at, target: COLD_START_TARGET_MS }, 'cold_start_over_target');
      }
    }
    logger.info(mark, 'cold_start_phase');
    return mark;
  }

  /* ---------- Metric samples ------------------------------------- */

  recordMetric(name: string, valueMs: number, tags?: Record<string, string>): void {
    this.metrics.push({ name, valueMs, tags, at: Date.now() });
    if (this.metrics.length > METRICS_RING) this.metrics.shift();
  }

  /* ---------- Memory sampling ------------------------------------ */

  sampleMemory(): MemorySample {
    const m = process.memoryUsage();
    const sample: MemorySample = {
      rssMb:          toMb(m.rss),
      heapUsedMb:     toMb(m.heapUsed),
      heapTotalMb:    toMb(m.heapTotal),
      externalMb:     toMb(m.external),
      arrayBuffersMb: toMb(m.arrayBuffers ?? 0),
      at:             Date.now(),
    };
    const app = this.sampleAppMemory();
    this.evaluatePressure(sample.rssMb, app.totalMb);
    return sample;
  }

  /**
   * Periodic sampler — runs on the MEMORY_SAMPLE_INTERVAL_MS timer.
   * Emits one structured `memory_sample` log line per tick (Task 2
   * requirement) and a distinct `memory_budget_exceeded` warning when RSS
   * or aggregate app memory crosses the 300 MB budget — independent of
   * the warn/critical pressure ladder.
   */
  private periodicSample(): void {
    const mem = this.sampleMemory();
    const app = this.sampleAppMemory();

    logger.info(
      {
        rssMb:          mem.rssMb,
        heapUsedMb:     mem.heapUsedMb,
        heapTotalMb:    mem.heapTotalMb,
        externalMb:     mem.externalMb,
        arrayBuffersMb: mem.arrayBuffersMb,
        appTotalMb:     app.totalMb,
        pressure:       this.pressureLevel,
      },
      'memory_sample',
    );

    const budgetProbe = Math.max(mem.rssMb, app.totalMb);
    if (budgetProbe > MEMORY_BUDGET_MB) {
      logger.warn(
        {
          rssMb:      mem.rssMb,
          appTotalMb: app.totalMb,
          budgetMb:   MEMORY_BUDGET_MB,
          overByMb:   +(budgetProbe - MEMORY_BUDGET_MB).toFixed(1),
        },
        'memory_budget_exceeded',
      );
    }
  }

  /** Aggregate memory across main + renderers + GPU + utility processes. */
  sampleAppMemory(): AppMemorySample {
    let processes: AppMemorySample['processes'] = [];
    try {
      processes = app.getAppMetrics().map((m) => ({
        type:     m.type,
        pid:      m.pid,
        name:     m.name,
        memoryMb: +(m.memory.workingSetSize / 1024).toFixed(1),   // KiB → MiB
      }));
    } catch { /* app not ready yet */ }
    const totalMb = processes.reduce((a, p) => a + p.memoryMb, 0);
    return { processes, totalMb, at: Date.now() };
  }

  /* ---------- Event-loop surveillance ---------------------------- */

  private checkEventLoop(): void {
    const meanMs = this.loopMon.mean / 1e6;
    if (meanMs > EVENT_LOOP_LAG_WARN_MS) {
      logger.warn(
        { meanMs: +meanMs.toFixed(2), p99Ms: +(this.loopMon.percentile(99) / 1e6).toFixed(2) },
        'event_loop_lag_high',
      );
    }
    this.loopMon.reset();
  }

  /* ---------- Pressure handling ---------------------------------- */

  onPressure(handler: (e: PressureEvent) => void): () => void {
    this.pressureListeners.add(handler);
    return () => { this.pressureListeners.delete(handler); };
  }

  registerCaches(c: { statements?: StatementCache; images?: ImageBufferCache }): void {
    this.caches = { ...this.caches, ...c };
  }

  private evaluatePressure(rssMb: number, totalMb: number): void {
    const budgetProbe = Math.max(rssMb, totalMb);       // whichever is closer to budget
    const next: PressureLevel =
        budgetProbe >= MEMORY_CRITICAL_MB ? 'critical'
      : budgetProbe >= MEMORY_WARN_MB     ? 'warn'
      :                                     'ok';

    if (next === this.pressureLevel) return;

    const event: PressureEvent = {
      level: next, prior: this.pressureLevel,
      rssMb, totalMb, at: Date.now(),
    };
    this.pressureLevel = next;

    logger[next === 'critical' ? 'error' : next === 'warn' ? 'warn' : 'info'](
      event, 'memory_pressure',
    );

    for (const fn of this.pressureListeners) {
      try   { fn(event); }
      catch (err) { logger.error({ err }, 'pressure_listener_failed'); }
    }

    if (next === 'warn')     this.releaseSoft();
    if (next === 'critical') this.releaseHard();
  }

  private releaseSoft(): void {
    const images = this.caches.images;
    if (images) {
      const evicted = images.trim(Math.floor(images.totalBytes() / 2));
      if (evicted) logger.info({ evicted, kind: 'image' }, 'perf_release_soft');
    }
    const stmts = this.caches.statements;
    if (stmts) {
      const evicted = stmts.trim(Math.floor(stmts.size() / 2));
      if (evicted) logger.info({ evicted, kind: 'statement' }, 'perf_release_soft');
    }
  }

  private releaseHard(): void {
    if (this.caches.images)     { this.caches.images.clear();     logger.warn('perf_release_hard_images'); }
    if (this.caches.statements) { this.caches.statements.clear(); logger.warn('perf_release_hard_statements'); }
    // Hint the GC if exposed (--expose-gc).  Otherwise no-op.
    const maybeGc = (globalThis as { gc?: () => void }).gc;
    if (typeof maybeGc === 'function') {
      try { maybeGc(); logger.info('perf_gc_invoked'); } catch { /* ignore */ }
    }
  }

  /* ---------- Snapshot (used by dashboards / IPC) ---------------- */

  snapshot(): PerfSnapshot {
    const totalMs = this.phases.length >= 2
      ? this.phases[this.phases.length - 1].at - this.phases[0].at
      : null;

    return {
      coldStart: {
        phases:        this.phases.slice(),
        totalMs,
        underTargetMs: totalMs !== null && totalMs <= COLD_START_TARGET_MS,
      },
      memory:    this.sampleMemoryOnly(),
      appMemory: this.sampleAppMemory(),
      eventLoop: {
        meanMs: +(this.loopMon.mean / 1e6).toFixed(2),
        p99Ms:  +(this.loopMon.percentile(99) / 1e6).toFixed(2),
        maxMs:  +(this.loopMon.max / 1e6).toFixed(2),
      },
      metrics:   this.metrics.slice(-50),
      resources: resourceRegistry.stats(),
      pressure:  this.pressureLevel,
    };
  }

  /** Memory sample WITHOUT triggering pressure evaluation — safe inside snapshot(). */
  private sampleMemoryOnly(): MemorySample {
    const m = process.memoryUsage();
    return {
      rssMb:          toMb(m.rss),
      heapUsedMb:     toMb(m.heapUsed),
      heapTotalMb:    toMb(m.heapTotal),
      externalMb:     toMb(m.external),
      arrayBuffersMb: toMb(m.arrayBuffers ?? 0),
      at:             Date.now(),
    };
  }
}

export const perfMonitor = new PerfMonitor();

/* ---- Timed wrappers ------------------------------------------------ */

export function timed<T>(name: string, fn: () => T, tags?: Record<string, string>): T {
  const start = performance.now();
  try       { return fn(); }
  finally   { perfMonitor.recordMetric(name, performance.now() - start, tags); }
}

export async function timedAsync<T>(
  name: string,
  fn: () => Promise<T>,
  tags?: Record<string, string>,
): Promise<T> {
  const start = performance.now();
  try       { return await fn(); }
  finally   { perfMonitor.recordMetric(name, performance.now() - start, tags); }
}

/* ---- helpers ------------------------------------------------------- */

function toMb(bytes: number): number {
  return +(bytes / (1024 * 1024)).toFixed(1);
}
