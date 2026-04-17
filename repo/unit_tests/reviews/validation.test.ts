import { describe, expect, it } from 'vitest';
import {
  validateReview, assertValidReview, ReviewValidationError, REVIEW_LIMITS,
} from '../../src/main/reviews/validation';

/* =========================================================================
 *  Review validation — rating range, body length, title, asset rules.
 * ========================================================================= */

describe('validateReview()', () => {
  it('accepts a minimal valid review', () => {
    const issues = validateReview({ rating: 5, body: 'Great service!' });
    expect(issues).toEqual([]);
  });

  it('rejects rating out of range', () => {
    const issues = validateReview({ rating: 6, body: 'ok' });
    expect(issues.map((i) => i.code)).toContain('rating_range');
  });

  it('rejects non-integer rating', () => {
    const issues = validateReview({ rating: 4.5, body: 'ok' });
    expect(issues.map((i) => i.code)).toContain('rating_range');
  });

  it('requires a non-empty body', () => {
    const issues = validateReview({ rating: 3, body: '   ' });
    expect(issues.map((i) => i.code)).toContain('body_required');
  });

  it('rejects body exceeding TEXT_MAX', () => {
    const issues = validateReview({ rating: 3, body: 'a'.repeat(REVIEW_LIMITS.TEXT_MAX + 1) });
    expect(issues.map((i) => i.code)).toContain('body_too_long');
  });

  it('rejects titles that are too long', () => {
    const issues = validateReview({
      rating: 3, body: 'ok',
      title: 'x'.repeat(REVIEW_LIMITS.TITLE_MAX + 1),
    });
    expect(issues.map((i) => i.code)).toContain('title_too_long');
  });

  it('rejects too many assets', () => {
    const assets = Array.from({ length: REVIEW_LIMITS.MAX_ASSETS + 1 }, () => ({
      mimeType: 'image/png', sizeBytes: 1000,
    }));
    const issues = validateReview({ rating: 3, body: 'ok', assets });
    expect(issues.map((i) => i.code)).toContain('too_many_assets');
  });

  it('rejects disallowed mime types', () => {
    const issues = validateReview({
      rating: 3, body: 'ok',
      assets: [{ mimeType: 'image/gif', sizeBytes: 1000 }],
    });
    expect(issues.map((i) => i.code)).toContain('asset_mime_invalid');
  });

  it('rejects assets over size limit', () => {
    const issues = validateReview({
      rating: 3, body: 'ok',
      assets: [{ mimeType: 'image/jpeg', sizeBytes: REVIEW_LIMITS.MAX_ASSET_BYTES + 1 }],
    });
    expect(issues.map((i) => i.code)).toContain('asset_too_large');
  });

  it('rejects non-positive asset size', () => {
    const issues = validateReview({
      rating: 3, body: 'ok',
      assets: [{ mimeType: 'image/png', sizeBytes: 0 }],
    });
    expect(issues.map((i) => i.code)).toContain('asset_size_invalid');
  });
});

describe('assertValidReview()', () => {
  it('throws ReviewValidationError with issues when invalid', () => {
    try {
      assertValidReview({ rating: 0, body: '' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewValidationError);
      expect((err as ReviewValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  it('passes silently for valid inputs', () => {
    expect(() => assertValidReview({ rating: 4, body: 'fine' })).not.toThrow();
  });
});
