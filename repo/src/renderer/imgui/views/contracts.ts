import { type ImGuiContext, type Rect } from '../runtime';
import {
  beginWindow, endWindow, heading, text, textDim, separator, spacing,
  button, sameLine, beginTable, tableRow, endTable, banner, menuBar,
  inputText, type InputTextRef,
} from '../widgets';
import { useContextMenu, drawMenu, copyRowAsTsv } from '../context-menu';
import type { AppState, IpcBridge } from '../app';

/* =========================================================================
 * Contracts View — list + select + approve/reject/sign + new-draft.
 * ========================================================================= */

interface Row {
  id: string; instanceNumber: string; templateCode: string;
  templateVersion: number; status: string; counterparty: string | null;
  effectiveFrom: number | null; effectiveTo: number | null;
}

interface Bucket {
  rows: Row[];
  selectedId: string | null;
  error: string | null;
  loading: boolean;
  loaded: boolean;
  password: InputTextRef;
  actionMsg: { text: string; tone: 'ok' | 'warn' | 'fail' } | null;
}

const BUCKET = new WeakMap<AppState, Bucket>();
function bucket(s: AppState): Bucket {
  let b = BUCKET.get(s);
  if (!b) {
    b = { rows: [], selectedId: null, error: null, loading: false, loaded: false, password: { value: '' }, actionMsg: null };
    BUCKET.set(s, b);
  }
  return b;
}

async function reload(b: Bucket, bridge: IpcBridge): Promise<void> {
  b.loading = true; b.error = null;
  try {
    const data = await bridge.invoke('contracts:list') as Row[];
    b.rows   = Array.isArray(data) ? data : [];
    b.loaded = true;
  } catch (err) {
    b.error = String((err as Error)?.message ?? err);
  } finally {
    b.loading = false;
  }
}

export function drawContractsView(
  ctx: ImGuiContext, state: AppState, bridge: IpcBridge,
): void {
  const b = bucket(state);
  if (!b.loaded && !b.loading) void reload(b, bridge);

  // Ctrl+E broadcast → export filtered contract list
  if (state.exportRequested) {
    state.exportRequested = false;
    void bridge.invoke('contracts:export', { status: 'all' })
      .then(() => { state.statusMessage = 'Contract list exported'; })
      .catch((err) => { state.statusMessage = `Export failed: ${String(err)}`; });
  }

  menuBar(ctx, { x: 0, y: 0, w: ctx.width, h: 24 }, [
    { label: 'Dashboard', onClick: () => { state.kind = 'dashboard'; } },
    { label: 'Contracts', onClick: () => { state.kind = 'contracts'; } },
    { label: 'Audit',     onClick: () => { state.kind = 'audit';     } },
    { label: 'Reviews',   onClick: () => { state.kind = 'reviews';   } },
    { label: 'Routing',   onClick: () => { state.kind = 'routing';   } },
    { label: 'Admin',     onClick: () => { state.kind = 'admin';     } },
  ]);

  const rect: Rect = { x: 0, y: 24, w: ctx.width, h: ctx.height - 48 };
  beginWindow(ctx, 'Contract Workspace', rect);

  if (b.actionMsg) banner(ctx, b.actionMsg.text, b.actionMsg.tone);
  if (b.error)     text(ctx, `Failed: ${b.error}`, ctx.theme.Fail);

  if (button(ctx, 'New Draft', 'accent')) {
    void bridge.invoke('contracts:newDraft').then(() => reload(b, bridge))
      .catch((e) => { b.actionMsg = { text: `New draft failed: ${String(e)}`, tone: 'fail' }; });
  }
  sameLine(ctx);
  if (button(ctx, 'Refresh')) void reload(b, bridge);

  spacing(ctx, 6);

  const tbl = beginTable(ctx, 'contracts', [
    { key: 'num',     header: 'Number',       width: 160 },
    { key: 'tpl',     header: 'Template',     width: 180 },
    { key: 'cp',      header: 'Counterparty' },
    { key: 'status',  header: 'Status',       width: 150 },
    { key: 'to',      header: 'Expires',      width: 120 },
  ]);
  const ctxMenu = useContextMenu(ctx, 'contracts-row-menu');
  let menuRow: typeof b.rows[number] | null = null;

  if (tbl) {
    for (const row of b.rows) {
      const cells = [
        row.instanceNumber,
        `${row.templateCode} v${row.templateVersion}`,
        row.counterparty ?? '—',
        row.status,
        row.effectiveTo ? new Date(row.effectiveTo * 1000).toISOString().slice(0, 10) : '—',
      ];
      const r = tableRow(ctx, tbl, cells);
      if (r.clicked) b.selectedId = row.id;
      // Right-click opens the approve/reject/edit/copy menu anchored at
      // the pointer.  Only the hovered row opens (others don't).
      if (r.hovered && ctx.input.rightPressed) {
        ctxMenu.open(ctx.input.mouseX, ctx.input.mouseY);
        menuRow = row;
        b.selectedId = row.id;
      }
    }
    endTable(ctx, tbl);
  }

  // Render the context menu on top of the table.
  if (menuRow || ctxMenu.isOpen) {
    const row = menuRow ?? b.rows.find((r) => r.id === b.selectedId) ?? null;
    if (row) {
      const canApprove = row.status === 'draft' || row.status === 'pending_signature';
      const canReject  = row.status !== 'terminated' && row.status !== 'expired';
      drawMenu(ctx, ctxMenu, [
        { label: 'Approve',   accelerator: 'Enter',   disabled: !canApprove, tone: 'accent',
          onClick: () => {
            void bridge.invoke('contracts:approve', { id: row.id })
              .then(() => { b.actionMsg = { text: `Approved ${row.instanceNumber}`, tone: 'ok' }; return reload(b, bridge); })
              .catch((e) => { b.actionMsg = { text: `Approve failed: ${String(e)}`, tone: 'fail' }; });
          } },
        { label: 'Reject',    accelerator: 'Del',     disabled: !canReject,  tone: 'danger',
          onClick: () => {
            void bridge.invoke('contracts:reject', { id: row.id })
              .then(() => { b.actionMsg = { text: `Rejected ${row.instanceNumber}`, tone: 'warn' }; return reload(b, bridge); })
              .catch((e) => { b.actionMsg = { text: `Reject failed: ${String(e)}`, tone: 'fail' }; });
          } },
        { label: 'Edit',      onClick: () => { b.selectedId = row.id; } },
        { type: 'separator' },
        { label: 'Copy row',  accelerator: 'Ctrl+C',
          onClick: () => {
            void copyRowAsTsv([
              row.instanceNumber,
              `${row.templateCode} v${row.templateVersion}`,
              row.counterparty ?? '',
              row.status,
              row.effectiveTo ? new Date(row.effectiveTo * 1000).toISOString().slice(0, 10) : '',
            ]).then((ok) => {
              b.actionMsg = ok
                ? { text: 'Row copied to clipboard', tone: 'ok' }
                : { text: 'Copy failed', tone: 'fail' };
            });
          } },
      ]);
    }
  }

  separator(ctx);
  const sel = b.selectedId ? b.rows.find(r => r.id === b.selectedId) : null;
  if (!sel) {
    textDim(ctx, 'Click a row to act on it.');
  } else {
    heading(ctx, `Selected: ${sel.instanceNumber} (${sel.status})`);
    if (button(ctx, 'Approve', 'accent')) {
      void bridge.invoke('contracts:approve', { id: sel.id })
        .then(() => { b.actionMsg = { text: `Approved ${sel.instanceNumber}`, tone: 'ok' }; return reload(b, bridge); })
        .catch((e) => { b.actionMsg = { text: `Approve failed: ${String(e)}`, tone: 'fail' }; });
    }
    sameLine(ctx);
    if (button(ctx, 'Reject', 'danger')) {
      void bridge.invoke('contracts:reject', { id: sel.id })
        .then(() => { b.actionMsg = { text: `Rejected ${sel.instanceNumber}`, tone: 'warn' }; return reload(b, bridge); })
        .catch((e) => { b.actionMsg = { text: `Reject failed: ${String(e)}`, tone: 'fail' }; });
    }
    sameLine(ctx);
    if (button(ctx, 'Delete', 'danger')) {
      void bridge.invoke('contracts:delete', { contractId: sel.id })
        .then(() => { b.actionMsg = { text: `Deleted ${sel.instanceNumber}`, tone: 'warn' }; b.selectedId = null; return reload(b, bridge); })
        .catch((e) => { b.actionMsg = { text: `Delete failed: ${String(e)}`, tone: 'fail' }; });
    }

    spacing(ctx, 6);
    inputText(ctx, 'Password (to sign)', b.password, { password: true, width: 220 });
    if (button(ctx, 'Sign & activate', 'accent')) {
      void bridge.invoke('contracts:sign', { id: sel.id, password: b.password.value })
        .then(() => { b.actionMsg = { text: `Signed ${sel.instanceNumber}`, tone: 'ok' }; b.password.value = ''; return reload(b, bridge); })
        .catch((e) => { b.actionMsg = { text: `Sign failed: ${String(e)}`, tone: 'fail' }; });
    }
  }

  endWindow(ctx);
}
