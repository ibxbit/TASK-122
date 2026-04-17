import { app, ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

/* =========================================================================
 * Checkpoint System — 60-second session snapshots + dirty-shutdown flag.
 *
 *  Persists to `userData/checkpoints/`:
 *    session.json         — current snapshot
 *    session.prev.json    — prior snapshot (fallback if current is torn)
 *    dirty.flag           — present while the app runs; removed on clean quit
 *
 *  Renderer state (UI + unsaved data) flows in via IPC channel
 *  'checkpoint:provide' and lives in an in-memory buffer.  The main-process
 *  timer combines buffered state with window-bounds from the WindowManager
 *  and writes the snapshot atomically (write → fsync → rotate → rename).
 * ========================================================================= */

export const CHECKPOINT_VERSION     = 1;
export const CHECKPOINT_INTERVAL_MS = 60_000;

export interface RendererProvidedState {
  ui?:      Record<string, unknown>;
  unsaved?: Record<string, unknown>;
}

export interface WindowBounds { x: number; y: number; width: number; height: number; }

export interface WindowSnapshot {
  kind:      string;
  bounds:    WindowBounds;
  maximized: boolean;
  focused:   boolean;
  ui:        Record<string, unknown>;
  unsaved:   Record<string, unknown>;
}

export interface SessionSnapshot {
  version:    number;
  savedAt:    number;                    // unix seconds
  appVersion: string;
  windows:    WindowSnapshot[];
}

/* ------------------------------------------------------------------ *
 *  Paths — exported so restore.ts can read the same files.           *
 * ------------------------------------------------------------------ */

export const CheckpointPaths = {
  dir:      () => path.join(app.getPath('userData'), 'checkpoints'),
  session:  () => path.join(CheckpointPaths.dir(), 'session.json'),
  prev:     () => path.join(CheckpointPaths.dir(), 'session.prev.json'),
  tmp:      () => path.join(CheckpointPaths.dir(), 'session.tmp.json'),
  dirty:    () => path.join(CheckpointPaths.dir(), 'dirty.flag'),
} as const;

/* ------------------------------------------------------------------ *
 *  Dependencies — injected so this module doesn't import WindowManager
 *  (keeps cycle-free + makes the timer trivially unit-testable).      *
 * ------------------------------------------------------------------ */

export interface CheckpointDeps {
  /** Live list of windows to snapshot. */
  openWindows: () => BrowserWindow[];
  /** Map a BrowserWindow to its kind label ('dashboard' / 'contracts' / 'audit'). */
  kindOf:      (win: BrowserWindow) => string | null;
}

/* ------------------------------------------------------------------ */

export class CheckpointManager {
  private timer:   NodeJS.Timeout | null = null;
  private writing = false;

  /** Latest state pushed by each window's renderer, keyed by window kind. */
  private readonly buffer = new Map<string, RendererProvidedState>();

  private readonly ipcTeardown: Array<() => void> = [];

  constructor(private readonly deps: CheckpointDeps) {}

  async start(): Promise<void> {
    await fs.mkdir(CheckpointPaths.dir(), { recursive: true });
    await this.writeDirtyFlag();
    this.registerIpc();

    this.timer = setInterval(() => { void this.checkpoint(); }, CHECKPOINT_INTERVAL_MS);
    this.timer.unref();
    logger.info({ intervalMs: CHECKPOINT_INTERVAL_MS }, 'checkpoint_started');
  }

  /**
   * Stop the loop.
   *   graceful=true  → final checkpoint + remove dirty flag (clean shutdown)
   *   graceful=false → leave dirty flag; next launch will detect crash
   */
  async stop(opts: { graceful: boolean }): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const off of this.ipcTeardown) off();
    this.ipcTeardown.length = 0;

    if (opts.graceful) {
      await this.checkpoint();
      await this.clearDirtyFlag();
      logger.info('checkpoint_stopped_clean');
    } else {
      logger.warn('checkpoint_stopped_unclean');
    }
  }

  /** Force a snapshot outside the timer (e.g. on window-close). */
  async checkpointNow(): Promise<void> { await this.checkpoint(); }

  /* ---------- Core loop ------------------------------------------ */

  private async checkpoint(): Promise<void> {
    if (this.writing) return;           // coalesce: never overlap writes
    this.writing = true;
    try {
      const wins = this.deps.openWindows();
      const windows: WindowSnapshot[] = [];
      for (const w of wins) {
        if (w.isDestroyed()) continue;
        const kind = this.deps.kindOf(w);
        if (!kind) continue;
        const buf = this.buffer.get(kind) ?? {};
        windows.push({
          kind,
          bounds:    w.getBounds(),
          maximized: w.isMaximized(),
          focused:   w.isFocused(),
          ui:        buf.ui      ?? {},
          unsaved:   buf.unsaved ?? {},
        });
      }

      const snapshot: SessionSnapshot = {
        version:    CHECKPOINT_VERSION,
        savedAt:    Math.floor(Date.now() / 1000),
        appVersion: app.getVersion(),
        windows,
      };
      await this.writeAtomic(snapshot);
    } catch (err) {
      logger.error({ err }, 'checkpoint_write_failed');
    } finally {
      this.writing = false;
    }
  }

  /* ---------- Atomic writer -------------------------------------- */

  private async writeAtomic(snapshot: SessionSnapshot): Promise<void> {
    const tmp = CheckpointPaths.tmp();
    const cur = CheckpointPaths.session();
    const prv = CheckpointPaths.prev();

    const body = JSON.stringify(snapshot);
    const fh   = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(body, 'utf8');
      await fh.sync();                  // fsync — survive OS-level crashes
    } finally {
      await fh.close();
    }

    // Rotate current → prev (ENOENT is fine on first run).
    try { await fs.rename(cur, prv); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }

    await fs.rename(tmp, cur);          // atomic on POSIX + Windows NTFS
  }

  /* ---------- Dirty flag ----------------------------------------- */

  private async writeDirtyFlag(): Promise<void> {
    const body = JSON.stringify({
      pid:        process.pid,
      startedAt:  Math.floor(Date.now() / 1000),
      appVersion: app.getVersion(),
    });
    await fs.writeFile(CheckpointPaths.dirty(), body, 'utf8');
  }

  private async clearDirtyFlag(): Promise<void> {
    try { await fs.unlink(CheckpointPaths.dirty()); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }

  /* ---------- IPC bridge ----------------------------------------- */

  /**
   * Renderer contract:
   *   window.leasehub.send('checkpoint:provide', { kind, state: { ui, unsaved } })
   * Renderers should push on relevant change (debounced ~500ms) so the
   * worst-case data loss is bounded by the debounce window, not the 60 s timer.
   */
  private registerIpc(): void {
    const handler = (_e: IpcMainEvent, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const p = payload as { kind?: unknown; state?: unknown };
      if (typeof p.kind !== 'string') return;
      const state = (p.state && typeof p.state === 'object' ? p.state : {}) as RendererProvidedState;
      this.buffer.set(p.kind, {
        ui:      state.ui      && typeof state.ui      === 'object' ? state.ui      : {},
        unsaved: state.unsaved && typeof state.unsaved === 'object' ? state.unsaved : {},
      });
    };
    ipcMain.on('checkpoint:provide', handler);
    this.ipcTeardown.push(() => ipcMain.removeListener('checkpoint:provide', handler));
  }
}
