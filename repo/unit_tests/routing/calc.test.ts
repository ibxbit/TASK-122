import { describe, expect, it } from 'vitest';
import {
  summarizeRoute, summarizeLegs, RouteFormat, METERS_PER_MILE,
} from '../../src/main/routing/calc';

/* =========================================================================
 *  Route calculator — pure arithmetic over leg arrays.
 * ========================================================================= */

describe('summarizeRoute()', () => {
  const legs = [
    { distanceMeters: 1609.344, timeSeconds: 60,  tollCents: 100 },
    { distanceMeters: 3218.688, timeSeconds: 120, tollCents: 0 },
  ];

  it('aggregates distance, time, toll', () => {
    const r = summarizeRoute(legs, { perMileCents: 50, departAtUnix: 1000 });
    expect(r.distanceMeters).toBeCloseTo(4828.032);
    expect(r.distanceMiles).toBeCloseTo(3);
    expect(r.travelTimeSeconds).toBe(180);
    expect(r.tollCentsRaw).toBe(100);
  });

  it('applies toll multiplier', () => {
    const r = summarizeRoute(legs, { perMileCents: 50, tollMultiplier: 2, departAtUnix: 0 });
    expect(r.tollCentsEffective).toBe(200);
  });

  it('computes fuel + total cost', () => {
    const r = summarizeRoute(legs, { perMileCents: 50, departAtUnix: 0 });
    // 3 miles × 50 cents = 150
    expect(r.fuelCostCents).toBe(150);
    expect(r.totalCostCents).toBe(250); // 150 fuel + 100 toll
  });

  it('adds dwell time between interior stops', () => {
    const r = summarizeRoute(legs, {
      perMileCents: 0, departAtUnix: 0, dwellSecondsPerStop: 30,
    });
    // 2 legs → 1 interior stop → 30s dwell
    expect(r.dwellTimeSeconds).toBe(30);
    expect(r.totalTimeSeconds).toBe(210);
  });

  it('computes ETA = departAt + totalTime', () => {
    const r = summarizeRoute(legs, { perMileCents: 0, departAtUnix: 1000 });
    expect(r.etaUnixSeconds).toBe(1000 + 180);
  });
});

describe('summarizeLegs()', () => {
  it('emits per-leg arrivals with cumulative timing', () => {
    const legs = [
      { distanceMeters: METERS_PER_MILE,     timeSeconds: 60, tollCents: 0 },
      { distanceMeters: METERS_PER_MILE * 2, timeSeconds: 90, tollCents: 50 },
    ];
    const out = summarizeLegs(legs, { perMileCents: 100, departAtUnix: 0, dwellSecondsPerStop: 10 });
    expect(out).toHaveLength(2);
    expect(out[0].arrivalUnixSeconds).toBe(60);
    expect(out[1].arrivalUnixSeconds).toBe(60 + 10 + 90);
    expect(out[0].fuelCostCents).toBe(100);           // 1 mi × 100 cents
    expect(out[1].fuelCostCents).toBe(200);           // 2 mi × 100 cents
    expect(out[1].tollCostCentsEffective).toBe(50);
  });
});

describe('RouteFormat', () => {
  it('formats miles with 2 decimals', () => {
    expect(RouteFormat.miles(METERS_PER_MILE)).toBe('1.00 mi');
  });
  it('formats duration in h/m', () => {
    expect(RouteFormat.duration(3_600 + 120)).toBe('1h 02m');
    expect(RouteFormat.duration(125)).toBe('2m');
  });
  it('formats money as USD', () => {
    expect(RouteFormat.money(12_345)).toBe('$123.45');
  });
  it('formats ETA in ISO-ish UTC', () => {
    expect(RouteFormat.eta(0)).toBe('1970-01-01 00:00Z');
  });
});
