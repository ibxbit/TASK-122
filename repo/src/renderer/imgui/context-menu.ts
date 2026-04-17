import { type ImGuiContext, type Rect, DEFAULT_FONT } from './runtime';

/* =========================================================================
 * Right-click Context Menu (immediate-mode)
 *
 *   useContextMenu(ctx, key) returns a per-widget-id state handle that
 *   remembers the open flag + anchor position across frames.  Callers do:
 *
 *     const menu = useContextMenu(ctx, 'contracts-row-123');
 *     if (<hit-area>.rightClicked) menu.open(event.x, event.y);
 *     drawMenu(ctx, menu, [
 *       { label: 'Approve',  onClick: ... },
 *       { label: 'Reject',   onClick: ..., tone: 'danger' },
 *       { label: 'Edit',     onClick: ... },
 *       { type:  'separator' },
 *       { label: 'Copy row', onClick: ... },
 *     ]);
 *
 *   Closes on Escape, click outside, or item click.  Stays visible for as
 *   long as the caller keeps invoking drawMenu — matches Dear ImGui's
 *   `BeginPopup / EndPopup` contract.
 * ========================================================================= */

export type ContextMenuItem =
  | { type?: 'item'; label: string; onClick: () => void; disabled?: boolean; tone?: 'default'|'danger'|'accent'; accelerator?: string }
  | { type:  'separator' };

export interface ContextMenuHandle {
  open(x: number, y: number): void;
  close(): void;
  readonly isOpen: boolean;
  readonly anchor: { x: number; y: number };
}

interface ContextMenuState { open: boolean; x: number; y: number; }

const STATES = new WeakMap<ImGuiContext, Map<string, ContextMenuState>>();

export function useContextMenu(ctx: ImGuiContext, id: string): ContextMenuHandle {
  let bag = STATES.get(ctx);
  if (!bag) { bag = new Map(); STATES.set(ctx, bag); }
  let st = bag.get(id);
  if (!st) { st = { open: false, x: 0, y: 0 }; bag.set(id, st); }
  const state = st;
  return {
    open(x, y) { state.open = true; state.x = x; state.y = y; },
    close()    { state.open = false; },
    get isOpen() { return state.open; },
    get anchor() { return { x: state.x, y: state.y }; },
  };
}

const ITEM_H   = 26;
const SEP_H    = 8;
const PAD_X    = 10;
const MIN_W    = 160;

export function drawMenu(
  ctx: ImGuiContext, handle: ContextMenuHandle, items: ContextMenuItem[],
): void {
  if (!handle.isOpen) return;

  // Measure
  let width = MIN_W;
  for (const item of items) {
    if ('type' in item && item.type === 'separator') continue;
    const i = item as Exclude<ContextMenuItem, { type: 'separator' }>;
    const w = ctx.measureText(i.label) + (i.accelerator ? ctx.measureText(i.accelerator) + 24 : 0) + PAD_X * 2;
    if (w > width) width = w;
  }
  const h = items.reduce((a, it) => a + ('type' in it && it.type === 'separator' ? SEP_H : ITEM_H), 0) + 6;

  const { x: ax, y: ay } = handle.anchor;
  const rect: Rect = {
    x: Math.min(ax, ctx.width  - width - 4),
    y: Math.min(ay, ctx.height - h     - 4),
    w: width, h,
  };

  // Background + border
  ctx.addRect(rect, ctx.theme.WindowBg, ctx.theme.Border, 1, 4);

  // Items
  let y = rect.y + 3;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if ('type' in item && item.type === 'separator') {
      ctx.addLine(rect.x + 6, y + SEP_H / 2, rect.x + rect.w - 6, y + SEP_H / 2, ctx.theme.Separator);
      y += SEP_H;
      continue;
    }
    const it = item as Exclude<ContextMenuItem, { type: 'separator' }>;
    const rowRect: Rect = { x: rect.x + 3, y, w: rect.w - 6, h: ITEM_H };
    const id = ctx.pushId(`ctxitem:${i}:${it.label}`); ctx.popId();
    const beh = it.disabled ? { hovered: false, clicked: false, held: false } : ctx.buttonBehavior(id, rowRect);

    if (beh.hovered) ctx.addRect(rowRect, ctx.theme.HeaderHovered);
    const color = it.disabled
      ? ctx.theme.TextDisabled
      : it.tone === 'danger'
        ? ctx.theme.ButtonDanger
        : it.tone === 'accent'
          ? ctx.theme.ButtonAccent
          : ctx.theme.Text;
    ctx.addText(rowRect.x + PAD_X, rowRect.y + ITEM_H / 2, it.label, color, DEFAULT_FONT, 'middle');
    if (it.accelerator) {
      ctx.addText(rowRect.x + rowRect.w - PAD_X, rowRect.y + ITEM_H / 2, it.accelerator,
                  ctx.theme.TextDim, DEFAULT_FONT, 'middle', 'right');
    }

    if (beh.clicked && !it.disabled) {
      handle.close();
      try { it.onClick(); } catch { /* propagate? swallow to keep UI alive */ }
      return;
    }
    y += ITEM_H;
  }

  // Dismissal handling — Escape or clicking outside the menu closes it.
  if (ctx.input.keysPressed.has('Escape')) handle.close();
  if (ctx.input.mousePressed && !ctx.mouseInRect(rect)) handle.close();
}

/* ------------------------------------------------------------------ *
 *  Deep clipboard copy — TSV serialisation for selected table cells   *
 *                                                                      *
 *  Cells is a 2-D array of strings.  Non-contiguous selections are not  *
 *  supported by this helper because Dear ImGui tables are row-oriented *
 *  — we default to a single row or a rectangular block.                *
 * ------------------------------------------------------------------ */

export function cellsToTsv(cells: Array<Array<string | number | null | undefined>>): string {
  const rows = cells.map((row) =>
    row.map((v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      // Neutralise tab + CR + LF in cell contents so the output remains
      // a valid TSV grid when pasted into Excel / Sheets.
      return s.replace(/\t/g, ' ').replace(/\r/g, ' ').replace(/\n/g, ' ');
    }).join('\t'),
  );
  return rows.join('\r\n') + '\r\n';
}

export async function copyRowAsTsv(
  row: Array<string | number | null | undefined>,
): Promise<boolean> {
  const tsv = cellsToTsv([row]);
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(tsv);
      return true;
    }
  } catch { /* fall through */ }

  // Fallback: execCommand('copy') for contexts where clipboard API is gated.
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = tsv;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
