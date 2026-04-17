import { registerGuarded } from '../access/enforce';
import { getDb } from '../db';
import { verifyAuditChain } from '../audit/chain';
import { exportAuditBundle } from '../audit/export';
import { chooseExportDestination, validateDestination } from './export-dialog';

/* =========================================================================
 * Audit IPC Handlers
 *
 *  audit:list    — paginated audit event list (tenant-scoped)
 *  audit:verify  — run chain verification over a range
 *  audit:export  — trigger audit bundle export (zip w/ CSV + PDF + manifest)
 *
 *  All handlers run through registerGuarded() so session + ABAC is enforced.
 * ========================================================================= */

interface AuditListPayload {
  actor?:      string;
  action?:     string;
  entityType?: string;
  from?:       number;
  to?:         number;
  limit?:      number;
  offset?:     number;
}

interface AuditVerifyPayload {
  from?: number;
  to?:   number;
}

interface AuditExportPayload {
  from?:             number;
  to?:               number;
  userId?:           string;
  action?:           string;
  entityType?:       string;
  entityId?:         string;
  chooseDestination?: boolean;
  destinationPath?:   string;
}

export function registerAuditHandlers(): void {
  // ── audit:list ──────────────────────────────────────────────────────
  registerGuarded<AuditListPayload, unknown[]>(
    'audit:list',
    { permission: 'audit.list', type: 'api', action: 'read' },
    (ctx, payload) => {
      const db    = getDb();
      const limit  = payload.limit  ?? 500;
      const offset = payload.offset ?? 0;

      const parts  = ['tenant_id = @tenantId'];
      const params: Record<string, unknown> = { tenantId: ctx.tenantId };

      if (payload.actor)      { parts.push('actor_user_id = @actor');  params.actor = payload.actor; }
      if (payload.action)     { parts.push('action = @action');        params.action = payload.action; }
      if (payload.entityType) { parts.push('entity_type = @entityType'); params.entityType = payload.entityType; }
      if (payload.from !== undefined) { parts.push('occurred_at >= @from'); params.from = payload.from; }
      if (payload.to   !== undefined) { parts.push('occurred_at <  @to');   params.to   = payload.to; }

      const sql = `
        SELECT id, tenant_id, seq, occurred_at AS occurredAt, action,
               actor_user_id AS actorUserId, entity_type AS entityType,
               entity_id AS entityId, window_kind AS windowKind,
               hash_prev AS hashPrev, hash_curr AS hashCurr, payload
          FROM audit_events
         WHERE ${parts.join(' AND ')}
         ORDER BY occurred_at DESC
         LIMIT @limit OFFSET @offset
      `;
      return db.prepare(sql).all({ ...params, limit, offset });
    },
  );

  // ── audit:verify ────────────────────────────────────────────────────
  registerGuarded<AuditVerifyPayload, unknown>(
    'audit:verify',
    { permission: 'audit.list', type: 'api', action: 'read' },
    (ctx, payload) => {
      return verifyAuditChain(getDb(), ctx.tenantId, {
        from: payload.from,
        to:   payload.to,
      });
    },
  );

  // ── audit:export ────────────────────────────────────────────────────
  registerGuarded<AuditExportPayload, unknown>(
    'audit:export',
    { permission: 'audit.export', type: 'api', action: 'read' },
    async (ctx, payload) => {
      // Resolve a user-selected destination when requested.
      let destinationPath: string | undefined;
      if (payload.destinationPath) {
        destinationPath = await validateDestination(payload.destinationPath, 'zip');
      } else if (payload.chooseDestination) {
        const iso = new Date().toISOString().slice(0, 10);
        const chosen = await chooseExportDestination({
          title:       'Save Audit Bundle',
          defaultName: `audit_${ctx.tenantId}_${iso}.zip`,
          kind:        'zip',
        });
        if (chosen) destinationPath = chosen.absolutePath;
      }

      return exportAuditBundle(getDb(), {
        tenantId:        ctx.tenantId,
        from:            payload.from,
        to:              payload.to,
        userId:          payload.userId,
        action:          payload.action,
        entityType:      payload.entityType,
        entityId:        payload.entityId,
        destinationPath,
      });
    },
  );
}
