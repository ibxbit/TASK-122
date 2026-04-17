import { ImGuiContext } from './runtime';
import { InputLayer } from './input';
import { drawLoginView }    from './views/login';
import { drawDashboardView } from './views/dashboard';
import { drawContractsView } from './views/contracts';
import { drawAuditView }     from './views/audit';
import { drawReviewsView }   from './views/reviews';
import { drawRoutingView }   from './views/routing';
import { drawAdminView }     from './views/admin';
import { drawSettingsView }  from './views/settings';
import { drawSearchPalette } from './views/search-palette';

/* =========================================================================
 * ImGui App Host
 *
 *  Boots the immediate-mode UI: one frame loop, one draw callback, one
 *  input snapshot per tick.  The active view is selected by either
 *  (a) the session state (no session → login view) or
 *  (b) the ?window=<kind> query passed by the main-process WindowManager.
 *
 *  The C++ Dear ImGui idiom of Begin/End windows around each scope is
 *  preserved; each view draws exactly one window filling the canvas.
 * ========================================================================= */

export type WindowKind = 'dashboard' | 'contracts' | 'audit' | 'reviews' | 'routing' | 'admin' | 'settings';

export interface AppState {
  sessionUserId:   string | null;
  sessionTenantId: string | null;
  sessionRoles:    string[];
  kind:            WindowKind;
  statusMessage:   string;

  /** Search palette state — toggled by shortcut:search (Ctrl+K). */
  searchOpen:      boolean;
  searchQuery:     string;

  /** Set when the main process broadcasts shortcut:export (Ctrl+E).  The
   *  focused view reads + clears this flag inside its draw callback to
   *  trigger its export action.  Flag is more ergonomic in immediate-mode
   *  than a subscription — every view checks once per frame. */
  exportRequested: boolean;

  /** Checkpoint restore payload the renderer received from the main
   *  process on unclean-shutdown recovery.  Views read this during their
   *  first frame after mount to rehydrate local state.  Cleared after
   *  consumption. */
  restoredUi:      Record<string, unknown> | null;
  restoredUnsaved: Record<string, unknown> | null;
}

export interface IpcBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (...args: unknown[]) => void): () => void;
  send(channel: string, payload?: unknown): void;
  kind?: WindowKind;
}

export function bootImGuiApp(
  canvas: HTMLCanvasElement,
  bridge: IpcBridge,
  initialKind: WindowKind = 'dashboard',
): { stop: () => void; state: AppState; ctx: ImGuiContext } {
  const ctx   = new ImGuiContext();
  ctx.attach(canvas);

  const input = new InputLayer();
  const detachInput = input.attach(canvas);

  const state: AppState = {
    sessionUserId:   null,
    sessionTenantId: null,
    sessionRoles:    [],
    kind:            initialKind,
    statusMessage:   '',
    searchOpen:      false,
    searchQuery:     '',
    exportRequested: false,
    restoredUi:      null,
    restoredUnsaved: null,
  };

  // ── Shortcut wiring: the main process broadcasts `shortcut:search` and
  //    `shortcut:export` when the menu accelerator fires.  We turn those
  //    into state transitions that the frame loop observes.
  const offSearch = bridge.on('shortcut:search', () => {
    state.searchOpen = true;
  });
  const offExport = bridge.on('shortcut:export', () => {
    state.exportRequested = true;
  });

  // ── Checkpoint restore: the main process sends `checkpoint:restore`
  //    after a dirty-shutdown recovery.  The payload is the saved
  //    per-window ui+unsaved bucket; views consume `state.restoredUi` /
  //    `state.restoredUnsaved` on their first draw.
  const offRestore = bridge.on('checkpoint:restore', (payload: unknown) => {
    const p = payload as { ui?: Record<string, unknown>; unsaved?: Record<string, unknown> };
    if (p && typeof p === 'object') {
      state.restoredUi      = p.ui      ?? {};
      state.restoredUnsaved = p.unsaved ?? {};
    }
  });

  // Seed session state from main-process on boot
  void (async () => {
    try {
      const s = await bridge.invoke('session:status') as {
        userId: string; tenantId: string; roles: string[];
      } | null;
      if (s) {
        state.sessionUserId   = s.userId;
        state.sessionTenantId = s.tenantId;
        state.sessionRoles    = s.roles;
      }
    } catch { /* offline / no session yet */ }
  })();

  const onResize = () => ctx.resize();
  window.addEventListener('resize', onResize);

  // ── Checkpoint provider: debounce ui state into a single push per 500ms
  //    so the main-process checkpointer has something to persist even if
  //    the 60s timer fires between UI changes.  The shape mirrors the main
  //    process' RendererProvidedState contract.
  const CHECKPOINT_DEBOUNCE_MS = 500;
  let lastCheckpointAt = 0;
  function maybePushCheckpoint(): void {
    const now = Date.now();
    if (now - lastCheckpointAt < CHECKPOINT_DEBOUNCE_MS) return;
    lastCheckpointAt = now;
    try {
      bridge.send('checkpoint:provide', {
        kind:  state.kind,
        state: {
          ui: {
            kind:          state.kind,
            searchQuery:   state.searchQuery,
            searchOpen:    state.searchOpen,
            statusMessage: state.statusMessage,
          },
          unsaved: {},
        },
      });
    } catch { /* bridge may be unavailable in tests */ }
  }

  let running = true;
  let rafId   = 0;

  const frame = () => {
    if (!running) return;
    const snap = input.snapshot();
    ctx.beginFrame(snap);

    if (!state.sessionUserId) {
      drawLoginView(ctx, state, bridge);
    } else {
      switch (state.kind) {
        case 'dashboard': drawDashboardView(ctx, state, bridge); break;
        case 'contracts': drawContractsView(ctx, state, bridge); break;
        case 'audit':     drawAuditView    (ctx, state, bridge); break;
        case 'reviews':   drawReviewsView  (ctx, state, bridge); break;
        case 'routing':   drawRoutingView  (ctx, state, bridge); break;
        case 'admin':     drawAdminView    (ctx, state, bridge); break;
        case 'settings':  drawSettingsView (ctx, state, bridge); break;
      }
      // Search palette overlays on top of any signed-in view.
      drawSearchPalette(ctx, state, bridge);
    }

    ctx.endFrame();
    maybePushCheckpoint();
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);

  return {
    stop: () => {
      running = false;
      cancelAnimationFrame(rafId);
      detachInput();
      window.removeEventListener('resize', onResize);
      offSearch();
      offExport();
      offRestore();
    },
    state,
    ctx,
  };
}
