import { describe, expect, it } from 'vitest';
import {
  saveTemplateDraft, publishTemplate, retireTemplate,
  listVersions, latestPublished, cloneToNewVersion,
} from '../../src/main/contracts/versioning';
import { makeTestDb, seedAccessGraph } from '../_helpers/db';

/* =========================================================================
 *  Contract template versioning — monotonic version numbers, status moves.
 * ========================================================================= */

describe('versioning', () => {
  it('saveTemplateDraft creates v1 for a new code', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const row = saveTemplateDraft(db, {
      tenantId: ids.tenantId, code: 'lease-basic',
      name: 'Basic Lease', body: 'body', variables: {},
    });
    expect(row.version).toBe(1);
    expect(row.status).toBe('draft');
  });

  it('subsequent saves increment the version', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    saveTemplateDraft(db, { tenantId: ids.tenantId, code: 'x', name: 'x', body: 'a', variables: {} });
    const v2 = saveTemplateDraft(db, { tenantId: ids.tenantId, code: 'x', name: 'x', body: 'b', variables: {} });
    const v3 = saveTemplateDraft(db, { tenantId: ids.tenantId, code: 'x', name: 'x', body: 'c', variables: {} });
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
  });

  it('publishTemplate transitions draft → published', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const r  = saveTemplateDraft(db, { tenantId: ids.tenantId, code: 'x', name: 'x', body: 'a', variables: {} });
    const p  = publishTemplate(db, r.id);
    expect(p.status).toBe('published');
    expect(p.published_at).toBeGreaterThan(0);
  });

  it('publishTemplate rejects non-draft rows', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const r  = saveTemplateDraft(db, { tenantId: ids.tenantId, code: 'x', name: 'x', body: 'a', variables: {} });
    publishTemplate(db, r.id);
    expect(() => publishTemplate(db, r.id)).toThrow(/template_not_draft/);
  });

  it('retireTemplate marks the row retired', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const r  = saveTemplateDraft(db, { tenantId: ids.tenantId, code: 'x', name: 'x', body: 'a', variables: {} });
    const ret = retireTemplate(db, r.id);
    expect(ret.status).toBe('retired');
  });

  it('latestPublished returns the newest published version', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const r1 = saveTemplateDraft(db, { tenantId: ids.tenantId, code: 'c', name: 'n', body: 'a', variables: {} });
    publishTemplate(db, r1.id);
    const r2 = saveTemplateDraft(db, { tenantId: ids.tenantId, code: 'c', name: 'n', body: 'b', variables: {} });
    publishTemplate(db, r2.id);
    const latest = latestPublished(db, ids.tenantId, 'c');
    expect(latest?.version).toBe(2);
  });

  it('listVersions returns all versions, newest first', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    saveTemplateDraft(db, { tenantId: ids.tenantId, code: 'c', name: 'n', body: 'a', variables: {} });
    saveTemplateDraft(db, { tenantId: ids.tenantId, code: 'c', name: 'n', body: 'b', variables: {} });
    const all = listVersions(db, ids.tenantId, 'c');
    expect(all.map((r) => r.version)).toEqual([2, 1]);
  });

  it('cloneToNewVersion branches a published template into a new draft', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const r1 = saveTemplateDraft(db, { tenantId: ids.tenantId, code: 'c', name: 'orig', body: 'a', variables: { x: 1 } });
    publishTemplate(db, r1.id);
    const cloned = cloneToNewVersion(db, r1.id, { body: 'updated' });
    expect(cloned.version).toBe(2);
    expect(cloned.status).toBe('draft');
    expect(cloned.body).toBe('updated');
    // Source row should remain published and unchanged.
    const src = listVersions(db, ids.tenantId, 'c').find((r) => r.version === 1)!;
    expect(src.status).toBe('published');
    expect(src.body).toBe('a');
  });
});
