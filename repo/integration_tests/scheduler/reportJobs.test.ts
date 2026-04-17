import { describe, expect, it } from 'vitest';
import { defineReportJobs, nextFireTime } from '../../src/main/scheduler/Scheduler';

/* =========================================================================
 *  Scheduler — defineReportJobs returns the concrete daily + weekly jobs.
 *  We don't invoke run() here (that requires a DB + exportCsv/Pdf = Electron);
 *  we validate the JobSpec shapes + nextFireTime alignment.
 * ========================================================================= */

describe('defineReportJobs()', () => {
  it('produces a daily 06:00 and weekly Mon 07:00 job', () => {
    const jobs = defineReportJobs(() => ['t1']);
    const daily  = jobs.find((j) => j.id === 'report.daily');
    const weekly = jobs.find((j) => j.id === 'report.weekly');
    expect(daily).toBeDefined();
    expect(weekly).toBeDefined();
    expect(daily!.spec).toEqual({ kind: 'daily', hour: 6, minute: 0 });
    expect(weekly!.spec).toEqual({ kind: 'weekly', dayOfWeek: 1, hour: 7, minute: 0 });
  });

  it('next fire time is strictly in the future', () => {
    const jobs = defineReportJobs(() => []);
    const now  = new Date();
    for (const j of jobs) {
      const next = nextFireTime(j.spec, now);
      expect(next.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
