import { describe, expect, it } from 'vitest';
import { validateReview } from '../../src/main/reviews/validation';
import { moderateReview } from '../../src/main/reviews/moderation';
import { makeTestDb, seedAccessGraph } from '../../unit_tests/_helpers/db';

/* =========================================================================
 *  Reviews — validation + moderation integrated end-to-end.
 * ========================================================================= */

describe('review validation + moderation pipeline', () => {
  it('happy path: validate, persist, moderate clean', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    const input = { rating: 5, body: 'Perfectly normal review body.' };
    expect(validateReview(input)).toEqual([]);

    db.prepare(`
      INSERT INTO reviews
        (id, tenant_id, target_type, target_id, reviewer_user_id, rating, body, status, created_at, updated_at)
      VALUES (?, ?, 'order', 'o1', ?, ?, ?, 'submitted', ?, ?)
    `).run('rv_clean', ids.tenantId, ids.opsUserId, input.rating, input.body,
      Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));

    const result = moderateReview(db, {
      id: 'rv_clean', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'o1', body: input.body,
    });
    expect(result.verdict).toBe('clean');

    const row = db.prepare('SELECT moderation_status FROM reviews WHERE id = ?').get('rv_clean') as any;
    expect(row.moderation_status).toBe('clean');
  });

  it('flagged + quarantined reviews accumulate flag rows', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    db.prepare('INSERT INTO sensitive_words (id, tenant_id, word, severity, category, active) VALUES (?, ?, ?, ?, ?, 1)')
      .run('w1', ids.tenantId, 'scam', 'block', 'fraud');

    db.prepare(`
      INSERT INTO reviews
        (id, tenant_id, target_type, target_id, reviewer_user_id, rating, body, status, created_at, updated_at)
      VALUES ('rv_q', ?, 'order', 'o2', ?, 1, 'This was a scam and a scam', 'submitted', ?, ?)
    `).run(ids.tenantId, ids.opsUserId, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));

    const res = moderateReview(db, {
      id: 'rv_q', tenantId: ids.tenantId, reviewerUserId: ids.opsUserId,
      targetType: 'order', targetId: 'o2', body: 'This was a scam and a scam',
    });
    expect(res.verdict).toBe('quarantined');

    const flagsCount = db.prepare('SELECT COUNT(*) AS n FROM review_moderation_flags WHERE review_id = ?').get('rv_q') as any;
    expect(flagsCount.n).toBeGreaterThanOrEqual(1);
  });
});
