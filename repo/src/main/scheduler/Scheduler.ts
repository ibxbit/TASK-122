import { logger } from '../logger';
import { getDb } from '../db';
import { buildReportSnapshot, type MetricFilters } from '../analytics/metrics';
import { exportCsv, exportPdf } from '../analytics/export.service';

/* =========================================================================
 * Scheduler — runs in the main process, independent of any window.
 *
 *  Only the schedule shapes used by this product are supported:
 *    { kind: 'daily',  hour, minute }
 *    { kind: 'weekly', dayOfWeek (0=Sun…6=Sat), hour, minute }
 *
 *  After each fire the job is re-scheduled from now().  Missed executions
 *  during sleep are NOT replayed — the next scheduled run still fires.
 *  Node timer delays > 2,147,483,647 ms are chunked to avoid overflow.
 * ========================================================================= */

export type JobSpec =
  | { kind: 'daily';  hour: number; minute: number; }
  | { kind: 'weekly'; dayOfWeek: 0|1|2|3|4|5|6; hour: number; minute: number; };

export interface Job {
  id:   string;
  spec: JobSpec;
  run:  () => Promise<void> | void;
}

const MAX_DELAY = 2_000_000_000;       // ~23 days, safely below INT32 max

/** Next absolute fire time for a spec, strictly after `from`. */
export function nextFireTime(spec: JobSpec, from: Date = new Date()): Date {
  const next = new Date(from);
  next.setSeconds(0, 0);

  if (spec.kind === 'daily') {
    next.setHours(spec.hour, spec.minute, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }

  // weekly
  next.setHours(spec.hour, spec.minute, 0, 0);
  const diff = (spec.dayOfWeek - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + diff);
  if (next <= from) next.setDate(next.getDate() + 7);
  return next;
}

export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(private readonly jobs: Job[]) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const j of this.jobs) this.schedule(j);
    logger.info({ count: this.jobs.length }, 'scheduler_started');
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    logger.info('scheduler_stopped');
  }

  private schedule(job: Job): void {
    if (!this.running) return;
    const fireAt    = nextFireTime(job.spec);
    const totalMs   = Math.max(0, fireAt.getTime() - Date.now());
    const chunkMs   = Math.min(totalMs, MAX_DELAY);
    const overflow  = totalMs - chunkMs;

    const timer = setTimeout(() => {
      if (overflow > 0) { this.schedule(job); return; }   // re-compute next chunk
      void this.fire(job);
    }, chunkMs);

    this.timers.set(job.id, timer);
    if (overflow === 0) logger.info({ job: job.id, fireAt: fireAt.toISOString() }, 'job_scheduled');
  }

  private async fire(job: Job): Promise<void> {
    if (!this.running) return;
    const started = Date.now();
    try {
      await job.run();
      logger.info({ job: job.id, duration_ms: Date.now() - started }, 'job_completed');
    } catch (err) {
      logger.error({ job: job.id, err }, 'job_failed');
    } finally {
      if (this.running) this.schedule(job);              // chain next occurrence
    }
  }
}

/* =========================================================================
 *  Report jobs — the concrete schedule required by the product:
 *    • Daily  at 06:00 local → prior calendar day
 *    • Weekly at Mon 07:00   → prior 7 days (prev Mon 00:00 → this Mon 00:00)
 *
 *  Jobs iterate every tenant returned by the injected resolver so multi-
 *  tenant deployments produce one report artefact per tenant per format.
 * ========================================================================= */

export function defineReportJobs(resolveTenantIds: () => string[]): Job[] {
  const runRange = async (from: Date, to: Date) => {
    const db = getDb();
    const tenants = resolveTenantIds();
    const filters: Omit<MetricFilters, 'tenantId'> = {
      from: Math.floor(from.getTime() / 1000),
      to:   Math.floor(to.getTime()   / 1000),
    };
    for (const tenantId of tenants) {
      const snap = buildReportSnapshot(db, { tenantId, ...filters });
      await exportCsv(snap);
      await exportPdf(snap);
    }
  };

  return [
    {
      id:   'report.daily',
      spec: { kind: 'daily', hour: 6, minute: 0 },
      run:  () => {
        const end   = startOfDay(new Date());           // today 00:00
        const start = addDays(end, -1);                 // yesterday 00:00
        return runRange(start, end);
      },
    },
    {
      id:   'report.weekly',
      spec: { kind: 'weekly', dayOfWeek: 1, hour: 7, minute: 0 },   // Monday
      run:  () => {
        const end   = startOfDay(new Date());           // this Monday 00:00
        const start = addDays(end, -7);                 // previous Monday 00:00
        return runRange(start, end);
      },
    },
  ];
}

/* ------------------------------------------------------------------ */

function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
