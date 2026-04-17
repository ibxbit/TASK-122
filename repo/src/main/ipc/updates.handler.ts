import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app } from 'electron';
import { registerGuarded } from '../access/enforce';
import { getDb } from '../db';
import { importPackage } from '../updates/loader';
import {
  listInstalledVersions, rollbackTo, cancelPending, readRegistry,
} from '../updates/rollback';
import { appendAuditEvent } from '../audit/chain';

/* =========================================================================
 * Updates IPC Handlers — offline signed package import + admin rollback.
 *
 *   updates:registry    (read)   current registry state
 *   updates:versions    (read)   installed versions list
 *   updates:import      (write)  admin: verify + stage package from disk
 *   updates:rollback    (write)  admin: queue rollback to prior version
 *   updates:cancel      (write)  abandon pending install/rollback
 *
 *   Every write is guarded by `system.update` / `system.rollback` and
 *   produces a chain-linked audit event.
 * ========================================================================= */

interface ImportPayload   { packagePath: string; }
interface RollbackPayload { targetVersion: string; }

const PUBLIC_KEY_PATH = () =>
  path.join(process.resourcesPath ?? app.getAppPath(), 'public-key.pem');

export function registerUpdatesHandlers(): void {
  // ── updates:registry ─────────────────────────────────────────────────
  registerGuarded<Record<string, never>, unknown>(
    'updates:registry',
    { permission: 'system.update', type: 'api', action: 'read' },
    async () => readRegistry(),
  );

  // ── updates:versions ─────────────────────────────────────────────────
  registerGuarded<Record<string, never>, unknown[]>(
    'updates:versions',
    { permission: 'system.update', type: 'api', action: 'read' },
    async () => listInstalledVersions(),
  );

  // ── updates:import ───────────────────────────────────────────────────
  registerGuarded<ImportPayload, unknown>(
    'updates:import',
    { permission: 'system.update', type: 'api', action: 'write' },
    async (ctx, payload) => {
      // Canonicalize + load the bundled public key (no network, resources only)
      const packagePath  = path.resolve(payload.packagePath);
      const publicKeyPem = await fs.readFile(PUBLIC_KEY_PATH(), 'utf8');

      const result = await importPackage({
        packagePath,
        publicKeyPem,
        requestedBy: ctx.userId,
      });

      appendAuditEvent(getDb(), {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'system.update_imported',
        entityType:  'update_package',
        entityId:    result.installedVersion,
        payload: {
          fromVersion:  result.fromVersion,
          newVersion:   result.installedVersion,
          issuer:       result.manifest.issuer,
          sourcePath:   packagePath,
          durationMs:   result.durationMs,
        },
      });
      return result;
    },
  );

  // ── updates:rollback ─────────────────────────────────────────────────
  registerGuarded<RollbackPayload, unknown>(
    'updates:rollback',
    { permission: 'system.rollback', type: 'api', action: 'write' },
    async (ctx, payload) => {
      const result = await rollbackTo({
        targetVersion: payload.targetVersion,
        requestedBy:   ctx.userId,
      });

      appendAuditEvent(getDb(), {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'system.rollback_queued',
        entityType:  'update_package',
        entityId:    result.targetVersion,
        payload: {
          fromVersion: result.fromVersion,
          toVersion:   result.targetVersion,
        },
      });
      return result;
    },
  );

  // ── updates:cancel ───────────────────────────────────────────────────
  registerGuarded<Record<string, never>, unknown>(
    'updates:cancel',
    { permission: 'system.rollback', type: 'api', action: 'write' },
    async (ctx) => {
      await cancelPending();
      appendAuditEvent(getDb(), {
        tenantId:    ctx.tenantId,
        actorUserId: ctx.userId,
        action:      'system.pending_cancelled',
        entityType:  'update_package',
        entityId:    null,
      });
      return { ok: true };
    },
  );
}
