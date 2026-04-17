import { type ImGuiContext, type Rect } from '../runtime';
import {
  beginWindow, endWindow, heading, text, textDim, separator, spacing,
  button, sameLine, beginTable, tableRow, endTable, banner, menuBar,
  inputText, type InputTextRef, mono,
} from '../widgets';
import { useContextMenu, drawMenu, copyRowAsTsv, cellsToTsv } from '../context-menu';
import type { AppState, IpcBridge } from '../app';

/* =========================================================================
 * Audit Log View — filterable list + chain verification banner + export.
 * ========================================================================= */

interface AuditRow {
  id: string; seq: number | null; occurredAt: number; action: string;
  actorUserId: string | null; entityType: string | null; entityId: string | null;
  hashCurr: string;
}

interface Bucket {
  rows: AuditRow[];
  banner: { ok: boolean; message: string } | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  filterActor:  InputTextRef;
  filterAction: InputTextRef;
  filterEntity: InputTextRef;
  exportMsg: string | null;
}

const BUCKET = new WeakMap<AppState, Bucket>();
function bucket(s: AppState): Bucket {
  let b = BUCKET.get(s);
  if (!b) {
    b = {
      rows: [], banner: null, loading: false, loaded: false, error: null,
      filterActor:  { value: '' },
      filterAction: { value: '' },
      filterEntity: { value: '' },
      exportMsg: null,
    };
    BUCKET.set(s, b);
  }
  return b;
}

async function reload(b: Bucket, bridge: IpcBridge): Promise<void> {
  b.loading = true; b.error = null;
  const payload = {
    actor:      b.filterActor.value  || undefined,
    action:     b.filterAction.value || undefined,
    entityType: b.filterEntity.value || undefined,
  };
  try {
    const [list, verify] = await Promise.all([
      bridge.invoke('audit:list',   payload) as Promise<AuditRow[]>,
      bridge.invoke('audit:verify', payload) as Promise<{ ok: boolean; break?: { seq: number; reason: string } }>,
    ]);
    b.rows   = Array.isArray(list) ? list : [];
    b.banner = verify ? {
      ok: verify.ok,
      message: verify.ok
        ? `Chain verified — ${b.rows.length} events`
        : `Chain broken at seq ${verify.break?.seq}: ${verify.break?.reason}`,
    } : null;
    b.loaded = true;
  } catch (err) {
    b.error = String((err as Error)?.message ?? err);
  } finally {
    b.loading = false;
  }
}

export function drawAuditView(
  ctx: ImGuiContext, state: AppState, bridge: IpcBridge,
): void {
  const b = bucket(state);
  if (!b.loaded && !b.loading) void reload(b, bridge);

  // Ctrl+E broadcast → export the audit bundle with a chosen destination.
  if (state.exportRequested) {
    state.exportRequested = false;
    void bridge.invoke('audit:export', { chooseDestination: true })
      .then((r) => { b.exportMsg = `Export written: ${(r as { path: string }).path}`; })
      .catch((err) => { b.exportMsg = `Export failed: ${String(err)}`; });
  }

  menuBar(ctx, { x: 0, y: 0, w: ctx.width, h: 24 }, [
    { label: 'Dashboard', onClick: () => { state.kind = 'dashboard'; } },
    { label: 'Contracts', onClick: () => { state.kind = 'contracts'; } },
    { label: 'Audit',     onClick: () => { state.kind = 'audit';     } },
    { label: 'Reviews',   onClick: () => { state.kind = 'reviews';   } },
    { label: 'Routing',   onClick: () => { state.kind = 'routing';   } },
    { label: 'Admin',     onClick: () => { state.kind = 'admin';     } },
  ]);

  const rect: Rect = { x: 0, y: 24, w: ctx.width, h: ctx.height - 24 };
  beginWindow(ctx, 'Audit Log Viewer', rect);

  if (b.banner) banner(ctx, b.banner.message, b.banner.ok ? 'ok' : 'fail');
  if (b.error)  text(ctx, `Failed: ${b.error}`, ctx.theme.Fail);
  if (b.exportMsg) banner(ctx, b.exportMsg, 'ok');

  inputText(ctx, 'Actor',       b.filterActor,  { width: 160 });
  sameLine(ctx);
  inputText(ctx, 'Action',      b.filterAction, { width: 160 });
  sameLine(ctx);
  inputText(ctx, 'Entity type', b.filterEntity, { width: 160 });
  sameLine(ctx);
  if (button(ctx, 'Apply', 'accent')) void reload(b, bridge);
  sameLine(ctx);
  if (button(ctx, 'Export ZIP')) {
    void bridge.invoke('audit:export', { chooseDestination: true })
      .then((r) => { b.exportMsg = `Export written: ${(r as { path: string }).path}`; })
      .catch((e) => { b.exportMsg = `Export failed: ${String(e)}`; });
  }
  spacing(ctx, 6);

  const tbl = beginTable(ctx, 'events', [
    { key: 'seq',    header: 'Seq',       width: 80 },
    { key: 'when',   header: 'When (UTC)', width: 170 },
    { key: 'action', header: 'Action',    width: 200 },
    { key: 'actor',  header: 'Actor',     width: 140 },
    { key: 'entity', header: 'Entity' },
    { key: 'hash',   header: 'Hash',      width: 120 },
  ]);
  const ctxMenu = useContextMenu(ctx, 'audit-row-menu');
  let menuRow: AuditRow | null = null;

  if (tbl) {
    for (const r of b.rows) {
      const cells = [
        r.seq ?? '',
        new Date(r.occurredAt * 1000).toISOString().replace('T', ' ').slice(0, 19),
        r.action,
        r.actorUserId ?? '—',
        `${r.entityType ?? ''} ${r.entityId ?? ''}`.trim() || '—',
        r.hashCurr.slice(0, 10) + '…',
      ];
      const rr = tableRow(ctx, tbl, cells);
      if (rr.hovered && ctx.input.rightPressed) {
        ctxMenu.open(ctx.input.mouseX, ctx.input.mouseY);
        menuRow = r;
      }
    }
    endTable(ctx, tbl);
  }

  if (menuRow || ctxMenu.isOpen) {
    const row = menuRow;
    if (row) {
      drawMenu(ctx, ctxMenu, [
        { label: 'Copy hash (full)', onClick: () => {
            void copyRowAsTsv([row.hashCurr]).then((ok) => {
              b.exportMsg = ok ? 'Hash copied' : 'Copy failed';
            });
          } },
        { label: 'Copy row', accelerator: 'Ctrl+C', onClick: () => {
            void copyRowAsTsv([
              row.seq ?? '', new Date(row.occurredAt * 1000).toISOString(),
              row.action, row.actorUserId ?? '',
              `${row.entityType ?? ''} ${row.entityId ?? ''}`.trim(),
              row.hashCurr,
            ]).then((ok) => { b.exportMsg = ok ? 'Row copied' : 'Copy failed'; });
          } },
        { type: 'separator' },
        { label: 'Copy all visible rows', onClick: () => {
            const tsv = cellsToTsv([
              ['seq','when','action','actor','entity','hash'],
              ...b.rows.map((x) => [
                x.seq ?? '', new Date(x.occurredAt * 1000).toISOString(),
                x.action, x.actorUserId ?? '',
                `${x.entityType ?? ''} ${x.entityId ?? ''}`.trim(),
                x.hashCurr,
              ]),
            ]);
            void copyRowAsTsv([tsv]).then(() => { b.exportMsg = 'All rows copied'; });
          } },
      ]);
    }
  }

  separator(ctx);
  textDim(ctx, `${b.rows.length} events shown`);
  endWindow(ctx);
}
