import { type ImGuiContext, type Rect } from '../runtime';
import {
  beginWindow, endWindow, heading, textDim, text, separator, spacing,
  button, sameLine, beginTable, tableRow, endTable, menuBar,
  inputText, type InputTextRef,
} from '../widgets';
import type { AppState, IpcBridge, WindowKind } from '../app';

/* =========================================================================
 * Dashboard View — KPI strip, hot-time slots, hottest seats/rooms,
 * expiring contracts.  Operators can filter by storeId / date range /
 * hour of day; the filters propagate to analytics:snapshot so the
 * displayed numbers and the Ctrl+E export both reflect the selection.
 * ========================================================================= */

interface Bucket {
  snap:      SnapshotData | null;
  expiring:  ExpiringRow[];
  error:     string | null;
  loading:   boolean;
  loaded:    boolean;

  // Filter form
  storeId:   InputTextRef;
  from:      InputTextRef;     // yyyy-mm-dd
  to:        InputTextRef;     // yyyy-mm-dd
  hourOfDay: InputTextRef;     // 0-23 or blank
}

interface SnapshotData {
  snapshotId: string;
  filters?: {
    from: number; to: number; storeId?: string; hourOfDay?: number;
  };
  metrics: {
    orders:       { total: number; completed: number; cancelled: number };
    revenue:      { revenue_cents: number; currency: string };
    occupancy:    { occupancy_rate: number };
    hotSlots:     Array<{ hour: number; orders: number; revenue_cents: number }>;
    hotSeatRooms: Array<{
      seat_room_id: string; code: string; name: string; kind: string;
      avg_count: number; avg_capacity: number;
      occupancy_rate: number; snapshot_count: number;
    }>;
    cancellation: { rate: number };
    repurchase:   { rate: number };
  };
}

interface ExpiringRow {
  id: string; instanceNumber: string; counterparty: string | null;
  daysRemaining: number; effectiveTo: number; status: string;
}

const BUCKET = new WeakMap<AppState, Bucket>();

function bucket(s: AppState): Bucket {
  let b = BUCKET.get(s);
  if (!b) {
    b = {
      snap: null, expiring: [], error: null, loading: false, loaded: false,
      storeId:   { value: '' },
      from:      { value: '' },
      to:        { value: '' },
      hourOfDay: { value: '' },
    };
    BUCKET.set(s, b);
  }
  return b;
}

/** Exported for unit tests — converts the raw filter form values into the
 *  analytics-handler payload.  Blank / invalid fields are dropped so the
 *  main-process defaults (last 24h etc.) apply. */
export function buildSnapshotPayloadFromFilters(opts: {
  storeId?: string; from?: string; to?: string; hourOfDay?: string;
}): { storeId?: string; from?: number; to?: number; hourOfDay?: number } {
  const payload: { storeId?: string; from?: number; to?: number; hourOfDay?: number } = {};

  const storeId = (opts.storeId ?? '').trim();
  if (storeId) payload.storeId = storeId;

  const from = (opts.from ?? '').trim();
  if (from) {
    const t = Date.parse(from + 'T00:00:00Z');
    if (!Number.isNaN(t)) payload.from = Math.floor(t / 1000);
  }
  const to = (opts.to ?? '').trim();
  if (to) {
    const t = Date.parse(to + 'T00:00:00Z');
    if (!Number.isNaN(t)) payload.to = Math.floor(t / 1000);
  }
  const h = (opts.hourOfDay ?? '').trim();
  if (h !== '') {
    const n = parseInt(h, 10);
    if (Number.isInteger(n) && n >= 0 && n <= 23) payload.hourOfDay = n;
  }
  return payload;
}

function buildSnapshotPayload(b: Bucket) {
  return buildSnapshotPayloadFromFilters({
    storeId:   b.storeId.value,
    from:      b.from.value,
    to:        b.to.value,
    hourOfDay: b.hourOfDay.value,
  });
}

async function reload(b: Bucket, bridge: IpcBridge): Promise<void> {
  b.loading = true; b.error = null;
  try {
    const payload = buildSnapshotPayload(b);
    const [s, x] = await Promise.all([
      bridge.invoke('analytics:snapshot', payload) as Promise<SnapshotData>,
      bridge.invoke('contracts:expiring') as Promise<ExpiringRow[]>,
    ]);
    b.snap     = s ?? null;
    b.expiring = Array.isArray(x) ? x : [];
    b.loaded   = true;
  } catch (err) {
    b.error = String((err as Error)?.message ?? err);
  } finally {
    b.loading = false;
  }
}

export function drawDashboardView(
  ctx: ImGuiContext, state: AppState, bridge: IpcBridge,
): void {
  const b = bucket(state);

  if (state.restoredUi) {
    const ui = state.restoredUi as { kind?: string };
    if (ui?.kind) state.statusMessage = `Session restored for ${ui.kind}`;
    state.restoredUi = null;
    state.restoredUnsaved = null;
  }

  if (!b.loaded && !b.loading) void reload(b, bridge);

  if (state.exportRequested) {
    state.exportRequested = false;
    if (b.snap) {
      void bridge.invoke('analytics:export', {
        snapshotId: b.snap.snapshotId,
        ...buildSnapshotPayload(b),
        chooseDestination: true,
      }).then(() => { state.statusMessage = 'Export completed'; })
        .catch((err) => { state.statusMessage = `Export failed: ${String(err)}`; });
    } else {
      state.statusMessage = 'Nothing loaded to export yet';
    }
  }

  const rect: Rect = { x: 0, y: 24, w: ctx.width, h: ctx.height - 48 };
  menuBar(ctx, { x: 0, y: 0, w: ctx.width, h: 24 }, [
    { label: 'Dashboard', onClick: () => { state.kind = 'dashboard'; } },
    { label: 'Contracts', onClick: () => { state.kind = 'contracts'; } },
    { label: 'Audit',     onClick: () => { state.kind = 'audit';     } },
    { label: 'Reviews',   onClick: () => { state.kind = 'reviews';   } },
    { label: 'Routing',   onClick: () => { state.kind = 'routing';   } },
    { label: 'Admin',     onClick: () => { state.kind = 'admin';     } },
  ]);

  beginWindow(ctx, `Dashboard — ${state.sessionTenantId ?? ''}`, rect);

  heading(ctx, 'Operations — at a glance');
  textDim(ctx, state.sessionRoles.join(' · '));

  // ── Filter bar ────────────────────────────────────────────────────
  separator(ctx);
  heading(ctx, 'Filters');
  inputText(ctx, 'Store id', b.storeId, { width: 200, placeholder: 'any' });
  sameLine(ctx);
  inputText(ctx, 'From (yyyy-mm-dd)', b.from, { width: 150 });
  sameLine(ctx);
  inputText(ctx, 'To (yyyy-mm-dd)', b.to, { width: 150 });
  sameLine(ctx);
  inputText(ctx, 'Hour (0-23)', b.hourOfDay, { width: 120, placeholder: 'any' });
  sameLine(ctx);
  if (button(ctx, 'Apply filters', 'accent')) void reload(b, bridge);
  sameLine(ctx);
  if (button(ctx, 'Clear')) {
    b.storeId.value = ''; b.from.value = ''; b.to.value = ''; b.hourOfDay.value = '';
    void reload(b, bridge);
  }

  separator(ctx);
  if (b.error)   { text(ctx, `Failed: ${b.error}`, ctx.theme.Fail); }
  if (b.loading) { textDim(ctx, 'Loading…'); }

  const m = b.snap?.metrics;
  if (m) {
    text(ctx, `Orders        ${m.orders.total}   (${m.orders.completed} completed)`);
    text(ctx, `Revenue       ${money(m.revenue.revenue_cents, m.revenue.currency)}`);
    text(ctx, `Occupancy     ${pct(m.occupancy.occupancy_rate)}`);
    text(ctx, `Cancellation  ${pct(m.cancellation.rate)}`);
    text(ctx, `Repurchase    ${pct(m.repurchase.rate)}`);

    // ── Hot time slots ─────────────────────────────────────────────
    separator(ctx);
    heading(ctx, 'Hot time slots');
    const tbl = beginTable(ctx, 'hotslots', [
      { key: 'hour',    header: 'Hour',    width: 80 },
      { key: 'orders',  header: 'Orders',  width: 100 },
      { key: 'revenue', header: 'Revenue' },
    ]);
    if (tbl) {
      for (const slot of m.hotSlots.slice(0, 12)) {
        tableRow(ctx, tbl, [
          `${String(slot.hour).padStart(2, '0')}:00`,
          slot.orders,
          money(slot.revenue_cents, m.revenue.currency),
        ]);
      }
      endTable(ctx, tbl);
    }

    // ── Hottest seats / rooms (new metric) ─────────────────────────
    separator(ctx);
    heading(ctx, `Hottest seats / rooms — ${m.hotSeatRooms.length}`);
    if (m.hotSeatRooms.length === 0) {
      textDim(ctx, 'No occupancy snapshots in range.');
    } else {
      const seats = beginTable(ctx, 'hotseats', [
        { key: 'code',     header: 'Code',     width: 120 },
        { key: 'name',     header: 'Name' },
        { key: 'kind',     header: 'Kind',     width: 90 },
        { key: 'avg',      header: 'Avg occ.', width: 100 },
        { key: 'cap',      header: 'Capacity', width: 90 },
        { key: 'rate',     header: 'Rate',     width: 80 },
        { key: 'samples',  header: 'Samples',  width: 80 },
      ]);
      if (seats) {
        for (const r of m.hotSeatRooms) {
          tableRow(ctx, seats, [
            r.code,
            r.name,
            r.kind,
            r.avg_count.toFixed(2),
            r.avg_capacity.toFixed(1),
            pct(r.occupancy_rate),
            r.snapshot_count,
          ]);
        }
        endTable(ctx, seats);
      }
    }
  }

  separator(ctx);
  heading(ctx, `Contracts expiring soon — ${b.expiring.length}`);
  const et = beginTable(ctx, 'expiring', [
    { key: 'num',   header: 'Number',       width: 140 },
    { key: 'cp',    header: 'Counterparty' },
    { key: 'days',  header: 'Days left',    width: 100 },
    { key: 'to',    header: 'Expires',      width: 120 },
  ]);
  if (et) {
    for (const row of b.expiring) {
      tableRow(ctx, et, [
        row.instanceNumber,
        row.counterparty ?? '—',
        `${row.daysRemaining}d`,
        new Date(row.effectiveTo * 1000).toISOString().slice(0, 10),
      ]);
    }
    endTable(ctx, et);
  }

  spacing(ctx, 6);
  if (button(ctx, 'Refresh')) void reload(b, bridge);
  sameLine(ctx);
  if (button(ctx, 'Export Snapshot', 'accent')) {
    if (b.snap) void bridge.invoke('analytics:export', {
      snapshotId: b.snap.snapshotId,
      ...buildSnapshotPayload(b),
      chooseDestination: true,
    });
  }
  sameLine(ctx);
  if (button(ctx, 'Sign Out', 'danger')) {
    void bridge.invoke('session:logout').then(() => {
      state.sessionUserId   = null;
      state.sessionTenantId = null;
      state.sessionRoles    = [];
    });
  }

  endWindow(ctx);

  // Status strip
  ctx.addRect({ x: 0, y: ctx.height - 24, w: ctx.width, h: 24 }, ctx.theme.ChildBg);
  ctx.addText(12, ctx.height - 12, `Offline · ${state.statusMessage}`, ctx.theme.TextDim,
              undefined, 'middle');
}

function pct(n: number): string  { return `${(n * 100).toFixed(1)}%`; }
function money(c: number, cur: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).format(c / 100);
  } catch { return `${(c / 100).toFixed(2)} ${cur}`; }
}

export type { WindowKind };
