import type { Database } from 'better-sqlite3';
import crypto from 'node:crypto';

/* =========================================================================
 * Audit Hash Chain  (per tenant)
 *
 *  hash_curr = sha256( canonical( id, tenant_id, seq, occurred_at, action,
 *                                 actor_user_id, entity_type, entity_id,
 *                                 payload, window_kind, hash_prev ) )
 *
 *  • seq is strictly increasing per tenant (1..N) — the UNIQUE index
 *    `uq_audit_events_tenant_seq` forbids duplicates or gaps introduced
 *    out-of-band.
 *  • hash_prev of event N = hash_curr of event N-1, or NULL for seq=1.
 *  • Retention = 7 calendar years (leap-year aware via JS Date math).
 *  • Field ordering is explicit (sorted keys) so canonicalisation is
 *    stable across Node / V8 versions.
 *
 *  DB-side append-only triggers (from 0001_init.sql) make UPDATE / DELETE
 *  impossible — tampering by bypassing this module is still blocked.
 * ========================================================================= */

export type WindowKind = 'dashboard' | 'contracts' | 'audit';

export interface AppendInput {
  tenantId:      string;
  action:        string;
  actorUserId?:  string | null;
  entityType?:   string | null;
  entityId?:     string | null;
  payload?:      unknown;               // JSON-stringified before hashing
  windowKind?:   WindowKind | null;
  occurredAt?:   number;                 // default now
}

export interface AuditRow {
  id:             string;
  tenant_id:      string;
  actor_user_id:  string | null;
  occurred_at:    number;
  action:         string;
  entity_type:    string | null;
  entity_id:      string | null;
  payload:        string | null;
  window_kind:    string | null;
  hash_prev:      string | null;
  hash_curr:      string;
  seq:            number | null;
  retain_until:   number | null;
}

/* ------------------------------------------------------------------ *
 *  Append — the canonical write path.                                 *
 * ------------------------------------------------------------------ */

export function appendAuditEvent(db: Database, input: AppendInput): AuditRow {
  return db.transaction((): AuditRow => {
    const occurredAt = input.occurredAt ?? Math.floor(Date.now() / 1000);
    const now        = Math.floor(Date.now() / 1000);

    const head = db.prepare(
      'SELECT head_hash, seq FROM audit_chain_heads WHERE tenant_id = ?'
    ).get(input.tenantId) as { head_hash: string; seq: number } | undefined;

    const hashPrev   = head?.head_hash ?? null;
    const seq        = (head?.seq ?? 0) + 1;
    const id         = `ae_${crypto.randomBytes(12).toString('hex')}`;
    const payloadStr = input.payload === undefined ? null : JSON.stringify(input.payload);

    const canonical = canonicalise({
      id,
      tenant_id:     input.tenantId,
      seq,
      occurred_at:   occurredAt,
      action:        input.action,
      actor_user_id: input.actorUserId ?? null,
      entity_type:   input.entityType  ?? null,
      entity_id:     input.entityId    ?? null,
      payload:       payloadStr,
      window_kind:   input.windowKind  ?? null,
      hash_prev:     hashPrev,
    });
    const hashCurr = sha256Hex(canonical);

    const retainUntil = retentionBoundary(occurredAt);

    db.prepare(`
      INSERT INTO audit_events
        (id, tenant_id, actor_user_id, occurred_at, action, entity_type, entity_id,
         payload, window_kind, hash_prev, hash_curr, seq, retain_until)
      VALUES
        (@id, @tenantId, @actor, @occurredAt, @action, @entityType, @entityId,
         @payload, @windowKind, @hashPrev, @hashCurr, @seq, @retainUntil)
    `).run({
      id,
      tenantId:    input.tenantId,
      actor:       input.actorUserId ?? null,
      occurredAt,
      action:      input.action,
      entityType:  input.entityType  ?? null,
      entityId:    input.entityId    ?? null,
      payload:     payloadStr,
      windowKind:  input.windowKind  ?? null,
      hashPrev,
      hashCurr,
      seq,
      retainUntil,
    });

    db.prepare(`
      INSERT INTO audit_chain_heads (tenant_id, head_event_id, head_hash, seq, updated_at)
      VALUES (@tenantId, @eid, @hash, @seq, @now)
      ON CONFLICT(tenant_id) DO UPDATE
         SET head_event_id = @eid, head_hash = @hash, seq = @seq, updated_at = @now
    `).run({ tenantId: input.tenantId, eid: id, hash: hashCurr, seq, now });

    return db.prepare('SELECT * FROM audit_events WHERE id = ?').get(id) as AuditRow;
  })();
}

/* ------------------------------------------------------------------ *
 *  Verify — replays the chain over a (tenant, [from, to)) range.      *
 *  Only chained rows (seq IS NOT NULL) are considered.                *
 * ------------------------------------------------------------------ */

export interface VerifyResult {
  ok:               boolean;
  totalEvents:      number;
  firstSeq:         number | null;
  lastSeq:          number | null;
  anchorHashPrev:   string | null;   // hash_prev of first event in range
  lastHash:         string | null;   // hash_curr of last event in range
  break?: {
    seq:    number;
    id:     string;
    reason: 'hash_mismatch' | 'prev_mismatch' | 'seq_gap';
  };
}

export interface VerifyRange { from?: number; to?: number; }

export function verifyAuditChain(
  db: Database, tenantId: string, range: VerifyRange = {},
): VerifyResult {
  const parts  = ['tenant_id = @tenantId', 'seq IS NOT NULL'];
  const params: Record<string, unknown> = { tenantId };
  if (range.from !== undefined) { parts.push('occurred_at >= @from'); params.from = range.from; }
  if (range.to   !== undefined) { parts.push('occurred_at <  @to');   params.to   = range.to;   }

  const rows = db.prepare(`
    SELECT * FROM audit_events WHERE ${parts.join(' AND ')} ORDER BY seq ASC
  `).all(params) as AuditRow[];

  if (rows.length === 0) {
    return {
      ok: true, totalEvents: 0,
      firstSeq: null, lastSeq: null,
      anchorHashPrev: null, lastHash: null,
    };
  }

  let expectedPrev = rows[0].hash_prev;    // anchor
  let prevSeq: number | null = null;

  for (const r of rows) {
    const recomputed = sha256Hex(canonicalise({
      id:            r.id,
      tenant_id:     r.tenant_id,
      seq:           r.seq!,
      occurred_at:   r.occurred_at,
      action:        r.action,
      actor_user_id: r.actor_user_id,
      entity_type:   r.entity_type,
      entity_id:     r.entity_id,
      payload:       r.payload,
      window_kind:   r.window_kind,
      hash_prev:     r.hash_prev,
    }));

    if (recomputed !== r.hash_curr) {
      return fail(rows, r, 'hash_mismatch');
    }
    if (r.hash_prev !== expectedPrev) {
      return fail(rows, r, 'prev_mismatch');
    }
    if (prevSeq !== null && r.seq !== prevSeq + 1) {
      return fail(rows, r, 'seq_gap');
    }

    expectedPrev = r.hash_curr;
    prevSeq      = r.seq!;
  }

  return {
    ok: true,
    totalEvents:    rows.length,
    firstSeq:       rows[0].seq,
    lastSeq:        rows[rows.length - 1].seq,
    anchorHashPrev: rows[0].hash_prev,
    lastHash:       rows[rows.length - 1].hash_curr,
  };
}

function fail(
  rows: AuditRow[], at: AuditRow,
  reason: NonNullable<VerifyResult['break']>['reason'],
): VerifyResult {
  return {
    ok: false,
    totalEvents:    rows.length,
    firstSeq:       rows[0].seq,
    lastSeq:        rows[rows.length - 1].seq,
    anchorHashPrev: rows[0].hash_prev,
    lastHash:       null,
    break: { seq: at.seq!, id: at.id, reason },
  };
}

/* ------------------------------------------------------------------ *
 *  Helpers                                                            *
 * ------------------------------------------------------------------ */

/** Stable JSON with keys sorted lexicographically — deterministic across runs. */
function canonicalise(row: Record<string, unknown>): string {
  const keys = Object.keys(row).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + JSON.stringify(row[k] ?? null)).join(',') + '}';
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** 7 calendar years, leap-year aware. */
function retentionBoundary(fromUnixSeconds: number): number {
  const d = new Date(fromUnixSeconds * 1000);
  d.setUTCFullYear(d.getUTCFullYear() + 7);
  return Math.floor(d.getTime() / 1000);
}
