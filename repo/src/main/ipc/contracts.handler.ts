import { registerGuarded, AccessDeniedError, type HandlerContext } from '../access/enforce';
import { getDb } from '../db';
import { recordMatchesScope, type ScopeFilter } from '../access/evaluator';
import { signContract } from '../contracts/signing';
import { windowManager } from '../windows/WindowManager';
import { logger } from '../logger';
import crypto from 'node:crypto';

/* =========================================================================
 * Contract IPC Handlers — full set
 *
 *  contracts:list      (read)   — tenant-scoped, ABAC-filtered list
 *  contracts:get       (read)   — single instance detail (object-level ABAC)
 *  contracts:delete    (write)  — object-level ABAC on the record before delete
 *  contracts:approve   (write)  — object-level ABAC, status transition
 *  contracts:reject    (write)  — object-level ABAC, status transition
 *  contracts:sign      (write)  — delegates to signing workflow
 *  contracts:newDraft  (write)  — create a new draft instance
 *  contracts:expiring  (read)   — active contracts ≤60 days from expiry
 *  contracts:export    (read)   — export filtered list as CSV
 *  contracts:open      (read)   — open/focus the contracts window
 *
 *  Object-level authorization:
 *    All write operations fetch the target record FIRST, verify it matches
 *    the caller's ABAC scope via recordMatchesScope(), and fail-closed if
 *    the scope check fails.  This prevents a scoped user from modifying
 *    records outside their visibility even if they know the id.
 * ========================================================================= */

// ── Interfaces ──────────────────────────────────────────────────────────

interface ListPayload     { limit?: number; offset?: number; status?: string; }
interface GetPayload      { id: string; }
interface DeletePayload   { contractId: string; }
interface ApprovePayload  { id: string; }
interface RejectPayload   { id: string; }
interface SignPayload     { id: string; password: string; }
interface ExportPayload   { status?: string; }
interface OpenPayload     { id: string; }

interface ContractRow {
  id: string; title: string; location_id: string; department_id: string; status: string;
}

interface InstanceRow {
  id: string; tenant_id: string; instance_number: string; template_id: string;
  status: string; rendered_body: string; variables: string;
  effective_from: number | null; effective_to: number | null;
  counterparty_user_id: string | null; org_unit_id: string | null;
  pdf_path: string | null; pdf_sha256: string | null;
  updated_at: number; created_at: number;
}

// Attribute key (from ABAC JSON) → DB column for instance-level filtering.
const SCOPE_COLUMN_MAP: Record<string, string> = {
  locationId:   'ci.org_unit_id',
  departmentId: 'ci.org_unit_id',
};

// For object-level checks, map ABAC attributes to record fields.
const RECORD_FIELD_MAP: Record<string, string> = {
  locationId:   'org_unit_id',
  departmentId: 'org_unit_id',
};

export function registerContractHandlers(): void {
  // ── contracts:list ──────────────────────────────────────────────────
  registerGuarded<ListPayload, unknown[]>(
    'contracts:list',
    { permission: 'contract.list', type: 'api', action: 'read' },
    (ctx, payload) => {
      const db     = getDb();
      const limit  = payload.limit  ?? 100;
      const offset = payload.offset ?? 0;

      const parts  = ['ci.tenant_id = @tenantId'];
      const params: Record<string, unknown> = { tenantId: ctx.tenantId };

      if (payload.status && payload.status !== 'all') {
        parts.push('ci.status = @status');
        params.status = payload.status;
      }

      // Apply ABAC scope filter
      const scopeClause = buildInstanceScopeClause(ctx.scope, params);
      if (scopeClause === null) return [];  // scope matches nothing
      if (scopeClause) parts.push(scopeClause);

      const sql = `
        SELECT ci.id, ci.instance_number AS instanceNumber,
               ct.code AS templateCode, ct.version AS templateVersion,
               ci.status, ci.counterparty_user_id AS counterparty,
               ci.effective_from AS effectiveFrom, ci.effective_to AS effectiveTo,
               ci.updated_at AS updatedAt
          FROM contract_instances ci
          JOIN contract_templates ct ON ct.id = ci.template_id
         WHERE ${parts.join(' AND ')}
         ORDER BY ci.updated_at DESC
         LIMIT @limit OFFSET @offset
      `;
      return db.prepare(sql).all({ ...params, limit, offset });
    },
  );

  // ── contracts:get ──────────────────────────────────────────────────
  registerGuarded<GetPayload, unknown>(
    'contracts:get',
    { permission: 'contract.list', type: 'api', action: 'read' },
    (ctx, payload) => {
      const row = loadInstance(ctx.tenantId, payload.id);
      if (!row) return null;

      // Object-level ABAC check
      enforceObjectScope(ctx, row, 'contracts:get');

      return {
        id:              row.id,
        instanceNumber:  row.instance_number,
        templateCode:    '', // joined below
        templateVersion: 0,
        status:          row.status,
        counterparty:    row.counterparty_user_id,
        effectiveFrom:   row.effective_from,
        effectiveTo:     row.effective_to,
        renderedBody:    row.rendered_body,
        variables:       JSON.parse(row.variables || '{}'),
        pdfPath:         row.pdf_path,
        pdfSha256:       row.pdf_sha256,
        updatedAt:       row.updated_at,
      };
    },
  );

  // ── contracts:delete ────────────────────────────────────────────────
  registerGuarded<DeletePayload, { deleted: boolean }>(
    'contracts:delete',
    { permission: 'contract.delete', type: 'resource', action: 'write' },
    (ctx, payload) => {
      const db = getDb();

      // Fetch the record BEFORE delete for object-level ABAC
      const row = loadInstance(ctx.tenantId, payload.contractId);
      if (!row) return { deleted: false };

      // Object-level ABAC — fail-closed
      enforceObjectScope(ctx, row, 'contracts:delete');

      const info = db.prepare(
        'DELETE FROM contract_instances WHERE id = @id AND tenant_id = @tenantId'
      ).run({ id: payload.contractId, tenantId: ctx.tenantId });
      return { deleted: info.changes > 0 };
    },
  );

  // ── contracts:approve ──────────────────────────────────────────────
  registerGuarded<ApprovePayload, { success: boolean }>(
    'contracts:approve',
    { permission: 'contract.approve', type: 'resource', action: 'write' },
    (ctx, payload) => {
      const db  = getDb();
      const row = loadInstance(ctx.tenantId, payload.id);
      if (!row) throw new AccessDeniedError('instance_not_found', 'contracts:approve');

      enforceObjectScope(ctx, row, 'contracts:approve');

      if (row.status !== 'draft' && row.status !== 'pending_signature') {
        return { success: false };
      }

      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        UPDATE contract_instances
           SET status = 'pending_signature', updated_at = @now
         WHERE id = @id AND tenant_id = @tenantId
      `).run({ id: payload.id, tenantId: ctx.tenantId, now });

      return { success: true };
    },
  );

  // ── contracts:reject ───────────────────────────────────────────────
  registerGuarded<RejectPayload, { success: boolean }>(
    'contracts:reject',
    { permission: 'contract.reject', type: 'resource', action: 'write' },
    (ctx, payload) => {
      const db  = getDb();
      const row = loadInstance(ctx.tenantId, payload.id);
      if (!row) throw new AccessDeniedError('instance_not_found', 'contracts:reject');

      enforceObjectScope(ctx, row, 'contracts:reject');

      if (row.status === 'terminated' || row.status === 'expired') {
        return { success: false };
      }

      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        UPDATE contract_instances
           SET status = 'terminated', updated_at = @now
         WHERE id = @id AND tenant_id = @tenantId
      `).run({ id: payload.id, tenantId: ctx.tenantId, now });

      return { success: true };
    },
  );

  // ── contracts:sign ─────────────────────────────────────────────────
  registerGuarded<SignPayload, unknown>(
    'contracts:sign',
    { permission: 'contract.sign', type: 'resource', action: 'write' },
    async (ctx, payload) => {
      const row = loadInstance(ctx.tenantId, payload.id);
      if (!row) throw new AccessDeniedError('instance_not_found', 'contracts:sign');

      enforceObjectScope(ctx, row, 'contracts:sign');

      return signContract(getDb(), {
        tenantId:     ctx.tenantId,
        instanceId:   payload.id,
        signerUserId: ctx.userId,
        password:     payload.password,
      });
    },
  );

  // ── contracts:newDraft ─────────────────────────────────────────────
  registerGuarded<Record<string, never>, unknown>(
    'contracts:newDraft',
    { permission: 'contract.create', type: 'api', action: 'write' },
    (ctx) => {
      const db  = getDb();
      const now = Math.floor(Date.now() / 1000);
      const id  = `ci_${crypto.randomBytes(10).toString('hex')}`;
      const num = `C-${Date.now().toString(36).toUpperCase()}`;

      // Find a published template for this tenant
      const tpl = db.prepare(`
        SELECT id FROM contract_templates
         WHERE tenant_id = @tenantId AND status = 'published'
         ORDER BY version DESC LIMIT 1
      `).get({ tenantId: ctx.tenantId }) as { id: string } | undefined;

      if (!tpl) {
        throw new Error('no_published_template');
      }

      db.prepare(`
        INSERT INTO contract_instances
          (id, tenant_id, template_id, instance_number, status, rendered_body, variables, created_by, created_at, updated_at)
        VALUES
          (@id, @tenantId, @templateId, @num, 'draft', '', '{}', @userId, @now, @now)
      `).run({ id, tenantId: ctx.tenantId, templateId: tpl.id, num, userId: ctx.userId, now });

      return { id, instanceNumber: num };
    },
  );

  // ── contracts:expiring ─────────────────────────────────────────────
  registerGuarded<Record<string, never>, unknown[]>(
    'contracts:expiring',
    { permission: 'contract.list', type: 'api', action: 'read' },
    (ctx) => {
      const db      = getDb();
      const now     = Math.floor(Date.now() / 1000);
      const horizon = now + 60 * 86400;

      return db.prepare(`
        SELECT ci.id, ci.instance_number AS instanceNumber,
               u.display_name AS counterparty,
               CAST((ci.effective_to - @now) / 86400 AS INTEGER) AS daysRemaining,
               ci.effective_to AS effectiveTo,
               ci.status
          FROM contract_instances ci
          LEFT JOIN users u ON u.id = ci.counterparty_user_id
         WHERE ci.tenant_id = @tenantId
           AND ci.status = 'active'
           AND ci.effective_to IS NOT NULL
           AND ci.effective_to BETWEEN @now AND @horizon
         ORDER BY ci.effective_to ASC
      `).all({ tenantId: ctx.tenantId, now, horizon });
    },
  );

  // ── contracts:export ───────────────────────────────────────────────
  registerGuarded<ExportPayload, unknown>(
    'contracts:export',
    { permission: 'contract.list', type: 'api', action: 'read' },
    (ctx, payload) => {
      const db = getDb();
      const parts  = ['ci.tenant_id = @tenantId'];
      const params: Record<string, unknown> = { tenantId: ctx.tenantId };

      if (payload.status && payload.status !== 'all') {
        parts.push('ci.status = @status');
        params.status = payload.status;
      }

      const rows = db.prepare(`
        SELECT ci.instance_number, ct.code AS template_code, ct.version AS template_version,
               ci.status, ci.effective_from, ci.effective_to
          FROM contract_instances ci
          JOIN contract_templates ct ON ct.id = ci.template_id
         WHERE ${parts.join(' AND ')}
         ORDER BY ci.updated_at DESC
      `).all(params);

      return { rows, count: rows.length };
    },
  );

  // ── contracts:open ─────────────────────────────────────────────────
  registerGuarded<OpenPayload, { opened: boolean }>(
    'contracts:open',
    { permission: 'contract.list', type: 'api', action: 'read' },
    (_ctx, _payload) => {
      windowManager.open('contracts');
      return { opened: true };
    },
  );
}

/* ================================================================== *
 *  Object-level ABAC enforcement                                      *
 *                                                                      *
 *  Converts the instance row into a record map and checks it against   *
 *  the caller's ScopeFilter.  Fail-closed: if the record doesn't      *
 *  match any scope clause, the operation is denied.                    *
 * ================================================================== */

function enforceObjectScope(ctx: HandlerContext, row: InstanceRow, channel: string): void {
  const record: Record<string, unknown> = {
    org_unit_id:   row.org_unit_id,
    tenant_id:     row.tenant_id,
    locationId:    row.org_unit_id,
    departmentId:  row.org_unit_id,
  };

  if (!recordMatchesScope(record, ctx.scope)) {
    logger.warn({
      channel,
      userId:     ctx.userId,
      tenantId:   ctx.tenantId,
      instanceId: row.id,
    }, 'object_level_access_denied');
    throw new AccessDeniedError('object_scope_denied', channel);
  }
}

function loadInstance(tenantId: string, id: string): InstanceRow | undefined {
  return getDb().prepare(`
    SELECT * FROM contract_instances WHERE id = @id AND tenant_id = @tenantId
  `).get({ id, tenantId }) as InstanceRow | undefined;
}

/* ------------------------------------------------------------------ *
 *  ABAC scope → SQL WHERE clause for instance listing                 *
 * ------------------------------------------------------------------ */

function buildInstanceScopeClause(
  scope: ScopeFilter,
  params: Record<string, unknown>,
): string | null {
  if (scope.unrestricted) return '';     // no additional restriction
  if (scope.anyOf.length === 0) return null;   // deny-by-scope

  const orParts: string[] = [];
  scope.anyOf.forEach((clause, i) => {
    const andParts: string[] = [];
    for (const [k, v] of Object.entries(clause)) {
      const col = SCOPE_COLUMN_MAP[k];
      if (!col) continue;
      if (Array.isArray(v)) {
        const keys = v.map((_, j) => {
          const p = `s${i}_${k}_${j}`;
          params[p] = v[j];
          return `@${p}`;
        });
        if (keys.length) andParts.push(`${col} IN (${keys.join(',')})`);
      } else {
        const p = `s${i}_${k}`;
        params[p] = v;
        andParts.push(`${col} = @${p}`);
      }
    }
    if (andParts.length) orParts.push(`(${andParts.join(' AND ')})`);
  });

  if (orParts.length === 0) return null;
  return `(${orParts.join(' OR ')})`;
}
