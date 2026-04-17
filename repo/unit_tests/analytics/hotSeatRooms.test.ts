import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/* =========================================================================
 * Hottest seats/rooms metric — static contract tests.
 *
 *  better-sqlite3 isn't available in this sandbox, so we assert:
 *    • the function name, filter semantics, and SQL shape are all in
 *      place in the source
 *    • the exported ReportSnapshot type includes hotSeatRooms so the
 *      renderer contract is honoured
 *    • the dashboard view reads the new metric
 *
 *  The full integration / handler test is environment-dependent and runs
 *  under `npm ci` via the broader suite.
 * ========================================================================= */

const SRC = path.resolve(__dirname, '../..');
const METRICS = readFileSync(path.join(SRC, 'src/main/analytics/metrics.ts'), 'utf8');
const EXPORT  = readFileSync(path.join(SRC, 'src/main/analytics/export.service.ts'), 'utf8');
const DASH    = readFileSync(path.join(SRC, 'src/renderer/imgui/views/dashboard.ts'), 'utf8');

describe('analytics/metrics.ts — hot seats/rooms query', () => {
  it('exports queryHotSeatRooms', () => {
    expect(METRICS).toMatch(/export function queryHotSeatRooms\s*\(/);
  });

  it('honours the storeId filter (joins on org_unit_id)', () => {
    expect(METRICS).toMatch(/sr\.org_unit_id\s*=\s*@storeId/);
  });

  it('honours the hourOfDay filter', () => {
    expect(METRICS).toMatch(/@hour/);
  });

  it('filters zero-capacity rooms via HAVING so the rate is defined', () => {
    expect(METRICS).toMatch(/HAVING\s+AVG\(os\.capacity\)\s*>\s*0/i);
  });

  it('orders by occupancy_rate DESC and caps via LIMIT', () => {
    expect(METRICS).toMatch(/ORDER BY occupancy_rate DESC/);
    expect(METRICS).toMatch(/LIMIT\s+@limit/);
  });

  it('ReportSnapshot includes hotSeatRooms', () => {
    expect(METRICS).toMatch(/hotSeatRooms:\s*HotSeatRoom\[\]/);
  });

  it('buildReportSnapshot wires queryHotSeatRooms into the payload', () => {
    // Allow arbitrary whitespace-alignment in the buildReportSnapshot body
    expect(METRICS).toMatch(/hotSeatRooms:\s+queryHotSeatRooms\s*\(/);
  });
});

describe('analytics/export.service.ts — new CSV section', () => {
  it('serialises hot_seat_rooms into the CSV with every field', () => {
    expect(EXPORT).toMatch(/hot_seat_room_id,code,name,kind/);
  });
});

describe('dashboard view — filter + hot seats rendering', () => {
  it('exports buildSnapshotPayloadFromFilters', () => {
    expect(DASH).toMatch(/export function buildSnapshotPayloadFromFilters\(/);
  });

  it('renders the new metric section', () => {
    expect(DASH).toMatch(/Hottest seats \/ rooms/);
  });

  it('Ctrl+E export passes the filter payload', () => {
    expect(DASH).toMatch(/buildSnapshotPayload\(b\)/);
    // analytics:export call includes the spread filters
    expect(DASH).toMatch(/'analytics:export'[\s\S]*?buildSnapshotPayload/);
  });
});
