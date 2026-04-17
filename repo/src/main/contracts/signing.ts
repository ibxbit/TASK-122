import type { Database } from 'better-sqlite3';
import crypto from 'node:crypto';
import { logger } from '../logger';
import { generateContractPdf } from './pdf';
import { appendAuditEvent } from '../audit/chain';

/* =========================================================================
 * Signing Workflow
 *
 *   signContract(db, req)
 *     1. Load signer · enforce: verified = 1, gov_id_last4 present
 *     2. Re-verify the signer's password (pbkdf2-sha256)
 *     3. Generate a frozen PDF (chmod 0o444)
 *     4. Insert append-only row into contract_signatures
 *     5. Flip contract_instance → 'active', store pdf path + sha256
 *     6. Emit audit event anchored to the PDF sha256
 *
 *   + Expiry notifier (60/30/7 days out) — dedupes via contract_notifications.
 * ========================================================================= */

export interface SignRequest {
  tenantId:      string;
  instanceId:    string;
  signerUserId:  string;
  password:      string;                 // plaintext; verified then discarded
  windowKind?:   string;
}

export interface SignResult {
  signatureId:      string;
  signedAt:         number;
  pdfPath:          string;
  signatureSha256:  string;
}

const PBKDF2_ITER   = 100_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

export async function signContract(db: Database, req: SignRequest): Promise<SignResult> {
  // ── 1. Load signer + preconditions ─────────────────────────────────────
  const signer = db.prepare(`
    SELECT id, tenant_id, status, verified, gov_id_last4, password_hash, password_salt
      FROM users
     WHERE id = ?
  `).get(req.signerUserId) as SignerRow | undefined;

  if (!signer)                              throw new SignError('signer_not_found');
  if (signer.tenant_id !== req.tenantId)    throw new SignError('tenant_mismatch');
  if (signer.status !== 'active')           throw new SignError('signer_disabled');
  if (!signer.verified)                     throw new SignError('signer_not_verified');
  if (!signer.gov_id_last4)                 throw new SignError('signer_missing_gov_id');
  if (!signer.password_hash || !signer.password_salt) throw new SignError('signer_no_password');

  // ── 2. Password re-entry ────────────────────────────────────────────────
  if (!verifyPassword(req.password, signer.password_hash, signer.password_salt)) {
    throw new SignError('password_invalid');
  }

  // ── 3. Load instance + joined template metadata ─────────────────────────
  const row = db.prepare(`
    SELECT ci.id, ci.tenant_id, ci.instance_number, ci.status,
           ci.rendered_body, ci.variables, ci.effective_from, ci.effective_to,
           ct.code    AS template_code,
           ct.version AS template_version,
           ct.name    AS template_name
      FROM contract_instances ci
      JOIN contract_templates ct ON ct.id = ci.template_id
     WHERE ci.id = ? AND ci.tenant_id = ?
  `).get(req.instanceId, req.tenantId) as InstanceRow | undefined;

  if (!row)                                                     throw new SignError('instance_not_found');
  if (!['draft','pending_signature'].includes(row.status))      throw new SignError('instance_not_signable');

  // ── 4. Generate frozen PDF ──────────────────────────────────────────────
  const pdf = await generateContractPdf({
    instanceId:       row.id,
    instanceNumber:   row.instance_number,
    tenantId:         row.tenant_id,
    templateCode:     row.template_code,
    templateVersion:  row.template_version,
    title:            row.template_name,
    renderedBody:     row.rendered_body,
    variables:        JSON.parse(row.variables),
    effectiveFrom:    row.effective_from,
    effectiveTo:      row.effective_to,
    generatedAt:      Math.floor(Date.now() / 1000),
    freeze:           true,
  });

  // ── 5. Persist signature, activate instance, audit (one transaction) ────
  const signatureId = `sig_${crypto.randomBytes(10).toString('hex')}`;
  const signedAt    = Math.floor(Date.now() / 1000);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO contract_signatures
        (id, tenant_id, contract_instance_id, signer_user_id, signed_at,
         gov_id_last4, signature_sha256, ip, window_kind)
      VALUES
        (@id, @tenantId, @instanceId, @signerId, @signedAt,
         @last4, @sha, '127.0.0.1', @windowKind)
    `).run({
      id:          signatureId,
      tenantId:    req.tenantId,
      instanceId:  req.instanceId,
      signerId:    req.signerUserId,
      signedAt,
      last4:       signer.gov_id_last4,
      sha:         pdf.sha256,
      windowKind:  req.windowKind ?? null,
    });

    db.prepare(`
      UPDATE contract_instances
         SET status = 'active',
             signed_at  = @signedAt,
             pdf_path   = @pdfPath,
             pdf_sha256 = @pdfSha,
             updated_at = @signedAt
       WHERE id = @id AND tenant_id = @tenantId
    `).run({
      signedAt,
      pdfPath:  pdf.path,
      pdfSha:   pdf.sha256,
      id:       req.instanceId,
      tenantId: req.tenantId,
    });

  })();

  // Audit event MUST be appended through the hash-chain so seq/hash_prev/
  // hash_curr are computed by the single authoritative producer.  Nested
  // inside the outer transaction is not possible because appendAuditEvent
  // starts its own transaction; running it immediately after is sufficient
  // since all signing state (signature row, instance activation) is already
  // durable — the audit entry is the tamper-evident anchor that references
  // the frozen PDF hash.
  appendAuditEvent(db, {
    tenantId:     req.tenantId,
    actorUserId:  req.signerUserId,
    action:       'contract.signed',
    entityType:   'contract_instance',
    entityId:     req.instanceId,
    windowKind:   (req.windowKind as 'dashboard'|'contracts'|'audit'|undefined) ?? null,
    occurredAt:   signedAt,
    payload: {
      signatureId,
      pdfPath:    pdf.path,
      pdfSha256:  pdf.sha256,
      govIdLast4: signer.gov_id_last4,
    },
  });

  logger.info({ instanceId: req.instanceId, signerId: req.signerUserId, signatureId }, 'contract_signed');
  return { signatureId, signedAt, pdfPath: pdf.path, signatureSha256: pdf.sha256 };
}

/* ------------------------------------------------------------------ *
 *  Password hashing — exposed for user provisioning.                 *
 * ------------------------------------------------------------------ */

export interface PasswordHash { hash: string; salt: string; }

export function hashPassword(plain: string): PasswordHash {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(plain, Buffer.from(salt, 'hex'), PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return { hash, salt };
}

function verifyPassword(plain: string, hashHex: string, saltHex: string): boolean {
  const derived = crypto.pbkdf2Sync(plain, Buffer.from(saltHex, 'hex'), PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  const known   = Buffer.from(hashHex, 'hex');
  return derived.length === known.length && crypto.timingSafeEqual(derived, known);
}

export class SignError extends Error {
  constructor(public readonly code: string) {
    super(`sign_error:${code}`);
    this.name = 'SignError';
  }
}

/* =========================================================================
 *  Expiry Notifications — 60 / 30 / 7 day milestones.
 *
 *  Call runExpiryScan() on a schedule (e.g. hourly).  Emits the smallest
 *  un-fired milestone per contract per scan; uniqueness on
 *  (contract_instance_id, kind) guarantees each milestone fires at most
 *  once per contract.  In-app + tray sinks are injected so this module
 *  stays free of Electron UI imports.
 * ========================================================================= */

export type ExpiryKind = 'expiry_60' | 'expiry_30' | 'expiry_7';

export interface ExpiryNotification {
  kind:                 ExpiryKind;
  tenantId:             string;
  contractInstanceId:   string;
  instanceNumber:       string;
  counterpartyUserId:   string | null;
  effectiveTo:          number;
  daysRemaining:        number;
}

export interface NotificationSink {
  inApp(n: ExpiryNotification): void;       // broadcast to open renderers
  tray (n: ExpiryNotification): void;       // tray balloon / icon badge
}

const MILESTONES: Array<{ kind: ExpiryKind; days: number }> = [
  { kind: 'expiry_7',  days: 7  },
  { kind: 'expiry_30', days: 30 },
  { kind: 'expiry_60', days: 60 },
];

export function runExpiryScan(db: Database, sink: NotificationSink): number {
  const now       = Math.floor(Date.now() / 1000);
  const horizon   = now + 60 * 86400;        // up to 60 days out
  const rows = db.prepare(`
    SELECT id, tenant_id, instance_number, counterparty_user_id, effective_to
      FROM contract_instances
     WHERE status = 'active'
       AND effective_to IS NOT NULL
       AND effective_to BETWEEN ? AND ?
  `).all(now, horizon) as Array<{
    id: string; tenant_id: string; instance_number: string;
    counterparty_user_id: string | null; effective_to: number;
  }>;

  const insertNotification = db.prepare(`
    INSERT OR IGNORE INTO contract_notifications
      (id, tenant_id, contract_instance_id, kind, created_at)
    VALUES (@id, @tenantId, @instanceId, @kind, @now)
  `);

  let fired = 0;
  for (const row of rows) {
    const days = Math.floor((row.effective_to - now) / 86400);

    // Try milestones ascending (7 → 30 → 60): fire the first that's
    // applicable AND not yet recorded, then stop.  If the first
    // applicable milestone has already been recorded, we stop — firing a
    // coarser milestone for the same contract would be a regression
    // (we've already alerted at a more urgent level).
    for (const m of MILESTONES) {
      if (days > m.days) continue;

      const res = insertNotification.run({
        id:         `cn_${row.id}_${m.kind}`,
        tenantId:   row.tenant_id,
        instanceId: row.id,
        kind:       m.kind,
        now,
      });
      if (res.changes === 0) break;           // already fired this (or smaller) milestone

      const payload: ExpiryNotification = {
        kind:               m.kind,
        tenantId:           row.tenant_id,
        contractInstanceId: row.id,
        instanceNumber:     row.instance_number,
        counterpartyUserId: row.counterparty_user_id,
        effectiveTo:        row.effective_to,
        daysRemaining:      days,
      };
      try { sink.inApp(payload); } catch (err) { logger.error({ err }, 'expiry_inapp_sink_failed'); }
      try { sink.tray (payload); } catch (err) { logger.error({ err }, 'expiry_tray_sink_failed'); }
      fired += 1;
      break;
    }
  }

  if (fired > 0) logger.info({ fired }, 'expiry_notifications_emitted');
  return fired;
}

/* ------------------------------------------------------------------ */

interface SignerRow {
  id: string; tenant_id: string; status: string;
  verified: number; gov_id_last4: string | null;
  password_hash: string | null; password_salt: string | null;
}

interface InstanceRow {
  id: string; tenant_id: string; instance_number: string; status: string;
  rendered_body: string; variables: string;
  effective_from: number | null; effective_to: number | null;
  template_code: string; template_version: number; template_name: string;
}
