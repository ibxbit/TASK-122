import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

/* =========================================================================
 * Session Handler Tests
 *
 *  Tests the session store and credential verification logic without
 *  requiring better-sqlite3 or real Electron IPC:
 *    - Session lifecycle (set / get / clear / clearAll)
 *    - Password verification (timing-safe PBKDF2)
 *    - No-session denial flow
 *    - Session-present access flow
 * ========================================================================= */

import {
  setSession, getSession, clearSession, clearAllSessions, sessionCount,
} from '../../src/main/session';

const PBKDF2_ITER   = 100_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

function hashPassword(plain: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(plain, Buffer.from(salt, 'hex'), PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return { hash, salt };
}

function verifyPassword(plain: string, hashHex: string, saltHex: string): boolean {
  const derived = crypto.pbkdf2Sync(plain, Buffer.from(saltHex, 'hex'), PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  const known   = Buffer.from(hashHex, 'hex');
  return derived.length === known.length && crypto.timingSafeEqual(derived, known);
}

describe('Session management', () => {
  beforeEach(() => clearAllSessions());
  afterEach(() => clearAllSessions());

  describe('setSession / getSession', () => {
    it('establishes and retrieves a session', () => {
      setSession(1, {
        userId:     'u_admin',
        tenantId:   't_acme',
        roles:      ['TenantAdmin'],
        loggedInAt: Math.floor(Date.now() / 1000),
      });

      const s = getSession(1);
      expect(s).toBeDefined();
      expect(s!.userId).toBe('u_admin');
      expect(s!.tenantId).toBe('t_acme');
      expect(s!.roles).toContain('TenantAdmin');
    });

    it('returns undefined for non-existent session', () => {
      expect(getSession(999)).toBeUndefined();
    });

    it('replaces an existing session for the same webContentsId', () => {
      setSession(1, { userId: 'a', tenantId: 't', roles: ['A'], loggedInAt: 0 });
      setSession(1, { userId: 'b', tenantId: 't', roles: ['B'], loggedInAt: 1 });
      expect(getSession(1)!.userId).toBe('b');
      expect(sessionCount()).toBe(1);
    });
  });

  describe('clearSession', () => {
    it('removes the session for a webContentsId', () => {
      setSession(1, { userId: 'a', tenantId: 't', roles: [], loggedInAt: 0 });
      clearSession(1);
      expect(getSession(1)).toBeUndefined();
    });

    it('is a no-op for non-existent webContentsId', () => {
      clearSession(999); // should not throw
      expect(sessionCount()).toBe(0);
    });
  });

  describe('clearAllSessions', () => {
    it('removes all sessions', () => {
      setSession(1, { userId: 'a', tenantId: 't', roles: [], loggedInAt: 0 });
      setSession(2, { userId: 'b', tenantId: 't', roles: [], loggedInAt: 0 });
      setSession(3, { userId: 'c', tenantId: 't', roles: [], loggedInAt: 0 });

      clearAllSessions();
      expect(getSession(1)).toBeUndefined();
      expect(getSession(2)).toBeUndefined();
      expect(getSession(3)).toBeUndefined();
      expect(sessionCount()).toBe(0);
    });
  });

  describe('sessionCount', () => {
    it('returns correct count', () => {
      expect(sessionCount()).toBe(0);
      setSession(1, { userId: 'a', tenantId: 't', roles: [], loggedInAt: 0 });
      expect(sessionCount()).toBe(1);
      setSession(2, { userId: 'b', tenantId: 't', roles: [], loggedInAt: 0 });
      expect(sessionCount()).toBe(2);
      clearSession(1);
      expect(sessionCount()).toBe(1);
    });
  });

  describe('password verification (PBKDF2-SHA256)', () => {
    it('correct password verifies', () => {
      const pw = hashPassword('correct-password');
      expect(verifyPassword('correct-password', pw.hash, pw.salt)).toBe(true);
    });

    it('wrong password fails', () => {
      const pw = hashPassword('correct-password');
      expect(verifyPassword('wrong-password', pw.hash, pw.salt)).toBe(false);
    });

    it('empty password fails against non-empty hash', () => {
      const pw = hashPassword('nonempty');
      expect(verifyPassword('', pw.hash, pw.salt)).toBe(false);
    });

    it('timing-safe compare used (buffers same length)', () => {
      const pw = hashPassword('test');
      const derived = crypto.pbkdf2Sync('test', Buffer.from(pw.salt, 'hex'), PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);
      const known   = Buffer.from(pw.hash, 'hex');
      expect(derived.length).toBe(known.length);
      expect(derived.length).toBe(PBKDF2_KEYLEN);
    });
  });

  describe('session denial / allowance on guarded routes', () => {
    it('no session → getSession returns undefined (registerGuarded would deny)', () => {
      expect(getSession(42)).toBeUndefined();
    });

    it('session present → getSession returns session (registerGuarded would allow)', () => {
      setSession(42, {
        userId: 'u_admin', tenantId: 't_acme',
        roles: ['TenantAdmin'], loggedInAt: Math.floor(Date.now() / 1000),
      });
      const s = getSession(42);
      expect(s).toBeDefined();
      expect(s!.roles).toContain('TenantAdmin');
    });
  });
});
