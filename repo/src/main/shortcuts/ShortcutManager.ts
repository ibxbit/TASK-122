import {
  BrowserWindow, globalShortcut, type MenuItemConstructorOptions,
} from 'electron';
import { logger } from '../logger';

/* =========================================================================
 * ShortcutManager — centralised, declarative shortcut registry.
 *
 *  Responsibilities:
 *    • Single place to declare every app-level shortcut (id, label, accel)
 *    • Handlers are either a renderer broadcast (most shortcuts) or an
 *      arbitrary main-process function (e.g. "open Audit Log window")
 *    • Dispatch via one of three paths:
 *         1. Electron menu accelerator  — default, fires in any window
 *         2. Electron globalShortcut    — opt-in, OS-wide (sparingly used)
 *         3. Programmatic dispatch()    — tests, context-menu items, IPC
 *
 *  Menu accelerators are the primary transport: they fire whenever any app
 *  window is focused, which covers the "must work across ALL windows"
 *  requirement without per-window listener plumbing.
 * ========================================================================= */

export type ShortcutGroup = 'file' | 'go' | 'view' | 'tools';

export type ShortcutHandler = (focused?: BrowserWindow) => void | Promise<void>;

export interface ShortcutDef {
  id:             string;         // stable identifier e.g. 'search' | 'export' | 'audit'
  label:          string;         // menu label
  accelerator:    string;         // e.g. 'Ctrl+K' · 'Ctrl+Shift+L'
  group:          ShortcutGroup;  // which submenu the item belongs to
  handler:        ShortcutHandler;
  visibleInMenu?: boolean;        // default true
}

class ShortcutManager {
  private readonly byId     = new Map<string, ShortcutDef>();
  private readonly globalIds = new Set<string>();

  /* ---------- Registration --------------------------------------- */

  register(def: ShortcutDef): void {
    if (this.byId.has(def.id)) {
      logger.warn({ id: def.id }, 'shortcut_already_registered');
      return;
    }
    this.byId.set(def.id, def);
  }

  registerAll(defs: ShortcutDef[]): void {
    for (const d of defs) this.register(d);
  }

  unregister(id: string): void {
    const sc = this.byId.get(id);
    if (!sc) return;
    if (this.globalIds.has(id)) {
      globalShortcut.unregister(sc.accelerator);
      this.globalIds.delete(id);
    }
    this.byId.delete(id);
  }

  get(id: string): ShortcutDef | undefined { return this.byId.get(id); }
  list(): ShortcutDef[] { return [...this.byId.values()]; }

  /* ---------- Dispatch ------------------------------------------- */

  /** Programmatic trigger — routes to the same handler as the menu accelerator. */
  async dispatch(id: string): Promise<void> {
    const sc = this.byId.get(id);
    if (!sc) { logger.warn({ id }, 'shortcut_not_found'); return; }
    try {
      await sc.handler(BrowserWindow.getFocusedWindow() ?? undefined);
    } catch (err) {
      logger.error({ err, id }, 'shortcut_dispatch_failed');
    }
  }

  /* ---------- Menu integration ----------------------------------- */

  /** Menu items for a group, ready to splice into an AppMenu submenu. */
  asMenuItems(group: ShortcutGroup): MenuItemConstructorOptions[] {
    return [...this.byId.values()]
      .filter((s) => s.group === group && s.visibleInMenu !== false)
      .map((s) => ({
        label:       s.label,
        accelerator: s.accelerator,
        click:       (_item, win) => {
          Promise.resolve(s.handler(win as BrowserWindow | undefined))
            .catch((err) => logger.error({ err, id: s.id }, 'shortcut_click_failed'));
        },
      }));
  }

  /* ---------- OS-wide registration (opt-in) ---------------------- */

  /**
   * Make a shortcut OS-wide via globalShortcut. Use sparingly — a globally
   * registered accelerator is stolen from every other application.  Most
   * shortcuts should stay as menu accelerators (focused-window-only).
   */
  registerGlobal(id: string): boolean {
    const sc = this.byId.get(id);
    if (!sc) return false;
    if (this.globalIds.has(id)) return true;
    const ok = globalShortcut.register(sc.accelerator, () => void this.dispatch(id));
    if (ok) this.globalIds.add(id);
    else    logger.warn({ id, accelerator: sc.accelerator }, 'global_shortcut_register_failed');
    return ok;
  }

  unregisterAllGlobal(): void {
    for (const id of this.globalIds) {
      const sc = this.byId.get(id);
      if (sc) globalShortcut.unregister(sc.accelerator);
    }
    this.globalIds.clear();
  }
}

export const shortcutManager = new ShortcutManager();

/* ------------------------------------------------------------------ *
 *  Common handler: broadcast a channel to the focused renderer.       *
 *  The vast majority of shortcuts use this pattern.                   *
 * ------------------------------------------------------------------ */

export function broadcastToFocused(channel: string, payload?: unknown): ShortcutHandler {
  return (focused) => {
    const target = focused ?? BrowserWindow.getFocusedWindow();
    if (!target || target.isDestroyed()) {
      logger.warn({ channel }, 'shortcut_no_focused_window');
      return;
    }
    target.webContents.send(channel, payload);
  };
}
