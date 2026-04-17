import { performance } from 'node:perf_hooks';
import { logger } from '../logger';
import { perfMonitor, COLD_START_TARGET_MS } from './monitor';

/* =========================================================================
 * StartupTimer — cold-start measurement from process launch through first
 * window ready.
 *
 *  Timing semantics:
 *    t = 0          moment this module is imported (≈ process start)
 *    mark(name)     record a milestone; emits `startup_phase` log
 *    finish(label)  mark final phase; emits `startup_complete` log
 *
 *  Phases are also forwarded to perfMonitor.markColdStart() so they appear
 *  in perfMonitor.snapshot().coldStart for dashboards + IPC diagnostics.
 *
 *  IMPORT ORDER MATTERS — this module should be one of the first imports
 *  in the main bootstrap so `process_start` pegs close to real t=0.
 * ========================================================================= */

export const STARTUP_TARGET_MS = COLD_START_TARGET_MS;

export interface StartupPhase {
  name:     string;
  atMs:     number;           // ms since module import
  deltaMs:  number;           // since prior phase
}

export interface StartupSummary {
  totalMs:        number;
  targetMs:       number;
  underTargetMs:  boolean;
  phases:         StartupPhase[];
  finishedAt:     string;     // ISO-8601
}

class StartupTimer {
  private readonly origin = performance.now();
  private readonly phases: StartupPhase[] = [];
  private lastAt:   number | null = null;
  private finished = false;
  private cached:   StartupSummary | null = null;

  constructor() {
    // Anchor at t=0 so subsequent deltas are meaningful.
    this.mark('process_start');
  }

  /** Record a milestone; safe to call before or after perfMonitor.start(). */
  mark(name: string): StartupPhase {
    const atMs    = Math.round(performance.now() - this.origin);
    const deltaMs = this.lastAt === null ? atMs : atMs - this.lastAt;
    this.lastAt   = atMs;

    const phase: StartupPhase = { name, atMs, deltaMs };
    this.phases.push(phase);

    logger.info(phase, 'startup_phase');
    try { perfMonitor.markColdStart(name); }
    catch { /* perfMonitor may not be ready; safe to ignore */ }
    return phase;
  }

  /**
   * Marks the final phase (default `first_window_ready`) and emits a
   * structured summary: `startup_complete` at info level when under the
   * 3 s target, `startup_complete_over_target` at warn level otherwise.
   */
  finish(label: string = 'first_window_ready'): StartupSummary {
    if (this.finished) return this.cached!;
    this.mark(label);
    const totalMs = this.phases[this.phases.length - 1].atMs;
    const summary: StartupSummary = {
      totalMs,
      targetMs:      STARTUP_TARGET_MS,
      underTargetMs: totalMs <= STARTUP_TARGET_MS,
      phases:        this.phases.slice(),
      finishedAt:    new Date().toISOString(),
    };
    this.finished = true;
    this.cached   = summary;

    if (summary.underTargetMs) logger.info(summary, 'startup_complete');
    else                       logger.warn(summary, 'startup_complete_over_target');
    return summary;
  }

  isFinished(): boolean { return this.finished; }

  /** Current summary (complete if finish() was called, else in-progress). */
  summary(): StartupSummary {
    if (this.cached) return this.cached;
    const totalMs = this.phases.length > 0
      ? this.phases[this.phases.length - 1].atMs
      : 0;
    return {
      totalMs,
      targetMs:      STARTUP_TARGET_MS,
      underTargetMs: totalMs <= STARTUP_TARGET_MS,
      phases:        this.phases.slice(),
      finishedAt:    new Date().toISOString(),
    };
  }
}

export const startupTimer = new StartupTimer();
