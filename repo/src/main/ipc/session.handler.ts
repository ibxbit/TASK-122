import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import crypto from 'node:crypto';
import { getDb } from '../db';
import { setSession, getSession, clearSession } from '../session';
import { logger } from '../logger';

/* =========================================================================
 * Session IPC Handlers — login / logout / re-auth / status
 *
 *  session:login   → verify credentials, establish session
 *  session:logout  → clear session for calling renderer
 *  session:reauth  → re-verify password for sensitive operations
 *  session:status  → return current session info (or null)
 *
 *  All sessions are bound to a webContentsId so each BrowserWindow has
 *  an independent session lifecycle.  The session store is in-memory
 *  (no cross-process backend needed for offline desktop).
 * ========================================================================= */

const PBKDF2_ITER   = 100_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

interface LoginPayload {
  username: string;
  password: string;
  tenantId: string;
}

interface ReauthPayload {
  password: string;
}

interface LoginResult {
  success: boolean;
  userId?: string;
  roles?: string[];
  error?: string;
}

export function registerSessionHandlers(): void {
  // ── session:login ─────────────────────────────────────────────────────
  ipcMain.handle('session:login', async (event: IpcMainInvokeEvent, payload: LoginPayload): Promise<LoginResult> => {
    const db = getDb();

    if (!payload.username || !payload.password || !payload.tenantId) {
      return { success: false, error: 'missing_credentials' };
    }

    // Look up user by tenant + username
    const user = db.prepare(`
      SELECT id, tenant_id, username, status, password_hash, password_salt
        FROM users
       WHERE tenant_id = @tenantId AND username = @username
    `).get({ tenantId: payload.tenantId, username: payload.username }) as {
      id: string; tenant_id: string; username: string; status: string;
      password_hash: string | null; password_salt: string | null;
    } | undefined;

    if (!user) {
      logger.warn({ username: payload.username, tenantId: payload.tenantId }, 'login_user_not_found');
      return { success: false, error: 'invalid_credentials' };
    }

    if (user.status !== 'active') {
      logger.warn({ userId: user.id }, 'login_user_disabled');
      return { success: false, error: 'user_disabled' };
    }

    if (!user.password_hash || !user.password_salt) {
      logger.warn({ userId: user.id }, 'login_no_password_set');
      return { success: false, error: 'no_password_set' };
    }

    // Verify password (timing-safe)
    if (!verifyPassword(payload.password, user.password_hash, user.password_salt)) {
      logger.warn({ userId: user.id }, 'login_password_invalid');
      return { success: false, error: 'invalid_credentials' };
    }

    // Fetch roles
    const roleRows = db.prepare(`
      SELECT r.code
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = @userId AND ur.tenant_id = @tenantId
    `).all({ userId: user.id, tenantId: payload.tenantId }) as Array<{ code: string }>;

    const roles = roleRows.map((r) => r.code);

    // Establish session
    setSession(event.sender.id, {
      userId:     user.id,
      tenantId:   payload.tenantId,
      roles,
      loggedInAt: Math.floor(Date.now() / 1000),
    });

    logger.info({ userId: user.id, tenantId: payload.tenantId, roles }, 'session_established');
    return { success: true, userId: user.id, roles };
  });

  // ── session:logout ────────────────────────────────────────────────────
  ipcMain.handle('session:logout', (event: IpcMainInvokeEvent): { success: boolean } => {
    const session = getSession(event.sender.id);
    if (session) {
      logger.info({ userId: session.userId }, 'session_logout');
    }
    clearSession(event.sender.id);
    return { success: true };
  });

  // ── session:reauth ────────────────────────────────────────────────────
  ipcMain.handle('session:reauth', (event: IpcMainInvokeEvent, payload: ReauthPayload): { valid: boolean } => {
    const session = getSession(event.sender.id);
    if (!session) return { valid: false };

    const db = getDb();
    const user = db.prepare(`
      SELECT password_hash, password_salt FROM users WHERE id = ?
    `).get(session.userId) as { password_hash: string | null; password_salt: string | null } | undefined;

    if (!user?.password_hash || !user?.password_salt) return { valid: false };

    return { valid: verifyPassword(payload.password, user.password_hash, user.password_salt) };
  });

  // ── session:status ────────────────────────────────────────────────────
  ipcMain.handle('session:status', (event: IpcMainInvokeEvent) => {
    const session = getSession(event.sender.id);
    if (!session) return null;
    return {
      userId:     session.userId,
      tenantId:   session.tenantId,
      roles:      session.roles,
      loggedInAt: session.loggedInAt,
    };
  });
}

/* ------------------------------------------------------------------ */

function verifyPassword(plain: string, hashHex: string, saltHex: string): boolean {
  const derived = crypto.pbkdf2Sync(plain, Buffer.from(saltHex, 'hex'), PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  const known   = Buffer.from(hashHex, 'hex');
  return derived.length === known.length && crypto.timingSafeEqual(derived, known);
}
