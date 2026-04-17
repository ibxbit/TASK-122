/* =========================================================================
 * Review Validation — synchronous input checks, zero DB dependency.
 *
 *  Rules (from product spec):
 *    • rating ∈ [1, 5] (integer)
 *    • body length ≤ 2000 chars (required, non-empty)
 *    • ≤ 5 image assets
 *    • each asset mime ∈ { image/jpeg, image/png }
 *    • each asset size ≤ 5 MiB
 * ========================================================================= */

export const REVIEW_LIMITS = {
  RATING_MIN:       1,
  RATING_MAX:       5,
  TEXT_MAX:         2000,
  TITLE_MAX:        200,
  MAX_ASSETS:       5,
  MAX_ASSET_BYTES:  5 * 1024 * 1024,                       // 5 MiB
  ALLOWED_MIME:     ['image/jpeg', 'image/png'] as const,
} as const;

export interface ReviewAssetInput {
  mimeType:  string;
  sizeBytes: number;
}

export interface ReviewInput {
  rating:   number;
  title?:   string;
  body:     string;
  assets?:  ReviewAssetInput[];
}

export interface ValidationIssue {
  field:    string;
  code:     string;
  message:  string;
}

export function validateReview(input: ReviewInput): ValidationIssue[] {
  const errs: ValidationIssue[] = [];

  // rating -----------------------------------------------------------------
  if (!Number.isInteger(input.rating) ||
      input.rating < REVIEW_LIMITS.RATING_MIN ||
      input.rating > REVIEW_LIMITS.RATING_MAX) {
    errs.push({
      field:   'rating',
      code:    'rating_range',
      message: `Rating must be an integer ${REVIEW_LIMITS.RATING_MIN}–${REVIEW_LIMITS.RATING_MAX}`,
    });
  }

  // body -------------------------------------------------------------------
  const body = input.body ?? '';
  if (body.trim().length === 0) {
    errs.push({ field: 'body', code: 'body_required', message: 'Review text is required' });
  } else if (body.length > REVIEW_LIMITS.TEXT_MAX) {
    errs.push({
      field:   'body',
      code:    'body_too_long',
      message: `Review text exceeds ${REVIEW_LIMITS.TEXT_MAX} characters (got ${body.length})`,
    });
  }

  // title (optional) -------------------------------------------------------
  if (input.title && input.title.length > REVIEW_LIMITS.TITLE_MAX) {
    errs.push({
      field:   'title',
      code:    'title_too_long',
      message: `Title exceeds ${REVIEW_LIMITS.TITLE_MAX} characters`,
    });
  }

  // assets -----------------------------------------------------------------
  const assets = input.assets ?? [];
  if (assets.length > REVIEW_LIMITS.MAX_ASSETS) {
    errs.push({
      field:   'assets',
      code:    'too_many_assets',
      message: `No more than ${REVIEW_LIMITS.MAX_ASSETS} images allowed (got ${assets.length})`,
    });
  }
  assets.forEach((a, i) => {
    if (!(REVIEW_LIMITS.ALLOWED_MIME as readonly string[]).includes(a.mimeType)) {
      errs.push({
        field:   `assets[${i}].mimeType`,
        code:    'asset_mime_invalid',
        message: `${a.mimeType} not allowed; use JPG or PNG`,
      });
    }
    if (!Number.isFinite(a.sizeBytes) || a.sizeBytes <= 0) {
      errs.push({
        field:   `assets[${i}].sizeBytes`,
        code:    'asset_size_invalid',
        message: 'Asset size must be a positive number',
      });
    } else if (a.sizeBytes > REVIEW_LIMITS.MAX_ASSET_BYTES) {
      errs.push({
        field:   `assets[${i}].sizeBytes`,
        code:    'asset_too_large',
        message: `Image exceeds ${REVIEW_LIMITS.MAX_ASSET_BYTES} bytes (got ${a.sizeBytes})`,
      });
    }
  });

  return errs;
}

export class ReviewValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super('review_validation_failed');
    this.name = 'ReviewValidationError';
  }
}

/** Throws `ReviewValidationError` with the issue list when input is invalid. */
export function assertValidReview(input: ReviewInput): void {
  const issues = validateReview(input);
  if (issues.length) throw new ReviewValidationError(issues);
}
