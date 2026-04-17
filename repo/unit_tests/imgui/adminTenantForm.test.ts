import { describe, it, expect, vi } from 'vitest';

// The admin view imports widgets → context menu → runtime.  Only pulling
// the validator from the module avoids dragging those in.  The export is
// tree-shakeable in ESM so the test only touches pure logic.
vi.mock('electron', () => ({}));

import { validateCreateTenantForm } from '../../src/renderer/imgui/views/admin';

describe('validateCreateTenantForm', () => {
  it('ok with valid fields', () => {
    expect(validateCreateTenantForm({
      tenantId: 't_alpha', name: 'Alpha',
      adminUsername: 'a', adminDisplayName: 'A',
      adminPassword: 'longenough',
    })).toEqual([]);
  });

  it('flags every missing / invalid field with a dedicated message', () => {
    const issues = validateCreateTenantForm({
      tenantId: '  ', name: '',
      adminUsername: '', adminDisplayName: '',
      adminPassword: 'short',
    });
    expect(issues).toContain('tenant id required');
    expect(issues).toContain('name required');
    expect(issues).toContain('admin username required');
    expect(issues).toContain('admin display name required');
    expect(issues.some((i) => i.includes('admin password'))).toBe(true);
  });

  it('rejects non-canonical tenant ids', () => {
    const issues = validateCreateTenantForm({
      tenantId: 'Has Caps!', name: 'X',
      adminUsername: 'u', adminDisplayName: 'U',
      adminPassword: 'longenough',
    });
    expect(issues.some((i) => i.startsWith('tenant id must be'))).toBe(true);
  });

  it('accepts valid lower-case id with hyphens + underscores', () => {
    expect(validateCreateTenantForm({
      tenantId: 't_beta-2', name: 'Beta',
      adminUsername: 'u', adminDisplayName: 'U',
      adminPassword: 'longenough',
    })).toEqual([]);
  });
});
