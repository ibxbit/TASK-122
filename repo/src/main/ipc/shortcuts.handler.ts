import { ipcMain } from 'electron';
import {
  loadShortcutConfig, saveShortcutConfig, setOverride, clearOverride,
  resetConfig, applyOverrides, ShortcutConfigError,
  type ShortcutConfig,
} from '../shortcuts/config';
import { DEFAULT_SHORTCUTS, buildAppMenu } from '../shortcuts/AppMenu';
import { appendAuditEvent } from '../audit/chain';
import { getDb } from '../db';
import { getSession } from '../session';
import { logger } from '../logger';

/* =========================================================================
 * Shortcuts IPC
 *
 *    shortcuts:list     → defaults + effective + overridden flag
 *    shortcuts:set      → set one override, re-validate, persist
 *    shortcuts:clear    → clear one override (revert to default)
 *    shortcuts:reset    → drop every override
 *
 *  All write paths re-apply the menu via `buildAppMenu` so a saved change
 *  becomes active immediately — the user never needs to restart.  They
 *  also chain-audit the change under the caller's tenant.
 * ========================================================================= */

export function registerShortcutsHandlers(): void {
  ipcMain.handle('shortcuts:list', async () => {
    const config   = await loadShortcutConfig();
    const effective = applyOverrides(DEFAULT_SHORTCUTS, config);
    return {
      defaults:  DEFAULT_SHORTCUTS.map((d) => ({ id: d.id, label: d.label, accelerator: d.accelerator, group: d.group })),
      effective: effective.map((e) => ({ id: e.id, label: e.label, accelerator: e.accelerator, group: e.group, overridden: e.overridden })),
    };
  });

  ipcMain.handle('shortcuts:set', async (event, payload: { id: string; accelerator: string }) => {
    try {
      const config = await loadShortcutConfig();
      const next   = setOverride(DEFAULT_SHORTCUTS, config, payload.id, payload.accelerator);
      await saveShortcutConfig(next);
      buildAppMenu(next);
      auditChange(event.sender.id, 'shortcuts.override_set', { id: payload.id, accelerator: payload.accelerator });
      return { ok: true };
    } catch (err) {
      if (err instanceof ShortcutConfigError) return { ok: false, error: err.message };
      logger.error({ err }, 'shortcuts_set_failed');
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  });

  ipcMain.handle('shortcuts:clear', async (event, payload: { id: string }) => {
    try {
      const config = await loadShortcutConfig();
      const next   = clearOverride(config, payload.id);
      await saveShortcutConfig(next);
      buildAppMenu(next);
      auditChange(event.sender.id, 'shortcuts.override_cleared', { id: payload.id });
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'shortcuts_clear_failed');
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  });

  ipcMain.handle('shortcuts:reset', async (event) => {
    try {
      const next = resetConfig();
      await saveShortcutConfig(next);
      buildAppMenu(next);
      auditChange(event.sender.id, 'shortcuts.reset', {});
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'shortcuts_reset_failed');
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  });
}

function auditChange(senderId: number, action: string, payload: Record<string, unknown>): void {
  const session = getSession(senderId);
  if (!session) return;   // un-audited change requires a session — fallthrough
  try {
    appendAuditEvent(getDb(), {
      tenantId:    session.tenantId,
      actorUserId: session.userId,
      action,
      entityType:  'shortcut_config',
      entityId:    null,
      payload,
    });
  } catch (err) {
    logger.warn({ err, action }, 'shortcuts_audit_append_failed');
  }
}

/** Test-only helper: set the current config (without invoking IPC) and
 *  rebuild the menu.  Not registered on ipcMain. */
export async function applyConfigNowForTests(cfg: ShortcutConfig): Promise<void> {
  await saveShortcutConfig(cfg);
  buildAppMenu(cfg);
}
