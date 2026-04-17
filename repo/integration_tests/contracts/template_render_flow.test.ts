import { describe, expect, it } from 'vitest';
import {
  saveTemplateDraft, publishTemplate, latestPublished,
} from '../../src/main/contracts/versioning';
import {
  validateVariables, renderTemplate, DEFAULT_LEASE_VARIABLES,
} from '../../src/main/contracts/template';
import { makeTestDb, seedAccessGraph } from '../../unit_tests/_helpers/db';

/* =========================================================================
 *  Contracts — full template authoring + rendering flow.
 * ========================================================================= */

describe('template authoring + render flow', () => {
  it('draft → publish → validate vars → render with clauses', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);

    // Author clause
    db.prepare(`
      INSERT INTO contract_clauses (id, tenant_id, code, title, body, active)
      VALUES ('cl1', ?, 'payment', 'Payment Terms', 'Payment cycle: {{var:paymentCycle}}. Rent: {{var:rent}}.', 1)
    `).run(ids.tenantId);

    // Author + publish template
    const draft = saveTemplateDraft(db, {
      tenantId: ids.tenantId, code: 'lease-v1', name: 'Basic Lease',
      body: `Tenant agrees to rent for {{var:leaseTerm}} months.\n{{clause:payment}}`,
      variables: DEFAULT_LEASE_VARIABLES,
    });
    publishTemplate(db, draft.id);

    const published = latestPublished(db, ids.tenantId, 'lease-v1')!;
    expect(published.status).toBe('published');

    // Validate + render an instance
    const vars = { leaseTerm: 12, rent: 2500, paymentCycle: 'monthly' as const };
    const issues = validateVariables(DEFAULT_LEASE_VARIABLES, vars);
    expect(issues).toEqual([]);

    const rendered = renderTemplate(db, {
      tenantId: ids.tenantId,
      body:     published.body,
      variables: vars,
    });
    expect(rendered.missing).toEqual([]);
    expect(rendered.body).toContain('Tenant agrees to rent for 12 months.');
    expect(rendered.body).toContain('Payment cycle: monthly.');
    expect(rendered.body).toContain('Rent: 2500.');
    expect(rendered.appliedClauses.map((c) => c.code)).toEqual(['payment']);
  });
});
