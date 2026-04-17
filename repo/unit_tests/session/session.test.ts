import { describe, expect, it } from 'vitest';
import {
  setSession, getSession, clearSession, clearAllSessions, sessionCount,
} from '../../src/main/session';

/* =========================================================================
 *  Session store — in-memory registry keyed by webContentsId.
 * ========================================================================= */

describe('session', () => {
  it('set / get round-trip', () => {
    clearAllSessions();
    setSession(10, { userId: 'u', tenantId: 't', roles: ['OperationsManager'], loggedInAt: 1 });
    expect(getSession(10)?.userId).toBe('u');
    expect(sessionCount()).toBe(1);
  });

  it('clearSession removes only the requested id', () => {
    clearAllSessions();
    setSession(1, { userId: 'a', tenantId: 't', roles: [], loggedInAt: 0 });
    setSession(2, { userId: 'b', tenantId: 't', roles: [], loggedInAt: 0 });
    clearSession(1);
    expect(getSession(1)).toBeUndefined();
    expect(getSession(2)?.userId).toBe('b');
  });

  it('clearAllSessions empties the registry', () => {
    setSession(1, { userId: 'a', tenantId: 't', roles: [], loggedInAt: 0 });
    clearAllSessions();
    expect(sessionCount()).toBe(0);
  });
});
