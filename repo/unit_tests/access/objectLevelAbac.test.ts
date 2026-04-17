import { describe, it, expect } from 'vitest';
import { recordMatchesScope, type ScopeFilter } from '../../src/main/access/evaluator';

/* =========================================================================
 * Object-Level ABAC Tests
 *
 *  Verifies that recordMatchesScope() correctly enforces attribute-based
 *  access control at the individual record level:
 *    - Unrestricted scope allows any record
 *    - Empty scope denies all records (fail-closed)
 *    - Single clause with eq match
 *    - Single clause with array (IN) match
 *    - Multiple OR clauses (any match = allow)
 *    - No matching clause = deny (fail-closed)
 *    - Unknown attributes in record don't cause crashes
 * ========================================================================= */

describe('recordMatchesScope — object-level ABAC', () => {
  it('unrestricted scope allows any record', () => {
    const scope: ScopeFilter = { anyOf: [], unrestricted: true };
    expect(recordMatchesScope({ org_unit_id: 'loc_1' }, scope)).toBe(true);
    expect(recordMatchesScope({}, scope)).toBe(true);
  });

  it('empty scope with unrestricted=false denies all records (fail-closed)', () => {
    const scope: ScopeFilter = { anyOf: [], unrestricted: false };
    expect(recordMatchesScope({ org_unit_id: 'loc_1' }, scope)).toBe(false);
    expect(recordMatchesScope({}, scope)).toBe(false);
  });

  it('single clause eq match — allowed', () => {
    const scope: ScopeFilter = {
      anyOf: [{ locationId: 'loc_nyc' }],
      unrestricted: false,
    };
    expect(recordMatchesScope({ locationId: 'loc_nyc' }, scope)).toBe(true);
  });

  it('single clause eq match — denied', () => {
    const scope: ScopeFilter = {
      anyOf: [{ locationId: 'loc_nyc' }],
      unrestricted: false,
    };
    expect(recordMatchesScope({ locationId: 'loc_sf' }, scope)).toBe(false);
  });

  it('single clause with array (IN) match', () => {
    const scope: ScopeFilter = {
      anyOf: [{ locationId: ['loc_nyc', 'loc_sf', 'loc_chi'] }],
      unrestricted: false,
    };
    expect(recordMatchesScope({ locationId: 'loc_sf' }, scope)).toBe(true);
    expect(recordMatchesScope({ locationId: 'loc_la' }, scope)).toBe(false);
  });

  it('multiple OR clauses — any match = allow', () => {
    const scope: ScopeFilter = {
      anyOf: [
        { departmentId: 'dept_eng' },
        { locationId: 'loc_nyc' },
      ],
      unrestricted: false,
    };
    expect(recordMatchesScope({ departmentId: 'dept_eng', locationId: 'loc_sf' }, scope)).toBe(true);
    expect(recordMatchesScope({ departmentId: 'dept_hr', locationId: 'loc_nyc' }, scope)).toBe(true);
    expect(recordMatchesScope({ departmentId: 'dept_hr', locationId: 'loc_sf' }, scope)).toBe(false);
  });

  it('AND within a clause — all keys must match', () => {
    const scope: ScopeFilter = {
      anyOf: [{ locationId: 'loc_nyc', departmentId: 'dept_eng' }],
      unrestricted: false,
    };
    expect(recordMatchesScope({ locationId: 'loc_nyc', departmentId: 'dept_eng' }, scope)).toBe(true);
    expect(recordMatchesScope({ locationId: 'loc_nyc', departmentId: 'dept_hr' }, scope)).toBe(false);
  });

  it('record with missing attribute = undefined → no match (fail-closed)', () => {
    const scope: ScopeFilter = {
      anyOf: [{ locationId: 'loc_nyc' }],
      unrestricted: false,
    };
    expect(recordMatchesScope({}, scope)).toBe(false);
    expect(recordMatchesScope({ other: 'value' }, scope)).toBe(false);
  });

  it('extra attributes in record are ignored (only scope keys checked)', () => {
    const scope: ScopeFilter = {
      anyOf: [{ locationId: 'loc_nyc' }],
      unrestricted: false,
    };
    expect(recordMatchesScope({ locationId: 'loc_nyc', extra: 'data', foo: 42 }, scope)).toBe(true);
  });
});
