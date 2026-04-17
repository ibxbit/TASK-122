import { describe, expect, it } from 'vitest';
import {
  validateVariables, renderTemplate, DEFAULT_LEASE_VARIABLES,
} from '../../src/main/contracts/template';
import { makeTestDb, seedAccessGraph } from '../_helpers/db';

/* =========================================================================
 *  Contract template engine — variable validation + rendering.
 * ========================================================================= */

describe('validateVariables()', () => {
  it('accepts fully-specified lease variables', () => {
    const issues = validateVariables(DEFAULT_LEASE_VARIABLES, {
      leaseTerm: 12, rent: 1500, paymentCycle: 'monthly',
    });
    expect(issues).toEqual([]);
  });

  it('flags missing required variables', () => {
    const issues = validateVariables(DEFAULT_LEASE_VARIABLES, {});
    expect(issues.map((i) => i.code)).toEqual(['required', 'required', 'required']);
  });

  it('enforces integer type + min/max', () => {
    const issues = validateVariables(DEFAULT_LEASE_VARIABLES, {
      leaseTerm: 0, rent: 1000, paymentCycle: 'monthly',
    });
    expect(issues.map((i) => i.code)).toContain('min');
  });

  it('rejects enum values outside the allowed set', () => {
    const issues = validateVariables(DEFAULT_LEASE_VARIABLES, {
      leaseTerm: 12, rent: 1500, paymentCycle: 'annually',
    });
    expect(issues.map((i) => i.code)).toContain('enum');
  });

  it('flags wrong types', () => {
    const issues = validateVariables(
      { variables: [{ name: 'active', type: 'boolean', required: true }] },
      { active: 'yes' },
    );
    expect(issues.map((i) => i.code)).toContain('type');
  });
});

describe('renderTemplate()', () => {
  it('substitutes variables and resolves clauses', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    db.prepare(`
      INSERT INTO contract_clauses (id, tenant_id, code, title, body, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run('c1', ids.tenantId, 'renewal', 'Renewal', 'Rent is {{var:rent}}.');
    const r = renderTemplate(db, {
      tenantId: ids.tenantId,
      body:     'Hello {{var:tenantName}}. {{clause:renewal}}',
      variables: { tenantName: 'Acme', rent: 1500 },
    });
    expect(r.body).toContain('Hello Acme');
    expect(r.body).toContain('Rent is 1500.');
    expect(r.appliedClauses).toHaveLength(1);
    expect(r.missing).toEqual([]);
  });

  it('surfaces missing clauses and variables', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const r = renderTemplate(db, {
      tenantId: ids.tenantId,
      body:     'Hello {{var:missingVar}} {{clause:no-clause}}',
      variables: {},
    });
    expect(r.missing).toEqual(['clause:no-clause', 'var:missingVar']);
    expect(r.body).toContain('[[UNDEFINED: missingVar]]');
    expect(r.body).toContain('[[MISSING CLAUSE: no-clause]]');
  });
});
