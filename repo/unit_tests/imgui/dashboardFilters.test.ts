import { describe, it, expect } from 'vitest';
import { buildSnapshotPayloadFromFilters } from '../../src/renderer/imgui/views/dashboard';

/* =========================================================================
 * Dashboard filter → IPC payload conversion.
 * ========================================================================= */

describe('buildSnapshotPayloadFromFilters', () => {
  it('returns an empty payload when every field is blank', () => {
    expect(buildSnapshotPayloadFromFilters({})).toEqual({});
    expect(buildSnapshotPayloadFromFilters({
      storeId: '   ', from: '', to: '  ', hourOfDay: '',
    })).toEqual({});
  });

  it('trims storeId and includes only when non-empty', () => {
    expect(buildSnapshotPayloadFromFilters({ storeId: '  store-A  ' }))
      .toEqual({ storeId: 'store-A' });
  });

  it('converts ISO dates to unix seconds (UTC midnight)', () => {
    const r = buildSnapshotPayloadFromFilters({ from: '2026-04-01', to: '2026-05-01' });
    expect(r.from).toBe(Date.UTC(2026, 3, 1) / 1000);
    expect(r.to).toBe  (Date.UTC(2026, 4, 1) / 1000);
  });

  it('rejects bad date strings silently (drops the field)', () => {
    expect(buildSnapshotPayloadFromFilters({ from: 'not-a-date' })).toEqual({});
  });

  it('parses hourOfDay (0..23) and drops anything out of range', () => {
    expect(buildSnapshotPayloadFromFilters({ hourOfDay: '0' })).toEqual({ hourOfDay: 0 });
    expect(buildSnapshotPayloadFromFilters({ hourOfDay: '23' })).toEqual({ hourOfDay: 23 });
    expect(buildSnapshotPayloadFromFilters({ hourOfDay: '24' })).toEqual({});
    expect(buildSnapshotPayloadFromFilters({ hourOfDay: '-1' })).toEqual({});
    expect(buildSnapshotPayloadFromFilters({ hourOfDay: 'x' })).toEqual({});
  });

  it('composes every filter together', () => {
    const r = buildSnapshotPayloadFromFilters({
      storeId: 'store-A', from: '2026-04-01', to: '2026-04-02', hourOfDay: '14',
    });
    expect(r).toMatchObject({ storeId: 'store-A', hourOfDay: 14 });
    expect(typeof r.from).toBe('number');
    expect(typeof r.to).toBe('number');
  });
});
