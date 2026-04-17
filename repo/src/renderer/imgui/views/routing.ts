import { type ImGuiContext, type Rect } from '../runtime';
import {
  beginWindow, endWindow, heading, text, textDim, separator, spacing,
  button, sameLine, beginTable, tableRow, endTable, banner, menuBar,
  inputText, type InputTextRef,
} from '../widgets';
import { useContextMenu, drawMenu, copyRowAsTsv } from '../context-menu';
import type { AppState, IpcBridge } from '../app';

/* =========================================================================
 * Routing View — dataset listing, import, activate, rollback, optimize.
 * ========================================================================= */

interface DatasetRow {
  id: string; name: string; version: string;
  importedAt: number; nodeCount: number; edgeCount: number; active: number;
}

interface OptimizeResult {
  order:  number[];
  legs:   Array<{ distanceMeters: number; timeSeconds: number; tollCents: number }>;
  totals: { distanceMeters: number; timeSeconds: number; tollCents: number };
  computeMs: number;
}

interface Bucket {
  rows: DatasetRow[];
  activeId: string | null;
  loading: boolean; loaded: boolean; error: string | null;
  sourcePath: InputTextRef;
  actionMsg: { text: string; tone: 'ok' | 'warn' | 'fail' } | null;
  // Dynamic 2..25 stop list — user can add / remove rows
  stops: InputTextRef[];
  optimizeBy: 'time' | 'distance' | 'cost';
  perMileCentsRef: InputTextRef;
  optimizing: boolean;
  optimizeResult: OptimizeResult | null;
  optimizeMsg: string | null;
}

/** Mirror of the server-side MAX_STOPS (src/main/routing/optimizer.ts).
 *  Exported so tests can confirm the UI clamp matches the handler. */
export const MAX_STOPS_CLIENT = 25;
export const MIN_STOPS_CLIENT = 2;

export interface RoutingStopValidation {
  ok:       boolean;
  error?:   'too_few' | 'too_many';
  filled:   number;
}

/** Count non-blank stops and assert the 2..25 bounds.
 *  Exported for unit tests + used by the view before invoking optimize. */
export function validateStopCount(values: string[]): RoutingStopValidation {
  const filled = values.map((v) => v.trim()).filter((v) => v.length > 0).length;
  if (filled < MIN_STOPS_CLIENT) return { ok: false, error: 'too_few',  filled };
  if (filled > MAX_STOPS_CLIENT) return { ok: false, error: 'too_many', filled };
  return { ok: true, filled };
}

const BUCKET = new WeakMap<AppState, Bucket>();
function bucket(s: AppState): Bucket {
  let b = BUCKET.get(s);
  if (!b) {
    b = {
      rows: [], activeId: null, loading: false, loaded: false, error: null,
      sourcePath: { value: '' }, actionMsg: null,
      // Start with two stops (the minimum).  The user can add more up to MAX_STOPS_CLIENT.
      stops: [{ value: '' }, { value: '' }],
      optimizeBy: 'time', perMileCentsRef: { value: '60' },
      optimizing: false, optimizeResult: null, optimizeMsg: null,
    };
    BUCKET.set(s, b);
  }
  return b;
}

function kms(meters: number): string { return `${(meters / 1000).toFixed(2)} km`; }
function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
function usd(cents: number): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

async function reload(b: Bucket, bridge: IpcBridge): Promise<void> {
  b.loading = true; b.error = null;
  try {
    const [list, active] = await Promise.all([
      bridge.invoke('routing:datasets') as Promise<DatasetRow[]>,
      bridge.invoke('routing:activeDataset') as Promise<{ id: string } | null>,
    ]);
    b.rows     = Array.isArray(list) ? list : [];
    b.activeId = active?.id ?? null;
    b.loaded   = true;
  } catch (err) {
    b.error = String((err as Error)?.message ?? err);
  } finally {
    b.loading = false;
  }
}

export function drawRoutingView(
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
  ]);

  const rect: Rect = { x: 0, y: 24, w: ctx.width, h: ctx.height - 24 };
  beginWindow(ctx, 'Offline Routing', rect);

  if (b.actionMsg) banner(ctx, b.actionMsg.text, b.actionMsg.tone);
  if (b.error)     text(ctx, `Failed: ${b.error}`, ctx.theme.Fail);

  heading(ctx, 'Import dataset (USB / local folder)');
  inputText(ctx, 'Source path', b.sourcePath, { width: 520 });
  if (button(ctx, 'Import', 'accent')) {
    void bridge.invoke('routing:import', { sourcePath: b.sourcePath.value })
      .then(() => { b.actionMsg = { text: 'Dataset imported', tone: 'ok' }; b.sourcePath.value = ''; return reload(b, bridge); })
      .catch((err) => { b.actionMsg = { text: `Import failed: ${String(err)}`, tone: 'fail' }; });
  }
  sameLine(ctx);
  if (button(ctx, 'Rollback to previous')) {
    void bridge.invoke('routing:rollback')
      .then(() => { b.actionMsg = { text: 'Rolled back to previous dataset', tone: 'warn' }; return reload(b, bridge); })
      .catch((err) => { b.actionMsg = { text: `Rollback failed: ${String(err)}`, tone: 'fail' }; });
  }

  separator(ctx);
  heading(ctx, `Installed datasets (${b.rows.length})`);

  const tbl = beginTable(ctx, 'datasets', [
    { key: 'active', header: 'Active', width: 70 },
    { key: 'name',   header: 'Name',   width: 180 },
    { key: 'ver',    header: 'Version', width: 100 },
    { key: 'nodes',  header: 'Nodes',  width: 100 },
    { key: 'edges',  header: 'Edges',  width: 100 },
    { key: 'when',   header: 'Imported' },
  ]);
  const ctxMenu = useContextMenu(ctx, 'routing-row-menu');
  let menuRow: typeof b.rows[number] | null = null;

  if (tbl) {
    for (const ds of b.rows) {
      const row = tableRow(ctx, tbl, [
        ds.active ? '●' : '',
        ds.name,
        ds.version,
        ds.nodeCount,
        ds.edgeCount,
        new Date(ds.importedAt * 1000).toISOString().slice(0, 10),
      ]);
      if (row.clicked && !ds.active) {
        void bridge.invoke('routing:activate', { datasetId: ds.id })
          .then(() => { b.actionMsg = { text: `Activated ${ds.name} ${ds.version}`, tone: 'ok' }; return reload(b, bridge); })
          .catch((err) => { b.actionMsg = { text: `Activate failed: ${String(err)}`, tone: 'fail' }; });
      }
      if (row.hovered && ctx.input.rightPressed) {
        ctxMenu.open(ctx.input.mouseX, ctx.input.mouseY);
        menuRow = ds;
      }
    }
    endTable(ctx, tbl);
  }

  if (menuRow || ctxMenu.isOpen) {
    const ds = menuRow;
    if (ds) {
      drawMenu(ctx, ctxMenu, [
        { label: 'Activate', disabled: !!ds.active, tone: 'accent',
          onClick: () => {
            void bridge.invoke('routing:activate', { datasetId: ds.id })
              .then(() => { b.actionMsg = { text: `Activated ${ds.name}`, tone: 'ok' }; return reload(b, bridge); })
              .catch((e) => { b.actionMsg = { text: `Activate failed: ${String(e)}`, tone: 'fail' }; });
          } },
        { type: 'separator' },
        { label: 'Copy row', accelerator: 'Ctrl+C',
          onClick: () => {
            void copyRowAsTsv([
              ds.active ? 'active' : '',
              ds.name, ds.version, ds.nodeCount, ds.edgeCount,
              new Date(ds.importedAt * 1000).toISOString().slice(0, 10),
            ]).then((ok) => {
              b.actionMsg = ok
                ? { text: 'Row copied', tone: 'ok' }
                : { text: 'Copy failed', tone: 'fail' };
            });
          } },
      ]);
    }
  }

  spacing(ctx, 6);
  textDim(ctx, 'Click a non-active dataset to activate it.  Imports + activations + rollbacks are audit-logged.');

  // ── Address-driven planner ────────────────────────────────────────
  separator(ctx);
  heading(ctx, `Plan a route by address — ${b.stops.length} stops (${MIN_STOPS_CLIENT}..${MAX_STOPS_CLIENT})`);
  textDim(ctx, 'Enter 2 to 25 addresses.  The active dataset is consulted to resolve them.');

  for (let i = 0; i < b.stops.length; i++) {
    inputText(ctx, `Stop ${i + 1}`, b.stops[i], { width: 440 });
    if (b.stops.length > MIN_STOPS_CLIENT) {
      sameLine(ctx);
      if (button(ctx, '−', 'danger')) {
        b.stops.splice(i, 1);
        // Don't touch `i` — the splice compacts; next loop iteration
        // resumes at the now-correct index.  Early-out the for loop so
        // we don't draw mismatched widgets this frame.
        break;
      }
    }
  }

  if (b.stops.length < MAX_STOPS_CLIENT) {
    if (button(ctx, '+ Add stop')) b.stops.push({ value: '' });
    sameLine(ctx);
  }
  textDim(ctx, `(max ${MAX_STOPS_CLIENT})`);

  inputText(ctx, 'Per-mile cost (¢)', b.perMileCentsRef, { width: 120 });
  sameLine(ctx);
  if (button(ctx, `Optimise by ${b.optimizeBy}`)) {
    b.optimizeBy = b.optimizeBy === 'time'
      ? 'distance'
      : b.optimizeBy === 'distance' ? 'cost' : 'time';
  }
  sameLine(ctx);
  if (button(ctx, b.optimizing ? 'Optimising…' : 'Plan route', 'accent')) {
    const values = b.stops.map((s) => s.value);
    const v      = validateStopCount(values);
    if (!v.ok) {
      b.optimizeMsg = v.error === 'too_few'
        ? `Enter at least ${MIN_STOPS_CLIENT} addresses (got ${v.filled})`
        : `Maximum ${MAX_STOPS_CLIENT} addresses — you have ${v.filled}`;
    } else {
      const addresses = values.map((s) => s.trim()).filter((s) => s.length > 0);
      b.optimizing    = true;
      b.optimizeMsg   = null;
      b.optimizeResult = null;
      void bridge.invoke('routing:optimize', {
        addresses,
        optimizeBy:    b.optimizeBy,
        perMileCents:  parseInt(b.perMileCentsRef.value, 10) || 0,
      }).then((raw) => {
        const r = raw as { ok: boolean; error?: string; unresolved?: string[]; result?: OptimizeResult };
        if (r.ok && r.result) {
          b.optimizeResult = r.result;
          b.optimizeMsg    = null;
        } else {
          b.optimizeMsg = r.unresolved
            ? `Addresses not found: ${r.unresolved.join('; ')}`
            : `Optimise failed: ${r.error ?? 'unknown_error'}`;
        }
      }).catch((err) => {
        b.optimizeMsg = `Optimise failed: ${String(err)}`;
      }).finally(() => {
        b.optimizing = false;
      });
    }
  }

  if (b.optimizeMsg) banner(ctx, b.optimizeMsg, 'warn');

  if (b.optimizeResult) {
    const t = b.optimizeResult.totals;
    text(ctx, `Route: ${b.optimizeResult.order.length} stops · computed in ${b.optimizeResult.computeMs}ms`);
    text(ctx, `Total distance:  ${kms(t.distanceMeters)}`);
    text(ctx, `Total time:      ${mmss(t.timeSeconds)}`);
    text(ctx, `Total toll/cost: ${usd(t.tollCents)}`);

    const legsTbl = beginTable(ctx, 'legs', [
      { key: 'idx',   header: 'Leg',      width: 50 },
      { key: 'dist',  header: 'Distance', width: 120 },
      { key: 'time',  header: 'Time',     width: 120 },
      { key: 'toll',  header: 'Toll/Cost' },
    ]);
    if (legsTbl) {
      b.optimizeResult.legs.forEach((leg, i) => {
        tableRow(ctx, legsTbl, [i + 1, kms(leg.distanceMeters), mmss(leg.timeSeconds), usd(leg.tollCents)]);
      });
      endTable(ctx, legsTbl);
    }
  }

  endWindow(ctx);
}
