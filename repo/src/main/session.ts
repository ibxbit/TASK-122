/* =========================================================================
 * Session Store — in-memory session registry keyed by webContentsId.
 *
 *  A session is the result of a successful authentication; it binds a
 *  webContents (renderer) to a (userId, tenantId) pair plus the roles that
 *  were live at login.  The access evaluator uses these to enforce tenant
 *  isolation and RBAC; IPC handlers read the session via getSession().
 *
 *  The store is process-local and cleared on app quit — offline desktop
 *  doesn't need a cross-process session backend.
 * ========================================================================= */

export interface Session {
  userId:    string;
  tenantId:  string;
  roles:     string[];
  loggedInAt: number;             // unix seconds
}

const sessions = new Map<number, Session>();

/** Create or replace the session bound to a webContents. */
export function setSession(webContentsId: number, session: Session): void {
  sessions.set(webContentsId, session);
}

/** Retrieve the current session for a webContents (or undefined). */
export function getSession(webContentsId: number): Session | undefined {
  return sessions.get(webContentsId);
}

/** Remove the session — called on window close or logout. */
export function clearSession(webContentsId: number): void {
  sessions.delete(webContentsId);
}

/** Drop every session — called on app.before-quit. */
export function clearAllSessions(): void {
  sessions.clear();
}

/** Count active sessions — useful for diagnostics / IPC snapshots. */
export function sessionCount(): number {
  return sessions.size;
}
