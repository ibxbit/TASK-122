import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

/* =========================================================================
 * session.handler — REAL production-path tests.
 *
 *  We capture the actual ipcMain.handle registrations emitted by
 *  registerSessionHandlers(), then drive each channel with synthetic
 *  IpcMainInvokeEvents backed by a real in-memory SQLite DB seeded by the
 *  shared helpers.  No replicated logic — the handler code itself runs.
 * ========================================================================= */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(ch, fn);
    },
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  app: {
    getPath:    () => '/tmp/test',
    getVersion: () => '1.0.0',
    getAppPath: () => '/tmp/test',
    whenReady:  () => Promise.resolve(),
  },
}));

import { makeTestDb, seedAccessGraph, type SeededIds } from '../_helpers/db';
import { initDbLifecycle } from '../../src/main/db/cleanup';
import { setSession, getSession, clearAllSessions } from '../../src/main/session';
import { registerSessionHandlers } from '../../src/main/ipc/session.handler';

const PBKDF2_ITER   = 100_000;
const PBKDF2_KEYLEN = 32;

function hashPw(plain: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(plain, Buffer.from(salt, 'hex'), PBKDF2_ITER, PBKDF2_KEYLEN, 'sha256').toString('hex');
  return { hash, salt };
}

function invoke(channel: string, senderId: number, payload: unknown): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no_handler_for:${channel}`);
  return fn({ sender: { id: senderId } }, payload);
}

describe('session.handler — real IPC registration path', () => {
  let db: ReturnType<typeof makeTestDb>;
  let ids: SeededIds;

  beforeEach(() => {
    db = makeTestDb();
    ids = seedAccessGraph(db);
    // Real lifecycle, so getDb() returns this db inside handlers.
    try { initDbLifecycle({ db }); } catch { /* already initialised by a prior test */ }

    // Provision a real password for the admin user.
    const pw = hashPw('correct-horse');
    db.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?, verified = 1
       WHERE id = ?
    `).run(pw.hash, pw.salt, ids.adminUserId);

    handlers.clear();
    clearAllSessions();
    registerSessionHandlers();
  });

  afterEach(() => {
    clearAllSessions();
    db.close();
    handlers.clear();
  });

  it('registers the full session surface', () => {
    expect(handlers.has('session:login')).toBe(true);
    expect(handlers.has('session:logout')).toBe(true);
    expect(handlers.has('session:reauth')).toBe(true);
    expect(handlers.has('session:status')).toBe(true);
  });

  it('session:login with valid creds establishes a session', async () => {
    const res = await invoke('session:login', 42, {
      username: 'admin', password: 'correct-horse', tenantId: ids.tenantId,
    }) as { success: boolean; userId?: string; roles?: string[] };
    expect(res.success).toBe(true);
    expect(res.userId).toBe(ids.adminUserId);
    expect(res.roles).toContain('TenantAdmin');

    const live = getSession(42);
    expect(live?.userId).toBe(ids.adminUserId);
    expect(live?.tenantId).toBe(ids.tenantId);
  });

  it('session:login rejects wrong password', async () => {
    const res = await invoke('session:login', 42, {
      username: 'admin', password: 'wrong-password', tenantId: ids.tenantId,
    }) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe('invalid_credentials');
    expect(getSession(42)).toBeUndefined();
  });

  it('session:login rejects unknown user', async () => {
    const res = await invoke('session:login', 42, {
      username: 'nobody', password: 'correct-horse', tenantId: ids.tenantId,
    }) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe('invalid_credentials');
  });

  it('session:login rejects disabled users', async () => {
    db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(ids.adminUserId);
    const res = await invoke('session:login', 42, {
      username: 'admin', password: 'correct-horse', tenantId: ids.tenantId,
    }) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe('user_disabled');
  });

  it('session:login rejects users with no password', async () => {
    db.prepare(`UPDATE users SET password_hash = NULL, password_salt = NULL WHERE id = ?`).run(ids.opsUserId);
    const res = await invoke('session:login', 43, {
      username: 'ops', password: 'any', tenantId: ids.tenantId,
    }) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe('no_password_set');
  });

  it('session:login rejects missing fields', async () => {
    const res = await invoke('session:login', 44, {
      username: '', password: '', tenantId: '',
    }) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe('missing_credentials');
  });

  it('session:logout clears the session for the calling sender', async () => {
    setSession(42, { userId: ids.adminUserId, tenantId: ids.tenantId, roles: ['TenantAdmin'], loggedInAt: 0 });
    const res = await invoke('session:logout', 42, {}) as { success: boolean };
    expect(res.success).toBe(true);
    expect(getSession(42)).toBeUndefined();
  });

  it('session:reauth validates password against the session owner', async () => {
    setSession(42, { userId: ids.adminUserId, tenantId: ids.tenantId, roles: ['TenantAdmin'], loggedInAt: 0 });
    const ok = await invoke('session:reauth', 42, { password: 'correct-horse' }) as { valid: boolean };
    expect(ok.valid).toBe(true);

    const bad = await invoke('session:reauth', 42, { password: 'wrong' }) as { valid: boolean };
    expect(bad.valid).toBe(false);
  });

  it('session:reauth rejects when no session exists', async () => {
    const res = await invoke('session:reauth', 999, { password: 'anything' }) as { valid: boolean };
    expect(res.valid).toBe(false);
  });

  it('session:status returns session info or null', async () => {
    expect(await invoke('session:status', 100, {})).toBeNull();
    setSession(101, { userId: ids.opsUserId, tenantId: ids.tenantId, roles: ['OperationsManager'], loggedInAt: 12345 });
    const s = await invoke('session:status', 101, {}) as { userId: string; roles: string[] };
    expect(s.userId).toBe(ids.opsUserId);
    expect(s.roles).toContain('OperationsManager');
  });
});
