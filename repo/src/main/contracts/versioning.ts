import type { Database } from 'better-sqlite3';
import crypto from 'node:crypto';

/* =========================================================================
 * Versioning
 *   Every edit creates a new contract_templates row.
 *   version = MAX(version) + 1 within (tenant_id, code).
 *   Published and retired rows are never mutated by this module —
 *   cloneToNewVersion() is the only edit path after publication.
 * ========================================================================= */

export interface TemplateInput {
  tenantId:   string;
  code:       string;
  name:       string;
  body:       string;
  variables:  unknown;                // JSON-serialisable
  createdBy?: string;
}

export interface TemplateRow {
  id:           string;
  tenant_id:    string;
  code:         string;
  name:         string;
  version:      number;
  body:         string;
  variables:    string;               // JSON
  status:       'draft' | 'published' | 'retired';
  published_at: number | null;
  created_by:   string | null;
  created_at:   number;
  updated_at:   number;
}

/** Create a new draft at version MAX(version)+1 for (tenant_id, code). */
export function saveTemplateDraft(db: Database, input: TemplateInput): TemplateRow {
  const tx = db.transaction((): TemplateRow => {
    const now = Math.floor(Date.now() / 1000);
    const id  = `tpl_${crypto.randomBytes(10).toString('hex')}`;

    const next = db.prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS v
        FROM contract_templates
       WHERE tenant_id = ? AND code = ?
    `).get(input.tenantId, input.code) as { v: number };

    db.prepare(`
      INSERT INTO contract_templates
        (id, tenant_id, code, name, version, body, variables, status, created_by, created_at, updated_at)
      VALUES
        (@id, @tenantId, @code, @name, @version, @body, @variables, 'draft', @createdBy, @now, @now)
    `).run({
      id,            version:  next.v,
      tenantId:      input.tenantId,
      code:          input.code,
      name:          input.name,
      body:          input.body,
      variables:     JSON.stringify(input.variables ?? {}),
      createdBy:     input.createdBy ?? null,
      now,
    });

    return loadTemplate(db, id)!;
  });
  return tx();
}

/** Transition draft → published.  Idempotent-safe; rejects non-draft rows. */
export function publishTemplate(db: Database, id: string): TemplateRow {
  const existing = loadTemplate(db, id);
  if (!existing)                       throw new Error('template_not_found');
  if (existing.status !== 'draft')     throw new Error('template_not_draft');

  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE contract_templates
       SET status = 'published', published_at = @now, updated_at = @now
     WHERE id = @id
  `).run({ id, now });

  return loadTemplate(db, id)!;
}

export function retireTemplate(db: Database, id: string): TemplateRow {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE contract_templates SET status = 'retired', updated_at = @now WHERE id = @id
  `).run({ id, now });
  return loadTemplate(db, id)!;
}

/** All versions for a (tenant, code) pair, newest first. */
export function listVersions(db: Database, tenantId: string, code: string): TemplateRow[] {
  return db.prepare(`
    SELECT * FROM contract_templates
     WHERE tenant_id = ? AND code = ?
     ORDER BY version DESC
  `).all(tenantId, code) as TemplateRow[];
}

/** Newest published version for a (tenant, code) pair — the one binding new instances. */
export function latestPublished(db: Database, tenantId: string, code: string): TemplateRow | undefined {
  return db.prepare(`
    SELECT * FROM contract_templates
     WHERE tenant_id = ? AND code = ? AND status = 'published'
     ORDER BY version DESC LIMIT 1
  `).get(tenantId, code) as TemplateRow | undefined;
}

export function loadTemplate(db: Database, id: string): TemplateRow | undefined {
  return db.prepare(`SELECT * FROM contract_templates WHERE id = ?`)
           .get(id) as TemplateRow | undefined;
}

/**
 * Branch a new editable draft from an existing row (draft OR published).
 * The source row is never touched — all changes land on the new version.
 */
export function cloneToNewVersion(
  db: Database,
  sourceId: string,
  edits:    Partial<Pick<TemplateInput, 'name' | 'body' | 'variables'>>,
  createdBy?: string,
): TemplateRow {
  const src = loadTemplate(db, sourceId);
  if (!src) throw new Error('template_not_found');

  return saveTemplateDraft(db, {
    tenantId:  src.tenant_id,
    code:      src.code,
    name:      edits.name      ?? src.name,
    body:      edits.body      ?? src.body,
    variables: edits.variables ?? JSON.parse(src.variables),
    createdBy,
  });
}
