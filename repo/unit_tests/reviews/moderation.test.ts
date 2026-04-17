import { describe, expect, it } from 'vitest';
import { moderateReview } from '../../src/main/reviews/moderation';
import { makeTestDb, seedAccessGraph } from '../_helpers/db';

/* =========================================================================
 *  Review moderation — sensitive words, rate limit, duplicate text.
 * ========================================================================= */

function insertReview(db: ReturnType<typeof makeTestDb>, row: {
  id: string; tenantId: string; reviewerUserId: string;
  targetType: string; targetId: string; body: string;
  title?: string; createdAt?: number;
}) {
  db.prepare(`
    INSERT INTO reviews
      (id, tenant_id, target_type, target_id, reviewer_user_id,
       rating, title, body, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 4, ?, ?, 'draft', ?, ?)
  `).run(
    row.id, row.tenantId, row.targetType, row.targetId, row.reviewerUserId,
    row.title ?? null, row.body,
    row.createdAt ?? Math.floor(Date.now() / 1000),
    row.createdAt ?? Math.floor(Date.now() / 1000),
  );
}

describe('moderateReview()', () => {
  it('marks clean reviews as clean', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    insertReview(db, {
      id: 'rv1', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'o1', body: 'Nice place',
    });
    const r = moderateReview(db, {
      id: 'rv1', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'o1', body: 'Nice place',
    });
    expect(r.verdict).toBe('clean');
    expect(r.flags).toEqual([]);
  });

  it('flags sensitive words (soft severity)', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    db.prepare('INSERT INTO sensitive_words (id, tenant_id, word, severity, category, active) VALUES (?, ?, ?, ?, ?, 1)')
      .run('sw1', ids.tenantId, 'terrible', 'soft', 'sentiment');

    insertReview(db, {
      id: 'rv2', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'o2', body: 'The service was terrible.',
    });
    const r = moderateReview(db, {
      id: 'rv2', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'o2', body: 'The service was terrible.',
    });
    expect(r.verdict).toBe('flagged');
    expect(r.flags[0].kind).toBe('sensitive_word');
  });

  it('quarantines on block-severity word', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    db.prepare('INSERT INTO sensitive_words (id, tenant_id, word, severity, category, active) VALUES (?, ?, ?, ?, ?, 1)')
      .run('sw2', ids.tenantId, 'scam', 'block', 'fraud');

    insertReview(db, {
      id: 'rv3', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'o3', body: 'This was a scam.',
    });
    const r = moderateReview(db, {
      id: 'rv3', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'o3', body: 'This was a scam.',
    });
    expect(r.verdict).toBe('quarantined');
  });

  it('quarantines on rate-limit burst (>3 in 10 min)', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < 3; i++) {
      insertReview(db, {
        id: `prior${i}`, tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
        targetType: 'order', targetId: `o_prior_${i}`, body: `review ${i}`,
        createdAt: now - 60,
      });
    }
    insertReview(db, {
      id: 'burst', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'o_burst', body: 'ok',
    });
    const r = moderateReview(db, {
      id: 'burst', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'o_burst', body: 'ok',
    });
    expect(r.verdict).toBe('quarantined');
    expect(r.flags.some((f) => f.kind === 'rate_limit')).toBe(true);
  });

  it('quarantines on duplicate body across different target', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const body = 'Absolutely identical duplicated body text.';

    // Seed an existing review on a different target with a matching content_hash.
    insertReview(db, {
      id: 'dup_seed', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'first_target', body,
    });
    // Prime its content_hash via an initial moderation pass.
    moderateReview(db, {
      id: 'dup_seed', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'first_target', body,
    });

    // New review on a DIFFERENT target with the same body.
    insertReview(db, {
      id: 'dup_new', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'other_target', body,
    });
    const r = moderateReview(db, {
      id: 'dup_new', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'other_target', body,
    });
    expect(r.verdict).toBe('quarantined');
    expect(r.flags.some((f) => f.kind === 'duplicate_text')).toBe(true);
  });

  it('persists verdict on reviews row and writes flag rows', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    db.prepare('INSERT INTO sensitive_words (id, tenant_id, word, severity, category, active) VALUES (?, ?, ?, ?, ?, 1)')
      .run('sw3', ids.tenantId, 'horrible', 'flag', 'sentiment');

    insertReview(db, {
      id: 'persist', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'opersist', body: 'simply horrible',
    });
    moderateReview(db, {
      id: 'persist', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'opersist', body: 'simply horrible',
    });
    const row = db.prepare('SELECT moderation_status, flag_count, content_hash FROM reviews WHERE id = ?').get('persist') as any;
    expect(row.moderation_status).toBe('flagged');
    expect(row.flag_count).toBe(1);
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const flag = db.prepare('SELECT kind, severity FROM review_moderation_flags WHERE review_id = ?').get('persist') as any;
    expect(flag.kind).toBe('sensitive_word');
    expect(flag.severity).toBe('flag');
  });
});
