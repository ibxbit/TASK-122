import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

/* =========================================================================
 * Reviews handler — follow-up + reply SLA + override coverage.
 * ========================================================================= */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
let tmpUserData = '';
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, payload: unknown) => unknown) => handlers.set(ch, fn),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  app: { getPath: () => tmpUserData, getVersion: () => '1.0.0', getAppPath: () => tmpUserData, whenReady: () => Promise.resolve() },
}));

import { makeTestDb, seedAccessGraph, type SeededIds } from '../_helpers/db';
import { initDbLifecycle } from '../../src/main/db/cleanup';
import { bootstrapFirstRun } from '../../src/main/db/bootstrap';
import { setSession, clearAllSessions } from '../../src/main/session';
import { registerReviewsHandlers } from '../../src/main/ipc/reviews.handler';

function invoke(channel: string, senderId: number, payload: unknown = {}): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no_handler_for:${channel}`);
  return fn({ sender: { id: senderId } }, payload);
}

describe('reviews:followUp + reviews:reply SLA', () => {
  let db: ReturnType<typeof makeTestDb>;
  let ids: SeededIds;

  beforeEach(() => {
    tmpUserData = mkdtempSync(path.join(os.tmpdir(), 'lh-reviews-'));
    db = makeTestDb();
    ids = seedAccessGraph(db);
    bootstrapFirstRun(db);
    try { initDbLifecycle({ db }); } catch { /* already */ }
    handlers.clear();
    clearAllSessions();
    registerReviewsHandlers();
  });

  afterEach(() => {
    clearAllSessions();
    db.close();
    handlers.clear();
    try { rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('rejects follow-up after 14-day window has elapsed', async () => {
    setSession(10, {
      userId: ids.opsUserId, tenantId: ids.tenantId,
      roles: ['OperationsManager'], loggedInAt: 0,
    });
    const longAgo = Math.floor(Date.now() / 1000) - 20 * 86400;
    db.prepare(`
      INSERT INTO reviews (id, tenant_id, target_type, target_id, reviewer_user_id,
                           rating, body, status, moderation_status,
                           submitted_at, follow_up_due_at, reply_due_at, created_at, updated_at)
      VALUES ('rev_parent', @tenantId, 'order', 'o_1', @uid, 5, 'body', 'submitted', 'clean',
              @long, @expired, @long, @long, @long)
    `).run({ tenantId: ids.tenantId, uid: ids.opsUserId, long: longAgo, expired: longAgo + 14 * 86400 });

    const r = await invoke('reviews:followUp', 10, {
      parentReviewId: 'rev_parent', rating: 4, body: 'still slow',
    }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('follow_up_window_expired');
  });

  it('accepts follow-up inside the 14-day window and closes the parent\'s follow_up_due_at', async () => {
    setSession(11, {
      userId: ids.opsUserId, tenantId: ids.tenantId,
      roles: ['OperationsManager'], loggedInAt: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO reviews (id, tenant_id, target_type, target_id, reviewer_user_id,
                           rating, body, status, moderation_status,
                           submitted_at, follow_up_due_at, reply_due_at, created_at, updated_at)
      VALUES ('rev_ok', @tenantId, 'order', 'o_2', @uid, 3, 'body', 'submitted', 'clean',
              @now, @fu, @reply, @now, @now)
    `).run({ tenantId: ids.tenantId, uid: ids.opsUserId, now, fu: now + 14 * 86400, reply: now + 7 * 86400 });

    const r = await invoke('reviews:followUp', 11, {
      parentReviewId: 'rev_ok', rating: 5, body: 'better now',
    }) as { ok: boolean; id: string };
    expect(r.ok).toBe(true);
    expect(r.id).toMatch(/^rev_/);

    const parent = db.prepare('SELECT follow_up_due_at FROM reviews WHERE id = ?')
      .get('rev_ok') as { follow_up_due_at: number | null };
    expect(parent.follow_up_due_at).toBeNull();

    const ae = db.prepare(`
      SELECT action FROM audit_events WHERE entity_id = ? AND action = 'review.follow_up_created'
    `).get(r.id);
    expect(ae).toBeTruthy();
  });

  it('reply within 7 days → withinSla=true', async () => {
    setSession(12, {
      userId: ids.opsUserId, tenantId: ids.tenantId,
      roles: ['OperationsManager'], loggedInAt: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO reviews (id, tenant_id, target_type, target_id, reviewer_user_id,
                           rating, body, status, moderation_status,
                           reply_due_at, created_at, updated_at)
      VALUES ('rev_rep', @tenantId, 'order', 'o_3', @uid, 4, 'b', 'submitted', 'clean',
              @fut, @now, @now)
    `).run({ tenantId: ids.tenantId, uid: ids.opsUserId, fut: now + 86400, now });

    const r = await invoke('reviews:reply', 12, {
      reviewId: 'rev_rep', body: 'thank you',
    }) as { ok: boolean; withinSla: boolean; override: boolean };
    expect(r.ok).toBe(true);
    expect(r.withinSla).toBe(true);
    expect(r.override).toBe(false);
  });

  it('reply past 7 days without override → reply_sla_expired + audit event', async () => {
    setSession(13, {
      userId: ids.opsUserId, tenantId: ids.tenantId,
      roles: ['OperationsManager'], loggedInAt: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO reviews (id, tenant_id, target_type, target_id, reviewer_user_id,
                           rating, body, status, moderation_status,
                           reply_due_at, created_at, updated_at)
      VALUES ('rev_late', @tenantId, 'order', 'o_4', @uid, 4, 'b', 'submitted', 'clean',
              @past, @now, @now)
    `).run({ tenantId: ids.tenantId, uid: ids.opsUserId, past: now - 86400, now });

    const r = await invoke('reviews:reply', 13, {
      reviewId: 'rev_late', body: 'sorry we missed this',
    }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('reply_sla_expired');

    const rejected = db.prepare(`
      SELECT 1 AS ok FROM audit_events WHERE action = 'review.reply_rejected_sla' AND entity_id = ?
    `).get('rev_late');
    expect(rejected).toBeTruthy();
  });

  it('reply past 7 days WITH TenantAdmin override + reason → accepted + chain-audit override', async () => {
    setSession(14, {
      userId: ids.adminUserId, tenantId: ids.tenantId,
      roles: ['TenantAdmin'], loggedInAt: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO reviews (id, tenant_id, target_type, target_id, reviewer_user_id,
                           rating, body, status, moderation_status,
                           reply_due_at, created_at, updated_at)
      VALUES ('rev_override', @tenantId, 'order', 'o_5', @uid, 4, 'b', 'submitted', 'clean',
              @past, @now, @now)
    `).run({ tenantId: ids.tenantId, uid: ids.adminUserId, past: now - 86400, now });

    const r = await invoke('reviews:reply', 14, {
      reviewId:       'rev_override',
      body:           'approved by compliance',
      policyOverride: true,
      overrideReason: 'customer escalation #4512 — approved by ops lead',
    }) as { ok: boolean; withinSla: boolean; override: boolean };
    expect(r.ok).toBe(true);
    expect(r.withinSla).toBe(false);
    expect(r.override).toBe(true);

    const row = db.prepare(`
      SELECT payload FROM audit_events
       WHERE action = 'review.reply_late_override' AND entity_id = ?
    `).get('rev_override') as { payload: string } | undefined;
    expect(row).toBeTruthy();
    const parsed = JSON.parse(row!.payload) as { overrideReason: string };
    expect(parsed.overrideReason).toContain('customer escalation');
  });

  it('reply past 7 days WITH non-admin override → rejected with override_requires_admin', async () => {
    setSession(15, {
      userId: ids.opsUserId, tenantId: ids.tenantId,
      roles: ['OperationsManager'], loggedInAt: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO reviews (id, tenant_id, target_type, target_id, reviewer_user_id,
                           rating, body, status, moderation_status,
                           reply_due_at, created_at, updated_at)
      VALUES ('rev_bad_override', @tenantId, 'order', 'o_6', @uid, 4, 'b', 'submitted', 'clean',
              @past, @now, @now)
    `).run({ tenantId: ids.tenantId, uid: ids.opsUserId, past: now - 86400, now });

    const r = await invoke('reviews:reply', 15, {
      reviewId:       'rev_bad_override',
      body:           'trying to sneak a late reply',
      policyOverride: true,
      overrideReason: 'I am not an admin',
    }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('override_requires_admin');

    const denied = db.prepare(
      `SELECT 1 AS ok FROM audit_events WHERE action = 'review.reply_override_denied'`,
    ).get();
    expect(denied).toBeTruthy();
  });
});
