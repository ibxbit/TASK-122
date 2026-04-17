import { describe, expect, it } from 'vitest';
import { startupTimer } from '../../src/main/perf/startup-timer';

/* =========================================================================
 *  StartupTimer — phases + summary cache (the singleton carries state across
 *  tests, so tests here stick to invariants that hold regardless of order).
 * ========================================================================= */

describe('startupTimer', () => {
  it('records process_start as the first phase on import', () => {
    expect(startupTimer.summary().phases[0].name).toBe('process_start');
  });

  it('adds new phases via mark()', () => {
    const before = startupTimer.summary().phases.length;
    startupTimer.mark('custom_phase_' + Math.random().toString(36).slice(2));
    expect(startupTimer.summary().phases.length).toBe(before + 1);
  });

  it('finish() marks a final phase and caches the summary', () => {
    // If already finished by a prior test, summary is idempotent.
    const s1 = startupTimer.finish('first_window_ready_test');
    const s2 = startupTimer.finish('ignored');
    expect(s1).toBe(s2);
    expect(s1.phases[s1.phases.length - 1].name).toMatch(/first_window_ready/);
  });

  it('underTargetMs correctly reflects totalMs vs target', () => {
    const s = startupTimer.summary();
    expect(s.underTargetMs).toBe(s.totalMs <= s.targetMs);
  });
});
