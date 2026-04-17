import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* =========================================================================
 * Scheduler execution path — tests the ACTUAL job invocation, not just
 * the schedule-shape.  We install fake timers, queue a fast-firing job,
 * advance, and assert the job ran.  Errors do not crash the scheduler.
 * ========================================================================= */

import { Scheduler, nextFireTime } from '../../src/main/scheduler/Scheduler';

describe('Scheduler — real execution path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin time so nextFireTime is deterministic.
    vi.setSystemTime(new Date('2026-03-01T05:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires a daily job when the clock reaches its fire time', async () => {
    const ran: number[] = [];
    const job = {
      id:   'daily.test',
      spec: { kind: 'daily' as const, hour: 6, minute: 0 },
      run:  () => { ran.push(Date.now()); },
    };
    const s = new Scheduler([job]);

    s.start();
    // 1h later → job fires; add a comfortable slack for chunking.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 10);
    expect(ran.length).toBe(1);

    // Another 24h → fires again.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(ran.length).toBe(2);

    s.stop();
  });

  it('survives a failing job without halting subsequent fires', async () => {
    const attempts: number[] = [];
    let threw = 0;
    const job = {
      id:   'flaky',
      spec: { kind: 'daily' as const, hour: 6, minute: 0 },
      run:  () => {
        attempts.push(Date.now());
        if (attempts.length === 1) { threw += 1; throw new Error('boom'); }
      },
    };
    const s = new Scheduler([job]);
    s.start();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 10);
    expect(attempts.length).toBe(1);
    expect(threw).toBe(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(attempts.length).toBe(2);

    s.stop();
  });

  it('stop prevents further fires', async () => {
    const ran: number[] = [];
    const s = new Scheduler([{
      id: 'stoppable',
      spec: { kind: 'daily', hour: 6, minute: 0 },
      run: () => ran.push(Date.now()),
    }]);
    s.start();
    s.stop();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
    expect(ran).toEqual([]);
  });

  it('nextFireTime for weekly spec lands on correct weekday', () => {
    // Start: 2026-03-01T05:00:00Z is a Sunday in UTC.  Ask for Monday 07:00.
    const at = nextFireTime({ kind: 'weekly', dayOfWeek: 1, hour: 7, minute: 0 });
    expect(at.getDay()).toBe(1);   // 1 = Monday in local time
  });
});
