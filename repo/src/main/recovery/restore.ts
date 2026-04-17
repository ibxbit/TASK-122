import { app, dialog, screen, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { logger } from '../logger';
import {
  CheckpointPaths,
  CHECKPOINT_VERSION,
  type SessionSnapshot,
  type WindowSnapshot,
  type WindowBounds,
} from './checkpoint';

/* =========================================================================
 * Restore Logic
 *
 *   detectDirtyShutdown()   → read dirty.flag + session.json (fallback prev)
 *   promptRestore(session)  → blocking dialog, user picks Restore / Fresh
 *   applySession(session)   → re-open windows, dispatch 'checkpoint:restore'
 *                              IPC event to each renderer with ui + unsaved
 *   clearSession()          → drop snapshots + dirty flag
 *
 *  Decision tree (call from main bootstrap):
 *    const dirty = await detectDirtyShutdown();
 *    if (dirty && await promptRestore(dirty.session))  await applySession(...);
 *    else                                              await clearSession();
 * ========================================================================= */

export interface DirtyShutdown {
  session:      SessionSnapshot;
  source:       'current' | 'prev';
  hadDirtyFlag: boolean;
}

export async function detectDirtyShutdown(): Promise<DirtyShutdown | null> {
  const hadDirtyFlag = await exists(CheckpointPaths.dirty());
  if (!hadDirtyFlag) return null;                    // clean shutdown

  const current = await readJsonSafe<SessionSnapshot>(CheckpointPaths.session());
  const prev    = current ? null : await readJsonSafe<SessionSnapshot>(CheckpointPaths.prev());

  const session = pickValid(current) ?? pickValid(prev);
  if (!session) {
    logger.warn({ hadDirtyFlag }, 'checkpoint_no_valid_snapshot');
    return null;
  }

  return {
    session,
    source:       current && pickValid(current) ? 'current' : 'prev',
    hadDirtyFlag,
  };
}

export async function promptRestore(session: SessionSnapshot): Promise<boolean> {
  const savedAt     = new Date(session.savedAt * 1000).toLocaleString();
  const windowCount = session.windows.length;

  const { response } = await dialog.showMessageBox({
    type:      'question',
    buttons:   ['Restore Session', 'Start Fresh'],
    defaultId: 0,
    cancelId:  1,
    noLink:    true,
    title:     'LeaseHub — Unclean Shutdown Detected',
    message:   'LeaseHub didn\'t close properly last time.',
    detail:
      `Checkpoint from ${savedAt}\n` +
      `${windowCount} window${windowCount === 1 ? '' : 's'} to restore, ` +
      `including unsaved data and UI state.\n\n` +
      `Restore now?`,
  });
  return response === 0;
}

/* ------------------------------------------------------------------ *
 *  Application — the caller injects openWindow so this module does   *
 *  not depend on WindowManager.                                       *
 * ------------------------------------------------------------------ */

export interface RestoreDeps {
  /** Open (or focus) the window of a given kind with the supplied bounds/maximized. */
  openWindow: (kind: string, init: { bounds: WindowBounds; maximized: boolean }) => BrowserWindow;
}

export async function applySession(session: SessionSnapshot, deps: RestoreDeps): Promise<void> {
  // Open non-focused windows first so the focused one ends up on top.
  const ordered = [...session.windows].sort((a, b) => Number(a.focused) - Number(b.focused));

  for (const w of ordered) {
    const bounds = clampToDisplays(w.bounds);
    let win: BrowserWindow;
    try {
      win = deps.openWindow(w.kind, { bounds, maximized: w.maximized });
    } catch (err) {
      logger.error({ err, kind: w.kind }, 'checkpoint_open_window_failed');
      continue;
    }

    const send = () => {
      try {
        win.webContents.send('checkpoint:restore', {
          kind:    w.kind,
          ui:      w.ui,
          unsaved: w.unsaved,
          savedAt: session.savedAt,
        });
      } catch (err) {
        logger.error({ err, kind: w.kind }, 'checkpoint_restore_send_failed');
      }
    };

    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', send);
    } else {
      send();
    }
  }

  logger.info(
    { windows: session.windows.length, savedAt: session.savedAt },
    'session_restored',
  );
}

export async function clearSession(): Promise<void> {
  const paths = [CheckpointPaths.session(), CheckpointPaths.prev(), CheckpointPaths.dirty()];
  for (const p of paths) {
    try { await fs.unlink(p); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
  logger.info('session_cleared');
}

/* ------------------------------------------------------------------ *
 *  Helpers                                                            *
 * ------------------------------------------------------------------ */

function pickValid(s: SessionSnapshot | null): SessionSnapshot | null {
  if (!s) return null;
  if (typeof s.version    !== 'number')  return null;
  if (s.version !== CHECKPOINT_VERSION)  return null;     // forward-compat gate
  if (typeof s.savedAt    !== 'number')  return null;
  if (typeof s.appVersion !== 'string')  return null;
  if (!Array.isArray(s.windows))         return null;
  for (const w of s.windows) if (!isValidWindowSnapshot(w)) return null;
  return s;
}

function isValidWindowSnapshot(w: unknown): w is WindowSnapshot {
  if (!w || typeof w !== 'object') return false;
  const x = w as Record<string, unknown>;
  if (typeof x.kind !== 'string') return false;
  const b = x.bounds as Record<string, unknown> | undefined;
  if (!b || typeof b.x !== 'number' || typeof b.y !== 'number'
        || typeof b.width !== 'number' || typeof b.height !== 'number') return false;
  if (typeof x.maximized !== 'boolean') return false;
  return true;
}

/** Keep the window fully visible — a detached monitor can leave bounds off-screen. */
function clampToDisplays(bounds: WindowBounds): WindowBounds {
  try {
    const displays = screen.getAllDisplays();
    for (const d of displays) {
      const db = d.bounds;
      const fits =
        bounds.x >= db.x && bounds.y >= db.y &&
        bounds.x + bounds.width  <= db.x + db.width &&
        bounds.y + bounds.height <= db.y + db.height;
      if (fits) return bounds;
    }
    // No display contains the full rect — re-centre on primary work area.
    const wa     = screen.getPrimaryDisplay().workArea;
    const width  = Math.min(bounds.width,  wa.width);
    const height = Math.min(bounds.height, wa.height);
    return {
      x:      wa.x + Math.max(0, Math.floor((wa.width  - width)  / 2)),
      y:      wa.y + Math.max(0, Math.floor((wa.height - height) / 2)),
      width,
      height,
    };
  } catch {
    return bounds;                                // screen not ready — trust snapshot
  }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readJsonSafe<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logger.warn({ err, path: p }, 'checkpoint_read_failed');
    return null;
  }
}

/* ------------------------------------------------------------------ *
 *  Unused-import guard — keep `app` referenced so TS tree-shaker      *
 *  doesn't warn when the module is consumed via bundler.              *
 * ------------------------------------------------------------------ */
void app;
