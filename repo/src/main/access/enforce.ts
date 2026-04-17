import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getDb } from '../db';
import { getSession } from '../session';
import { logger } from '../logger';
import {
  evaluate,
  type PermissionType,
  type Action,
  type ScopeFilter,
} from './evaluator';

/* =========================================================================
 * IPC Enforcement Service
 *  - registerGuarded() wraps an IPC handler with permission+ABAC enforcement
 *  - registerCanProbe() exposes access:can for UI gating (useCan)
 * ========================================================================= */

export interface GuardOptions {
  permission: string;
  type: PermissionType;
  action?: Action;              // default 'read'
}

export interface HandlerContext {
  userId: string;
  tenantId: string;
  scope: ScopeFilter;           // pass into data layer for ABAC filtering
  roles: string[];
}

export type GuardedHandler<TPayload, TResult> =
  (ctx: HandlerContext, payload: TPayload, event: IpcMainInvokeEvent) => Promise<TResult> | TResult;

export class AccessDeniedError extends Error {
  constructor(public readonly reason: string, public readonly channel: string) {
    super(`access_denied:${reason}`);
    this.name = 'AccessDeniedError';
  }
}

export function registerGuarded<TPayload, TResult>(
  channel: string,
  opts: GuardOptions,
  handler: GuardedHandler<TPayload, TResult>,
): void {
  ipcMain.handle(channel, async (event, payload: TPayload) => {
    const session = getSession(event.sender.id);
    if (!session) throw new AccessDeniedError('no_session', channel);

    const result = evaluate(getDb(), {
      userId: session.userId,
      tenantId: session.tenantId,
      permissionCode: opts.permission,
      type: opts.type,
      action: opts.action ?? 'read',
    });

    if (!result.allowed) {
      logger.warn(
        { channel, userId: session.userId, tenantId: session.tenantId, reason: result.reason },
        'access_denied',
      );
      throw new AccessDeniedError(result.reason, channel);
    }

    return handler(
      {
        userId: session.userId,
        tenantId: session.tenantId,
        scope: result.scope,
        roles: result.roles,
      },
      payload,
      event,
    );
  });
}

/** UI-side probe.  Never executes a handler — only reports allow/deny. */
export function registerCanProbe(): void {
  ipcMain.handle('access:can', (event, opts: GuardOptions) => {
    const session = getSession(event.sender.id);
    if (!session) return { allowed: false, reason: 'no_session' };
    const r = evaluate(getDb(), {
      userId: session.userId,
      tenantId: session.tenantId,
      permissionCode: opts.permission,
      type: opts.type,
      action: opts.action ?? 'read',
    });
    return { allowed: r.allowed, reason: r.reason };
  });
}
