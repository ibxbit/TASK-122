import { type ImGuiContext, type Rect } from '../runtime';
import {
  beginWindow, endWindow, heading, text, textDim, separator, spacing,
  button, sameLine, beginTable, tableRow, endTable, banner, menuBar,
  inputText, type InputTextRef,
} from '../widgets';
import type { AppState, IpcBridge } from '../app';

/* =========================================================================
 * Settings — Keyboard Shortcuts
 *
 *  Surfaces the current effective shortcut set and lets the user rebind
 *  any entry.  All changes round-trip through the main-process
 *  shortcuts:{list,set,clear,reset} IPC so validation + persistence +
 *  menu rebuild happen in one place.
 * ========================================================================= */

interface Row {
  id:          string;
  label:       string;
  accelerator: string;
  group:       string;
  overridden:  boolean;
}

interface Bucket {
  rows:       Row[];
  defaultsById: Record<string, string>;
  draft:      Record<string, InputTextRef>;
  loading:    boolean; loaded: boolean; error: string | null;
  actionMsg:  { text: string; tone: 'ok' | 'warn' | 'fail' } | null;
}

const BUCKET = new WeakMap<AppState, Bucket>();
function bucket(s: AppState): Bucket {
  let b = BUCKET.get(s);
  if (!b) {
    b = {
      rows: [], defaultsById: {}, draft: {},
      loading: false, loaded: false, error: null, actionMsg: null,
    };
    BUCKET.set(s, b);
  }
  return b;
}

async function reload(b: Bucket, bridge: IpcBridge): Promise<void> {
  b.loading = true; b.error = null;
  try {
    const raw = await bridge.invoke('shortcuts:list') as {
      defaults:  Array<{ id: string; accelerator: string }>;
      effective: Row[];
    };
    b.rows = raw.effective;
    b.defaultsById = Object.fromEntries(raw.defaults.map((d) => [d.id, d.accelerator]));
    for (const r of b.rows) {
      if (!b.draft[r.id]) b.draft[r.id] = { value: r.accelerator };
      else b.draft[r.id].value = r.accelerator;
    }
    b.loaded = true;
  } catch (err) {
    b.error = String((err as Error)?.message ?? err);
  } finally {
    b.loading = false;
  }
}

export function drawSettingsView(
  ctx: ImGuiContext, state: AppState, bridge: IpcBridge,
): void {
  const b = bucket(state);
  if (!b.loaded && !b.loading) void reload(b, bridge);

  menuBar(ctx, { x: 0, y: 0, w: ctx.width, h: 24 }, [
    { label: 'Dashboard', onClick: () => { state.kind = 'dashboard'; } },
    { label: 'Contracts', onClick: () => { state.kind = 'contracts'; } },
    { label: 'Audit',     onClick: () => { state.kind = 'audit';     } },
    { label: 'Reviews',   onClick: () => { state.kind = 'reviews';   } },
    { label: 'Routing',   onClick: () => { state.kind = 'routing';   } },
    { label: 'Admin',     onClick: () => { state.kind = 'admin';     } },
    { label: 'Settings',  onClick: () => { state.kind = 'settings';  } },
  ]);

  const rect: Rect = { x: 0, y: 24, w: ctx.width, h: ctx.height - 24 };
  beginWindow(ctx, 'Settings — Keyboard Shortcuts', rect);

  if (b.actionMsg) banner(ctx, b.actionMsg.text, b.actionMsg.tone);
  if (b.error)     text(ctx, `Failed: ${b.error}`, ctx.theme.Fail);
  if (b.loading)   textDim(ctx, 'Loading…');

  heading(ctx, `Shortcuts — ${b.rows.length}`);
  textDim(ctx, 'Edit the accelerator and press Save. Conflicts are rejected with a clear error.');

  const tbl = beginTable(ctx, 'shortcuts-list', [
    { key: 'id',       header: 'Id',        width: 120 },
    { key: 'label',    header: 'Action',    width: 220 },
    { key: 'group',    header: 'Group',     width: 90 },
    { key: 'acc',      header: 'Accel',     width: 180 },
    { key: 'default',  header: 'Default',   width: 140 },
    { key: 'mark',     header: 'Status',    width: 120 },
  ]);
  if (tbl) {
    for (const r of b.rows) {
      tableRow(ctx, tbl, [
        r.id, r.label, r.group, r.accelerator,
        b.defaultsById[r.id] ?? '',
        r.overridden ? 'custom' : 'default',
      ]);
    }
    endTable(ctx, tbl);
  }

  separator(ctx);
  heading(ctx, 'Edit accelerators');
  for (const r of b.rows) {
    const ref = b.draft[r.id];
    inputText(ctx, r.label, ref, { width: 240 });
    sameLine(ctx);
    if (button(ctx, 'Save', 'accent')) {
      void bridge.invoke('shortcuts:set', { id: r.id, accelerator: ref.value.trim() })
        .then((raw) => {
          const res = raw as { ok: boolean; error?: string };
          b.actionMsg = res.ok
            ? { text: `Saved ${r.id} → ${ref.value}`, tone: 'ok' }
            : { text: `Save failed: ${res.error}`, tone: 'fail' };
          if (res.ok) return reload(b, bridge);
          return undefined;
        }).catch((err) => { b.actionMsg = { text: `Save failed: ${String(err)}`, tone: 'fail' }; });
    }
    if (r.overridden) {
      sameLine(ctx);
      if (button(ctx, 'Restore default')) {
        void bridge.invoke('shortcuts:clear', { id: r.id }).then((raw) => {
          const res = raw as { ok: boolean; error?: string };
          b.actionMsg = res.ok
            ? { text: `${r.id} restored to default`, tone: 'ok' }
            : { text: `Restore failed: ${res.error}`, tone: 'fail' };
          if (res.ok) return reload(b, bridge);
          return undefined;
        }).catch((err) => { b.actionMsg = { text: `Restore failed: ${String(err)}`, tone: 'fail' }; });
      }
    }
  }

  spacing(ctx, 6);
  if (button(ctx, 'Reset all to defaults', 'danger')) {
    void bridge.invoke('shortcuts:reset').then((raw) => {
      const res = raw as { ok: boolean; error?: string };
      b.actionMsg = res.ok
        ? { text: 'All shortcuts reset to defaults', tone: 'ok' }
        : { text: `Reset failed: ${res.error}`, tone: 'fail' };
      if (res.ok) return reload(b, bridge);
      return undefined;
    }).catch((err) => { b.actionMsg = { text: `Reset failed: ${String(err)}`, tone: 'fail' }; });
  }

  endWindow(ctx);
}
