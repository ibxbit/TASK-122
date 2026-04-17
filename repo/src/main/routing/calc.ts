/* =========================================================================
 * Route Calculation Engine
 *
 *  Pure functions — no I/O, no DB.  Consumes the per-leg output of the
 *  optimizer and produces an aggregate summary: distance, ETA, tolls, cost.
 *
 *    fuelCost   = distanceMiles × perMileCents         (cents)
 *    tollCost   = Σ toll_cents × tollMultiplier        (cents)
 *    totalCost  = fuelCost + tollCost                  (cents)
 *    totalTime  = Σ travelTime + dwellPerStop × (legs - 1)
 *    eta        = departAt + totalTime
 * ========================================================================= */

export const METERS_PER_MILE = 1609.344;

export interface RouteConfig {
  perMileCents:          number;       // driver / vehicle rate
  tollMultiplier?:       number;       // default 1.0
  dwellSecondsPerStop?:  number;       // service time at each interior stop
  departAtUnix?:         number;       // default "now"
}

export interface LegInput {
  distanceMeters:  number;
  timeSeconds:     number;
  tollCents:       number;
}

export interface RouteSummary {
  distanceMeters:      number;
  distanceMiles:       number;
  travelTimeSeconds:   number;
  dwellTimeSeconds:    number;
  totalTimeSeconds:    number;
  tollCentsRaw:        number;
  tollCentsEffective:  number;
  fuelCostCents:       number;
  totalCostCents:      number;
  etaUnixSeconds:      number;
}

export function summarizeRoute(legs: LegInput[], config: RouteConfig): RouteSummary {
  const distanceMeters    = legs.reduce((a, l) => a + l.distanceMeters, 0);
  const travelTimeSeconds = legs.reduce((a, l) => a + l.timeSeconds,    0);
  const tollCentsRaw      = legs.reduce((a, l) => a + l.tollCents,      0);

  const distanceMiles      = distanceMeters / METERS_PER_MILE;
  const tollMultiplier     = config.tollMultiplier ?? 1.0;
  const tollCentsEffective = Math.round(tollCentsRaw * tollMultiplier);
  const fuelCostCents      = Math.round(distanceMiles * config.perMileCents);
  const totalCostCents     = fuelCostCents + tollCentsEffective;

  const dwellPerStop     = Math.max(0, config.dwellSecondsPerStop ?? 0);
  const interiorStops    = Math.max(0, legs.length - 1);          // dwell happens between legs
  const dwellTimeSeconds = dwellPerStop * interiorStops;
  const totalTimeSeconds = travelTimeSeconds + dwellTimeSeconds;

  const depart         = config.departAtUnix ?? Math.floor(Date.now() / 1000);
  const etaUnixSeconds = depart + Math.round(totalTimeSeconds);

  return {
    distanceMeters,     distanceMiles,
    travelTimeSeconds,  dwellTimeSeconds,  totalTimeSeconds,
    tollCentsRaw,       tollCentsEffective,
    fuelCostCents,      totalCostCents,
    etaUnixSeconds,
  };
}

/** Per-leg summary mirroring RouteSummary shape — useful for itinerary UIs. */
export interface LegSummary extends LegInput {
  distanceMiles: number;
  fuelCostCents: number;
  tollCostCentsEffective: number;
  totalCostCents: number;
  arrivalUnixSeconds: number;      // cumulative
}

export function summarizeLegs(legs: LegInput[], config: RouteConfig): LegSummary[] {
  const mult   = config.tollMultiplier ?? 1.0;
  const dwell  = Math.max(0, config.dwellSecondsPerStop ?? 0);
  const depart = config.departAtUnix ?? Math.floor(Date.now() / 1000);

  let cumT = 0;
  return legs.map((l, i): LegSummary => {
    const miles     = l.distanceMeters / METERS_PER_MILE;
    const fuelCents = Math.round(miles * config.perMileCents);
    const tollEff   = Math.round(l.tollCents * mult);
    // Arrival at leg i = depart + (sum of previous leg times) + leg-i time.
    // Dwell is time spent AT each intermediate stop — it counts toward the
    // NEXT leg's arrival, not this leg's, so add it after computing cumT
    // for the current leg.
    cumT += l.timeSeconds;
    const arrivalAt = depart + Math.round(cumT);
    if (i < legs.length - 1) cumT += dwell;
    return {
      distanceMeters:          l.distanceMeters,
      timeSeconds:             l.timeSeconds,
      tollCents:               l.tollCents,
      distanceMiles:           miles,
      fuelCostCents:           fuelCents,
      tollCostCentsEffective:  tollEff,
      totalCostCents:          fuelCents + tollEff,
      arrivalUnixSeconds:      arrivalAt,
    };
  });
}

/* ------------------------------------------------------------------ *
 *  Human-friendly formatters — used by UI / PDF renderers.           *
 * ------------------------------------------------------------------ */

export const RouteFormat = {
  miles:    (meters: number) => `${(meters / METERS_PER_MILE).toFixed(2)} mi`,
  kilometres: (meters: number) => `${(meters / 1000).toFixed(2)} km`,
  duration: (seconds: number) => {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
  },
  money:    (cents: number) => `$${(cents / 100).toFixed(2)}`,
  eta:      (unixSeconds: number) =>
    new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z',
};
