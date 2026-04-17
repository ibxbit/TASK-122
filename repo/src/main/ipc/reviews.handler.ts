import crypto from 'node:crypto';
import { registerGuarded, AccessDeniedError } from '../access/enforce';
import { getDb } from '../db';
import { validateReview, REVIEW_LIMITS } from '../reviews/validation';
import { moderateReview } from '../reviews/moderation';
import { persistReviewAssets, AssetValidationError, type AssetInput } from '../reviews/assets';
import { appendAuditEvent } from '../audit/chain';

/* =========================================================================
 * Reviews IPC Handlers — full workflow wiring
 *
 *   reviews:list            (read)   paginated list, tenant-scoped
 *   reviews:get             (read)   single review + flags + replies
 *   reviews:create          (write)  validate → insert → moderate → audit
 *   reviews:moderate        (write)  approve/reject a flagged review
 *   reviews:reply           (write)  merchant reply (7-day SLA enforced)
 *   reviews:resolveFollowUp (write)  close the 14-day follow-up window
 *   reviews:flags           (read)   pending moderation queue
 *
 *   Every write appends an audit event through the hash chain.
 * ========================================================================= */

interface ListPayload        { limit?: number; offset?: number; status?: string; moderation?: string; }
interface GetPayload         { id: string; }
interface CreatePayload      {
  targetType:  'order' | 'contract' | 'seat_room' | 'other';
  targetId:    string;
  rating:      number;
  title?:      string;
  body:        string;
  /** Assets uploaded as base64-encoded bytes.  The IPC boundary does the
   *  base64→Buffer conversion so the renderer never touches `Buffer`. */
  assets?:     Array<{ mimeType: string; sizeBytes: number; base64: string }>;
}
interface FollowUpPayload    {
  parentReviewId: string;
  rating:         number;
  title?:         string;
  body:           string;
  assets?:        Array<{ mimeType: string; sizeBytes: number; base64: string }>;
}
interface ModeratePayload    { id: string; decision: 'approve' | 'reject'; reason?: string; }
interface ReplyPayload       {
  reviewId:        string;
  body:            string;
  /** When the SLA has expired, admins may explicitly override with a
   *  reason — the reason is written into the audit chain. */
  policyOverride?: boolean;
  overrideReason?: string;
}
interface ResolveFollowUp    { id: string; }

const FOLLOW_UP_WINDOW_SECONDS = 14 * 86400;
const REPLY_WINDOW_SECONDS     =  7 * 86400;

export function registerReviewsHandlers(): void {
  // ── reviews:list ─────────────────────────────────────────────────────
  registerGuarded<ListPayload, unknown[]>(
    'reviews:list',
    { permission: 'review.list', type: 'api', action: 'read' },
    (ctx, payload) => {
      const parts  = ['r.tenant_id = @tenantId'];
      const params: Record<string, unknown> = { tenantId: ctx.tenantId };
      if (payload.status)     { parts.push('r.status = @status'); params.status = payload.status; }
      if (payload.moderation) { parts.push('r.moderation_status = @mod'); params.mod = payload.moderation; }
      const limit  = Math.min(payload.limit ?? 100, 500);
      const offset = payload.offset ?? 0;
      return getDb().prepare(`
        SELECT r.id, r.target_type AS targetType, r.target_id AS targetId,
               r.reviewer_user_id AS reviewerUserId, r.rating, r.title, r.body,
               r.status, r.moderation_status AS moderationStatus,
               r.flag_count AS flagCount,
               r.follow_up_due_at AS followUpDueAt,
               r.reply_due_at AS replyDueAt,
               r.created_at AS createdAt, r.updated_at AS updatedAt
          FROM reviews r
         WHERE ${parts.join(' AND ')}
         ORDER BY r.created_at DESC
         LIMIT @limit OFFSET @offset
      `).all({ ...params, limit, offset });
    },
  );

  // ── reviews:get ──────────────────────────────────────────────────────
  registerGuarded<GetPayload, unknown>(
    'reviews:get',
    { permission: 'review.list', type: 'api', action: 'read' },
    (ctx, payload) => {
      const db = getDb();
      const r = db.prepare(`
        SELECT * FROM reviews WHERE id = @id AND tenant_id = @tenantId
      `).get({ id: payload.id, tenantId: ctx.tenantId });
      if (!r) return null;
      const flags = db.prepare(`
        SELECT id, kind, severity, details, created_at AS createdAt, resolved_at AS resolvedAt
          FROM review_moderation_flags
         WHERE review_id = @id AND tenant_id = @tenantId
         ORDER BY created_at DESC
      `).all({ id: payload.id, tenantId: ctx.tenantId });
      const replies = db.prepare(`
        SELECT id, author_user_id AS authorUserId, body, created_at AS createdAt
          FROM review_replies
         WHERE review_id = @id AND tenant_id = @tenantId
         ORDER BY created_at ASC
      `).all({ id: payload.id, tenantId: ctx.tenantId });
      return { review: r, flags, replies };
    },
  );

  // ── reviews:create ──────────────────────────────────────────────────
  registerGuarded<CreatePayload, unknown>(
    'reviews:create',
    { permission: 'review.create', type: 'api', action: 'write' },
    async (ctx, payload) => {
      const db = getDb();

      const issues = validateReview({
        rating: payload.rating, title: payload.title, body: payload.body,
        assets: payload.assets?.map((a) => ({ mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
      });
      if (issues.length) return { ok: false, issues };

      const id   = `rev_${crypto.randomBytes(10).toString('hex')}`;
      const now  = Math.floor(Date.now() / 1000);

      db.prepare(`
        INSERT INTO reviews
          (id, tenant_id, target_type, target_id, reviewer_user_id,
           rating, title, body, status, moderation_status,
           flag_count, follow_up_due_at, reply_due_at,
           submitted_at, created_at, updated_at)
        VALUES
          (@id, @tenantId, @targetType, @targetId, @reviewerId,
           @rating, @title, @body, 'submitted', 'pending',
           0, @followUpDue, @replyDue,
           @now, @now, @now)
      `).run({
        id, tenantId: ctx.tenantId,
        targetType:   payload.targetType,
        targetId:     payload.targetId,
        reviewerId:   ctx.userId,
        rating:       payload.rating,
        title:        payload.title ?? null,
        body:         payload.body,
        followUpDue:  now + FOLLOW_UP_WINDOW_SECONDS,
        replyDue:     now + REPLY_WINDOW_SECONDS,
        now,
      });

      // Persist asset files if any were supplied.  Failure here rolls
      // back the filesystem writes, but we still want the review row to
      // survive (moderation / audit have already started).  We surface
      // the asset failure so the renderer can prompt the user to retry.
      let assetFailure: string | null = null;
      let persistedAssets: Array<{ id: string; filePath: string }> = [];
      if (payload.assets && payload.assets.length > 0) {
        try {
          const assetInputs: AssetInput[] = payload.assets.map((a) => ({
            mimeType:  a.mimeType,
            sizeBytes: a.sizeBytes,
            data:      Buffer.from(a.base64, 'base64'),
          }));
          persistedAssets = await persistReviewAssets(db, ctx.tenantId, id, assetInputs);
        } catch (err) {
          assetFailure = err instanceof AssetValidationError
            ? err.message
            : `review_asset:write_failed:${(err as Error).message}`;
        }
      }

      const moderation = moderateReview(db, {
        id, tenantId: ctx.tenantId, reviewerUserId: ctx.userId,
        targetType: payload.targetType, targetId: payload.targetId,
        title: payload.title, body: payload.body,
      });

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'review.created',
        entityType:  'review',
        entityId:    id,
        payload: {
          rating:        payload.rating,
          targetType:    payload.targetType,
          targetId:      payload.targetId,
          verdict:       moderation.verdict,
          flagCount:     moderation.flags.length,
          assetCount:    persistedAssets.length,
          assetFailure,
        },
      });

      return { ok: true, id, moderation, assets: persistedAssets, assetFailure };
    },
  );

  // ── reviews:followUp ────────────────────────────────────────────────
  // A follow-up review is a NEW review referencing a prior one, allowed only
  // within 14 days of the parent's submission.  It reuses the validation
  // pipeline and persists assets the same way.
  registerGuarded<FollowUpPayload, unknown>(
    'reviews:followUp',
    { permission: 'review.create', type: 'api', action: 'write' },
    async (ctx, payload) => {
      const db = getDb();

      const parent = db.prepare(`
        SELECT id, tenant_id, target_type, target_id, submitted_at, follow_up_due_at
          FROM reviews
         WHERE id = @id AND tenant_id = @tenantId
      `).get({ id: payload.parentReviewId, tenantId: ctx.tenantId }) as
        { id: string; tenant_id: string; target_type: string; target_id: string;
          submitted_at: number | null; follow_up_due_at: number | null } | undefined;
      if (!parent) {
        throw new AccessDeniedError('parent_review_not_found', 'reviews:followUp');
      }

      const now = Math.floor(Date.now() / 1000);
      if (parent.follow_up_due_at !== null && now > parent.follow_up_due_at) {
        return { ok: false, error: 'follow_up_window_expired' };
      }

      const issues = validateReview({
        rating: payload.rating, title: payload.title, body: payload.body,
        assets: payload.assets?.map((a) => ({ mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
      });
      if (issues.length) return { ok: false, issues };

      const id = `rev_${crypto.randomBytes(10).toString('hex')}`;
      db.prepare(`
        INSERT INTO reviews
          (id, tenant_id, target_type, target_id, reviewer_user_id,
           rating, title, body, status, moderation_status,
           flag_count, follow_up_due_at, reply_due_at,
           submitted_at, created_at, updated_at)
        VALUES
          (@id, @tenantId, @targetType, @targetId, @reviewerId,
           @rating, @title, @body, 'submitted', 'pending',
           0, NULL, @replyDue,
           @now, @now, @now)
      `).run({
        id, tenantId: ctx.tenantId,
        targetType:   parent.target_type,
        targetId:     parent.target_id,
        reviewerId:   ctx.userId,
        rating:       payload.rating,
        title:        payload.title ?? null,
        body:         payload.body,
        replyDue:     now + REPLY_WINDOW_SECONDS,
        now,
      });

      let persistedAssets: Array<{ id: string; filePath: string }> = [];
      let assetFailure: string | null = null;
      if (payload.assets && payload.assets.length > 0) {
        try {
          persistedAssets = await persistReviewAssets(
            db, ctx.tenantId, id,
            payload.assets.map((a) => ({
              mimeType:  a.mimeType, sizeBytes: a.sizeBytes,
              data:      Buffer.from(a.base64, 'base64'),
            })),
          );
        } catch (err) {
          assetFailure = err instanceof AssetValidationError
            ? err.message
            : `review_asset:write_failed:${(err as Error).message}`;
        }
      }

      const moderation = moderateReview(db, {
        id, tenantId: ctx.tenantId, reviewerUserId: ctx.userId,
        targetType: parent.target_type, targetId: parent.target_id,
        title: payload.title, body: payload.body,
      });

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'review.follow_up_created',
        entityType:  'review',
        entityId:    id,
        payload: {
          parentReviewId: parent.id,
          assetCount:     persistedAssets.length,
          verdict:        moderation.verdict,
          assetFailure,
        },
      });

      // Closing the parent's follow-up window — once a follow-up is
      // accepted, the 14-day countdown is extinguished.
      db.prepare(
        `UPDATE reviews SET follow_up_due_at = NULL, updated_at = @now WHERE id = @id AND tenant_id = @tenantId`,
      ).run({ id: parent.id, tenantId: ctx.tenantId, now });

      return { ok: true, id, parentReviewId: parent.id, assets: persistedAssets, assetFailure };
    },
  );

  // ── reviews:moderate ─────────────────────────────────────────────────
  registerGuarded<ModeratePayload, unknown>(
    'reviews:moderate',
    { permission: 'review.moderate', type: 'api', action: 'write' },
    (ctx, payload) => {
      const db = getDb();
      const row = db.prepare(`
        SELECT id, tenant_id FROM reviews WHERE id = @id AND tenant_id = @tenantId
      `).get({ id: payload.id, tenantId: ctx.tenantId });
      if (!row) throw new AccessDeniedError('review_not_found', 'reviews:moderate');

      const now     = Math.floor(Date.now() / 1000);
      const status  = payload.decision === 'approve' ? 'approved' : 'rejected';
      db.prepare(`
        UPDATE reviews
           SET status = @status, moderation_status = 'clean', resolved_at = @now, updated_at = @now
         WHERE id = @id AND tenant_id = @tenantId
      `).run({ status, id: payload.id, tenantId: ctx.tenantId, now });

      // Resolve open flags — records who closed them.
      db.prepare(`
        UPDATE review_moderation_flags
           SET resolved_at = @now, resolved_by = @by
         WHERE review_id = @id AND tenant_id = @tenantId AND resolved_at IS NULL
      `).run({ now, by: ctx.userId, id: payload.id, tenantId: ctx.tenantId });

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      `review.${payload.decision}`,
        entityType:  'review',
        entityId:    payload.id,
        payload:     { reason: payload.reason ?? null },
      });
      return { ok: true, status };
    },
  );

  // ── reviews:reply ────────────────────────────────────────────────────
  // Merchant reply MUST land within 7 days of the review's submission.
  // Late replies are rejected with `reply_sla_expired` UNLESS the caller
  // explicitly sets policyOverride=true AND supplies overrideReason; in
  // that case we accept the reply and audit both the override and the
  // reason so compliance can trace the exception later.
  registerGuarded<ReplyPayload, unknown>(
    'reviews:reply',
    { permission: 'review.reply', type: 'api', action: 'write' },
    (ctx, payload) => {
      const db = getDb();

      if (!payload.body || payload.body.length === 0) {
        return { ok: false, error: 'empty_body' };
      }
      if (payload.body.length > REVIEW_LIMITS.TEXT_MAX) {
        return { ok: false, error: 'body_too_long' };
      }

      const row = db.prepare(`
        SELECT id, reply_due_at FROM reviews WHERE id = @id AND tenant_id = @tenantId
      `).get({ id: payload.reviewId, tenantId: ctx.tenantId }) as
        { id: string; reply_due_at: number | null } | undefined;
      if (!row) throw new AccessDeniedError('review_not_found', 'reviews:reply');

      const now       = Math.floor(Date.now() / 1000);
      const slaMet    = row.reply_due_at === null || now <= row.reply_due_at;

      if (!slaMet) {
        const hasOverride = payload.policyOverride === true
          && typeof payload.overrideReason === 'string'
          && payload.overrideReason.trim().length > 0;

        if (!hasOverride) {
          // Record the rejection for compliance — missed SLA is itself a
          // material event even when no reply is written.
          appendAuditEvent(db, {
            tenantId:    ctx.tenantId,
            actorUserId: ctx.userId,
            action:      'review.reply_rejected_sla',
            entityType:  'review',
            entityId:    payload.reviewId,
            payload:     { replyDueAt: row.reply_due_at, now },
          });
          return { ok: false, error: 'reply_sla_expired' };
        }

        // Override path: must be an admin role.  Guard this here (in
        // addition to the permission grant) so a plain OperationsManager
        // cannot bypass the SLA even if they have `review.reply`.
        if (!ctx.roles.includes('TenantAdmin') && !ctx.roles.includes('SystemAdmin')) {
          appendAuditEvent(db, {
            tenantId:    ctx.tenantId,
            actorUserId: ctx.userId,
            action:      'review.reply_override_denied',
            entityType:  'review',
            entityId:    payload.reviewId,
            payload:     { reason: 'role_not_admin' },
          });
          return { ok: false, error: 'override_requires_admin' };
        }
      }

      const replyId = `rrp_${crypto.randomBytes(10).toString('hex')}`;
      db.prepare(`
        INSERT INTO review_replies
          (id, tenant_id, review_id, author_user_id, body, created_at, updated_at)
        VALUES
          (@id, @tenantId, @reviewId, @authorId, @body, @now, @now)
      `).run({
        id: replyId, tenantId: ctx.tenantId,
        reviewId: payload.reviewId, authorId: ctx.userId,
        body: payload.body, now,
      });

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      slaMet ? 'review.replied' : 'review.reply_late_override',
        entityType:  'review',
        entityId:    payload.reviewId,
        payload: {
          replyId,
          withinSla:      slaMet,
          policyOverride: slaMet ? false : true,
          overrideReason: slaMet ? null : payload.overrideReason ?? null,
        },
      });
      return { ok: true, replyId, withinSla: slaMet, override: !slaMet };
    },
  );

  // ── reviews:resolveFollowUp ──────────────────────────────────────────
  registerGuarded<ResolveFollowUp, unknown>(
    'reviews:resolveFollowUp',
    { permission: 'review.moderate', type: 'api', action: 'write' },
    (ctx, payload) => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        UPDATE reviews SET follow_up_due_at = NULL, updated_at = @now
         WHERE id = @id AND tenant_id = @tenantId
      `).run({ id: payload.id, tenantId: ctx.tenantId, now });

      appendAuditEvent(db, {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'review.follow_up_closed',
        entityType:  'review',
        entityId:    payload.id,
      });
      return { ok: true };
    },
  );

  // ── reviews:flags ────────────────────────────────────────────────────
  registerGuarded<Record<string, never>, unknown[]>(
    'reviews:flags',
    { permission: 'review.moderate', type: 'api', action: 'read' },
    (ctx) => {
      return getDb().prepare(`
        SELECT f.id, f.review_id AS reviewId, f.kind, f.severity, f.details,
               f.created_at AS createdAt
          FROM review_moderation_flags f
         WHERE f.tenant_id = @tenantId AND f.resolved_at IS NULL
         ORDER BY f.created_at DESC
         LIMIT 200
      `).all({ tenantId: ctx.tenantId });
    },
  );
}
