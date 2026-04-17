import type { Database } from 'better-sqlite3';
import crypto from 'node:crypto';

/* =========================================================================
 * Review Moderation Pipeline
 *
 *  Called synchronously after a review row is inserted.  Produces a verdict
 *  and persists:
 *    • reviews.moderation_status  ← 'clean' | 'flagged' | 'quarantined'
 *    • reviews.flag_count
 *    • reviews.content_hash       (sha256 of normalised body; drives dedupe)
 *    • one row per finding in review_moderation_flags
 *
 *  Pipeline steps
 *   1. Normalise body (lowercase, strip accents & punctuation)
 *   2. Match against per-tenant sensitive_words dictionary
 *   3. Rate-limit: > 3 reviews by same reviewer in last 10 min  → quarantine
 *   4. Duplicate text across different target (location/room)  → quarantine
 *   5. Verdict := max severity across findings
 * ========================================================================= */

export type ModerationVerdict = 'clean' | 'flagged' | 'quarantined';
export type ModerationSeverity = 'soft' | 'flag' | 'block';
export type ModerationFlagKind =
  | 'sensitive_word' | 'rate_limit' | 'duplicate_text' | 'policy';

export interface ModerationFlag {
  kind:      ModerationFlagKind;
  severity:  ModerationSeverity;
  details?:  unknown;
}

export interface ModerationResult {
  verdict:      ModerationVerdict;
  flags:        ModerationFlag[];
  contentHash:  string;
}

export interface ReviewForModeration {
  id:              string;
  tenantId:        string;
  reviewerUserId:  string;
  targetType:      string;
  targetId:        string;
  title?:          string;
  body:            string;
}

const FRAUD_WINDOW_SECONDS = 10 * 60;      // 10 minutes
const FRAUD_RATE_LIMIT     = 3;            // > 3 triggers quarantine

export function moderateReview(db: Database, review: ReviewForModeration): ModerationResult {
  const flags: ModerationFlag[] = [];
  const now   = Math.floor(Date.now() / 1000);

  // ── 1. Normalise + fingerprint ─────────────────────────────────────────
  const combined    = `${review.title ?? ''}\n${review.body}`;
  const normalised  = normalise(combined);
  const tokens      = new Set(normalised.split(' ').filter(Boolean));
  const contentHash = crypto.createHash('sha256').update(normalised).digest('hex');

  // ── 2. Sensitive-word scan ─────────────────────────────────────────────
  const dict = db.prepare(`
    SELECT word, severity, category
      FROM sensitive_words
     WHERE tenant_id = ? AND active = 1
  `).all(review.tenantId) as Array<{ word: string; severity: ModerationSeverity; category: string | null }>;

  const hits: Array<{ word: string; severity: ModerationSeverity; category: string | null }> = [];
  for (const entry of dict) {
    const w   = entry.word.toLowerCase();
    const hit = /\s/.test(w) ? normalised.includes(w) : tokens.has(w);
    if (hit) hits.push({ ...entry, word: w });
  }
  if (hits.length) {
    flags.push({
      kind:     'sensitive_word',
      severity: escalate(hits.map(h => h.severity)),
      details:  { matches: hits },
    });
  }

  // ── 3. Rate-limit: > 3 reviews / 10 min by same reviewer ───────────────
  const recent = db.prepare(`
    SELECT COUNT(*) AS n FROM reviews
     WHERE tenant_id = ? AND reviewer_user_id = ?
       AND id != ?  AND created_at >= ?
  `).get(
    review.tenantId, review.reviewerUserId, review.id,
    now - FRAUD_WINDOW_SECONDS,
  ) as { n: number };

  if (recent.n >= FRAUD_RATE_LIMIT) {
    flags.push({
      kind:     'rate_limit',
      severity: 'block',
      details:  { count: recent.n, windowSeconds: FRAUD_WINDOW_SECONDS, limit: FRAUD_RATE_LIMIT },
    });
  }

  // ── 4. Duplicate text across different target ──────────────────────────
  const dupes = db.prepare(`
    SELECT id, target_type, target_id FROM reviews
     WHERE tenant_id = ? AND content_hash = ? AND id != ?
       AND (target_type != ? OR target_id != ?)
     LIMIT 5
  `).all(
    review.tenantId, contentHash, review.id,
    review.targetType, review.targetId,
  ) as Array<{ id: string; target_type: string; target_id: string }>;

  if (dupes.length) {
    flags.push({
      kind:     'duplicate_text',
      severity: 'block',
      details:  { duplicates: dupes },
    });
  }

  // ── 5. Verdict ─────────────────────────────────────────────────────────
  const top = escalate(flags.map(f => f.severity));
  const verdict: ModerationVerdict =
      flags.length === 0 ? 'clean'
    : top === 'block'    ? 'quarantined'
    :                      'flagged';

  // ── 6. Persist — one transaction ───────────────────────────────────────
  const persist = db.transaction(() => {
    db.prepare(`
      UPDATE reviews
         SET moderation_status = @verdict,
             flag_count        = @count,
             content_hash      = @hash,
             updated_at        = @now
       WHERE id = @id AND tenant_id = @tenantId
    `).run({
      verdict, count: flags.length, hash: contentHash,
      now, id: review.id, tenantId: review.tenantId,
    });

    const insertFlag = db.prepare(`
      INSERT INTO review_moderation_flags
        (id, tenant_id, review_id, kind, severity, details, created_at)
      VALUES
        (@id, @tenantId, @reviewId, @kind, @severity, @details, @now)
    `);
    for (const f of flags) {
      insertFlag.run({
        id:       `mfl_${crypto.randomBytes(10).toString('hex')}`,
        tenantId: review.tenantId,
        reviewId: review.id,
        kind:     f.kind,
        severity: f.severity,
        details:  f.details ? JSON.stringify(f.details) : null,
        now,
      });
    }
  });
  persist();

  return { verdict, flags, contentHash };
}

/* ------------------------------------------------------------------ *
 *  Helpers                                                            *
 * ------------------------------------------------------------------ */

/** Lowercase, strip accents, strip punctuation, collapse whitespace. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')         // combining marks
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')       // punctuation / symbols
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reduces a list of severities to the highest one. */
function escalate(list: ModerationSeverity[]): ModerationSeverity {
  if (list.includes('block')) return 'block';
  if (list.includes('flag'))  return 'flag';
  return 'soft';
}
