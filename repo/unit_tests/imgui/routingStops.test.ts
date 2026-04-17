import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({}));

import {
  validateStopCount, MIN_STOPS_CLIENT, MAX_STOPS_CLIENT,
} from '../../src/renderer/imgui/views/routing';

describe('routing stop-count bounds', () => {
  it('exports MIN=2 MAX=25 matching the backend', () => {
    expect(MIN_STOPS_CLIENT).toBe(2);
    expect(MAX_STOPS_CLIENT).toBe(25);
  });

  it('0 stops → too_few', () => {
    const r = validateStopCount([]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('too_few');
    expect(r.filled).toBe(0);
  });

  it('1 stop → too_few', () => {
    expect(validateStopCount(['one']).error).toBe('too_few');
  });

  it('2 stops → ok (lower boundary)', () => {
    expect(validateStopCount(['a', 'b'])).toEqual({ ok: true, filled: 2 });
  });

  it('4 stops → ok (common case)', () => {
    expect(validateStopCount(['a','b','c','d'])).toEqual({ ok: true, filled: 4 });
  });

  it('25 stops → ok (upper boundary)', () => {
    const twentyfive = Array.from({ length: 25 }, (_, i) => `stop-${i}`);
    expect(validateStopCount(twentyfive)).toEqual({ ok: true, filled: 25 });
  });

  it('26 stops → too_many', () => {
    const twentysix = Array.from({ length: 26 }, (_, i) => `stop-${i}`);
    const r = validateStopCount(twentysix);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('too_many');
    expect(r.filled).toBe(26);
  });

  it('whitespace-only entries are not counted', () => {
    expect(validateStopCount(['  ', '', 'a', 'b']).filled).toBe(2);
    expect(validateStopCount(['  ', '', 'a']).error).toBe('too_few');
  });
});
