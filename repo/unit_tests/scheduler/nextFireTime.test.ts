import { describe, expect, it } from 'vitest';
import { nextFireTime } from '../../src/main/scheduler/Scheduler';

/* =========================================================================
 *  Scheduler — nextFireTime() math (daily + weekly, across wall-clock).
 * ========================================================================= */

describe('nextFireTime()', () => {
  it('daily: returns today if time has not passed', () => {
    const from = new Date(2025, 5, 15, 1, 0, 0);
    const next = nextFireTime({ kind: 'daily', hour: 6, minute: 0 }, from);
    expect(next.getHours()).toBe(6);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(15);
  });

  it('daily: rolls to tomorrow when time has passed', () => {
    const from = new Date(2025, 5, 15, 9, 0, 0);
    const next = nextFireTime({ kind: 'daily', hour: 6, minute: 0 }, from);
    expect(next.getDate()).toBe(16);
  });

  it('daily: same-minute boundary rolls forward (strict >)', () => {
    const from = new Date(2025, 5, 15, 6, 0, 0);
    const next = nextFireTime({ kind: 'daily', hour: 6, minute: 0 }, from);
    expect(next.getDate()).toBe(16);
  });

  it('weekly: picks the next occurrence of the target weekday', () => {
    // 2025-06-15 is a Sunday (0). Target Monday (1).
    const from = new Date(2025, 5, 15, 9, 0, 0);
    const next = nextFireTime({ kind: 'weekly', dayOfWeek: 1, hour: 7, minute: 0 }, from);
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(16);
  });

  it('weekly: rolls to following week when target is today but time passed', () => {
    // Monday at 09:00 — target Monday 07:00 → next week.
    const from = new Date(2025, 5, 16, 9, 0, 0);
    const next = nextFireTime({ kind: 'weekly', dayOfWeek: 1, hour: 7, minute: 0 }, from);
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(23);
  });
});
