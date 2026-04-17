import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({}));

import {
  validateCreateReviewForm, lateReplyPolicyError,
} from '../../src/renderer/imgui/views/reviews';

describe('validateCreateReviewForm', () => {
  it('ok with all valid fields and 0..5 attachments', () => {
    expect(validateCreateReviewForm({
      targetType: 'order', targetId: 'o_1', rating: '5', body: 'nice',
      attachmentCount: 0,
    })).toEqual([]);
    expect(validateCreateReviewForm({
      targetType: 'order', targetId: 'o_1', rating: '5', body: 'nice',
      attachmentCount: 5,
    })).toEqual([]);
  });

  it('rejects invalid targetType', () => {
    const issues = validateCreateReviewForm({
      targetType: 'not_a_thing', targetId: 'o_1', rating: '5', body: 'x', attachmentCount: 0,
    });
    expect(issues[0]).toContain('targetType');
  });

  it('rejects missing targetId + body', () => {
    const issues = validateCreateReviewForm({
      targetType: 'order', targetId: '', rating: '5', body: '', attachmentCount: 0,
    });
    expect(issues).toContain('targetId required');
    expect(issues).toContain('body required');
  });

  it('rejects rating outside 1..5', () => {
    for (const bad of ['0', '6', '-1', 'abc']) {
      const issues = validateCreateReviewForm({
        targetType: 'order', targetId: 'o_1', rating: bad, body: 'x', attachmentCount: 0,
      });
      expect(issues.some((i) => i.includes('rating'))).toBe(true);
    }
  });

  it('rejects > 5 attachments', () => {
    const issues = validateCreateReviewForm({
      targetType: 'order', targetId: 'o_1', rating: '5', body: 'x', attachmentCount: 6,
    });
    expect(issues).toContain('max 5 attachments');
  });

  it('rejects body over 2000 chars', () => {
    const issues = validateCreateReviewForm({
      targetType: 'order', targetId: 'o_1', rating: '5',
      body: 'x'.repeat(2001), attachmentCount: 0,
    });
    expect(issues.some((i) => i.startsWith('body too long'))).toBe(true);
  });
});

describe('lateReplyPolicyError', () => {
  it('returns null when SLA is met (no override needed)', () => {
    expect(lateReplyPolicyError({
      slaMet: true, policyOverride: false, overrideReason: '', isAdmin: false,
    })).toBeNull();
  });

  it('reports reply_sla_expired when late and override off', () => {
    expect(lateReplyPolicyError({
      slaMet: false, policyOverride: false, overrideReason: '', isAdmin: true,
    })).toBe('reply_sla_expired');
  });

  it('reports override_reason_required when override is on but reason blank', () => {
    expect(lateReplyPolicyError({
      slaMet: false, policyOverride: true, overrideReason: '   ', isAdmin: true,
    })).toBe('override_reason_required');
  });

  it('reports override_requires_admin when non-admin tries to override', () => {
    expect(lateReplyPolicyError({
      slaMet: false, policyOverride: true, overrideReason: 'escalation 42', isAdmin: false,
    })).toBe('override_requires_admin');
  });

  it('returns null on the happy late-override admin path', () => {
    expect(lateReplyPolicyError({
      slaMet: false, policyOverride: true, overrideReason: 'escalation 42', isAdmin: true,
    })).toBeNull();
  });
});
