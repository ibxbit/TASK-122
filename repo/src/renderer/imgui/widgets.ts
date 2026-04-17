import {
  type ImGuiContext, type WindowState, type Rect,
  DEFAULT_FONT, HEADING_FONT, MONO_FONT,
} from './runtime';

/* =========================================================================
 * Dear ImGui Widgets
 *
 *   The public widget API used by app views.  Every function either draws
 *   directly into the context's draw list, or advances the window's cursor
 *   so layout composes automatically.  Return values mirror the C++ API:
 *
 *     button(ctx, label)        → true when clicked
 *     selectable(ctx, label, s) → true when clicked; s is selected state
 *     inputText(ctx, id, ref)   → true when text changed; ref.value is buffer
 *     checkbox(ctx, label, ref) → true when toggled
 *
 *   Layout helpers: sameLine, separator, indent/unindent, spacing, newLine.
 * ========================================================================= */

const WINDOW_TITLE_H = 28;
const PAD_X          = 12;
const PAD_Y          = 10;
const ITEM_SPACING_Y = 6;
const ITEM_SPACING_X = 8;
const BUTTON_PAD_X   = 14;
const BUTTON_PAD_Y   = 6;
const TABLE_ROW_H    = 22;

/* ---- Window -------------------------------------------------------- */

export function beginWindow(
  ctx: ImGuiContext, title: string, rect: Rect,
): WindowState {
  const id = ctx.pushId(`window:${title}`);

  // Title bar
  ctx.addRect({ x: rect.x, y: rect.y, w: rect.w, h: WINDOW_TITLE_H }, ctx.theme.TitleBg);
  ctx.addText(rect.x + PAD_X, rect.y + WINDOW_TITLE_H / 2 - 1, title,
              ctx.theme.Text, HEADING_FONT, 'middle', 'left');

  // Body
  ctx.addRect({ x: rect.x, y: rect.y + WINDOW_TITLE_H, w: rect.w, h: rect.h - WINDOW_TITLE_H },
              ctx.theme.WindowBg, ctx.theme.Border, 1);

  const window: WindowState = {
    id,
    title,
    rect,
    cursor:     { x: rect.x + PAD_X, y: rect.y + WINDOW_TITLE_H + PAD_Y },
    contentYStart: rect.y + WINDOW_TITLE_H + PAD_Y,
    indent:     0,
    sameLine:   false,
    sameLineX:  null,
  };
  ctx.pushWindow(window);

  // Clip subsequent drawing to the window body
  ctx.pushClip({
    x: rect.x,
    y: rect.y + WINDOW_TITLE_H,
    w: rect.w,
    h: rect.h - WINDOW_TITLE_H,
  });

  return window;
}

export function endWindow(ctx: ImGuiContext): void {
  ctx.popClip();
  ctx.popWindow();
  ctx.popId();
}

/* ---- Layout primitives --------------------------------------------- */

function advanceCursor(ctx: ImGuiContext, w: number, h: number): { x: number; y: number } {
  const win = ctx.window;
  if (!win) return { x: 0, y: 0 };
  const x = win.sameLine && win.sameLineX !== null
    ? win.sameLineX
    : win.rect.x + PAD_X + win.indent;
  const y = win.cursor.y;

  if (win.sameLine && win.sameLineX !== null) {
    win.cursor.x = x + w + ITEM_SPACING_X;
    win.sameLineX = win.cursor.x;
    win.sameLine  = false;
  } else {
    win.cursor.x = x;
    win.cursor.y = y + h + ITEM_SPACING_Y;
    win.sameLineX = win.cursor.x + w + ITEM_SPACING_X;
  }
  return { x, y };
}

export function sameLine(ctx: ImGuiContext): void {
  const w = ctx.window;
  if (!w) return;
  // Revert the previous line-feed: place next widget on same baseline.
  w.sameLine = true;
  w.cursor.y -= w.lastRowH ?? 0;
  w.cursor.y -= ITEM_SPACING_Y;
  if (w.sameLineX !== null) w.cursor.x = w.sameLineX;
}

// Attach lastRowH marker to WindowState dynamically.
declare module './runtime' {
  interface WindowState { lastRowH?: number; }
}

export function separator(ctx: ImGuiContext): void {
  const w = ctx.window;
  if (!w) return;
  const y = w.cursor.y + 4;
  ctx.addLine(
    w.rect.x + PAD_X, y,
    w.rect.x + w.rect.w - PAD_X, y,
    ctx.theme.Separator,
  );
  w.cursor.y += 10;
}

export function spacing(ctx: ImGuiContext, px = 8): void {
  const w = ctx.window;
  if (!w) return;
  w.cursor.y += px;
}

export function indent(ctx: ImGuiContext, px = 14): void {
  const w = ctx.window;
  if (!w) return;
  w.indent += px;
}
export function unindent(ctx: ImGuiContext, px = 14): void {
  const w = ctx.window;
  if (!w) return;
  w.indent = Math.max(0, w.indent - px);
}

export function newLine(ctx: ImGuiContext): void {
  const w = ctx.window;
  if (!w) return;
  w.cursor.y += 14;
}

/* ---- Text ---------------------------------------------------------- */

export function text(ctx: ImGuiContext, s: string, color?: string): void {
  const w = ctx.window;
  if (!w) return;
  const width = Math.min(ctx.measureText(s), w.rect.w - 2 * PAD_X);
  const h = 16;
  const { x, y } = advanceCursor(ctx, width, h);
  ctx.addText(x, y, s, color ?? ctx.theme.Text);
  w.lastRowH = h;
}

export function textDim(ctx: ImGuiContext, s: string): void { text(ctx, s, ctx.theme.TextDim); }

export function heading(ctx: ImGuiContext, s: string): void {
  const w = ctx.window;
  if (!w) return;
  const h = 22;
  const { x, y } = advanceCursor(ctx, ctx.measureText(s, HEADING_FONT), h);
  ctx.addText(x, y, s, ctx.theme.Text, HEADING_FONT);
  w.lastRowH = h;
}

export function mono(ctx: ImGuiContext, s: string, color?: string): void {
  const w = ctx.window;
  if (!w) return;
  const h = 16;
  const { x, y } = advanceCursor(ctx, ctx.measureText(s, MONO_FONT), h);
  ctx.addText(x, y, s, color ?? ctx.theme.TextDim, MONO_FONT);
  w.lastRowH = h;
}

/* ---- Button -------------------------------------------------------- */

export type ButtonTone = 'default' | 'danger' | 'accent';

export function button(ctx: ImGuiContext, label: string, tone: ButtonTone = 'default'): boolean {
  const w = ctx.window;
  if (!w) return false;
  const id  = ctx.pushId(`btn:${label}`);
  ctx.popId();   // keep hash stable but don't leak push/pop imbalance
  const textW = ctx.measureText(label);
  const rect: Rect = {
    x: w.sameLine && w.sameLineX !== null ? w.sameLineX : w.rect.x + PAD_X + w.indent,
    y: w.cursor.y,
    w: textW + BUTTON_PAD_X * 2,
    h: 16 + BUTTON_PAD_Y * 2,
  };
  advanceCursor(ctx, rect.w, rect.h);

  const beh = ctx.buttonBehavior(id, rect);
  const base    = tone === 'danger' ? ctx.theme.ButtonDanger      :
                  tone === 'accent' ? ctx.theme.ButtonAccent      :
                                      ctx.theme.Button;
  const hovered = tone === 'danger' ? ctx.theme.ButtonDangerHover :
                  tone === 'accent' ? ctx.theme.ButtonAccentHover :
                                      ctx.theme.ButtonHovered;
  const color   = beh.held ? ctx.theme.ButtonActive : beh.hovered ? hovered : base;

  ctx.addRect(rect, color, undefined, 0, 4);
  ctx.addText(rect.x + rect.w / 2, rect.y + rect.h / 2, label, ctx.theme.Text, DEFAULT_FONT, 'middle', 'center');
  w.lastRowH = rect.h;
  return beh.clicked;
}

/* ---- Selectable (list row) ----------------------------------------- */

export function selectable(
  ctx: ImGuiContext, label: string, selected: boolean, width?: number,
): boolean {
  const w = ctx.window;
  if (!w) return false;
  const id = ctx.pushId(`sel:${label}`);
  ctx.popId();
  const rect: Rect = {
    x: w.rect.x + PAD_X + w.indent,
    y: w.cursor.y,
    w: width ?? (w.rect.w - 2 * PAD_X - w.indent),
    h: 22,
  };
  advanceCursor(ctx, rect.w, rect.h);

  const beh = ctx.buttonBehavior(id, rect);
  if (selected || beh.hovered || beh.held) {
    ctx.addRect(rect, selected ? ctx.theme.HeaderActive :
                       beh.held ? ctx.theme.HeaderActive :
                                  ctx.theme.HeaderHovered);
  }
  ctx.addText(rect.x + 6, rect.y + rect.h / 2, label, ctx.theme.Text, DEFAULT_FONT, 'middle');
  w.lastRowH = rect.h;
  return beh.clicked;
}

/* ---- Checkbox ------------------------------------------------------ */

export function checkbox(ctx: ImGuiContext, label: string, value: { value: boolean }): boolean {
  const w = ctx.window;
  if (!w) return false;
  const id = ctx.pushId(`chk:${label}`);
  ctx.popId();
  const h = 20;
  const boxSize = 14;
  const labelW  = ctx.measureText(label);
  const rect: Rect = {
    x: w.rect.x + PAD_X + w.indent,
    y: w.cursor.y,
    w: boxSize + 6 + labelW,
    h,
  };
  advanceCursor(ctx, rect.w, rect.h);
  const beh = ctx.buttonBehavior(id, rect);
  if (beh.clicked) value.value = !value.value;

  const boxRect: Rect = { x: rect.x, y: rect.y + (h - boxSize) / 2, w: boxSize, h: boxSize };
  ctx.addRect(boxRect, ctx.theme.FrameBg, ctx.theme.Border, 1, 2);
  if (value.value) {
    // check mark (two strokes)
    ctx.addLine(boxRect.x + 3, boxRect.y + 7, boxRect.x + 6, boxRect.y + 10, ctx.theme.ButtonAccent, 2);
    ctx.addLine(boxRect.x + 6, boxRect.y + 10, boxRect.x + 11, boxRect.y + 4, ctx.theme.ButtonAccent, 2);
  }
  ctx.addText(rect.x + boxSize + 6, rect.y + h / 2, label, ctx.theme.Text, DEFAULT_FONT, 'middle');
  w.lastRowH = rect.h;
  return beh.clicked;
}

/* ---- Input Text ---------------------------------------------------- */

export interface InputTextRef { value: string; }

export interface InputTextOptions {
  width?:    number;
  password?: boolean;
  readonly?: boolean;
  placeholder?: string;
}

export function inputText(
  ctx: ImGuiContext, label: string, ref: InputTextRef, opts: InputTextOptions = {},
): boolean {
  const w = ctx.window;
  if (!w) return false;
  const id = ctx.pushId(`inp:${label}`);
  ctx.popId();
  const h = 26;
  const width = opts.width ?? Math.min(280, w.rect.w - 2 * PAD_X - w.indent);
  const labelW = ctx.measureText(label);
  const rect: Rect = {
    x: w.rect.x + PAD_X + w.indent + labelW + 8,
    y: w.cursor.y,
    w: width,
    h,
  };
  advanceCursor(ctx, width + labelW + 8, h);

  // Label
  ctx.addText(
    w.rect.x + PAD_X + w.indent, rect.y + h / 2, label,
    ctx.theme.TextDim, DEFAULT_FONT, 'middle',
  );

  // Text-input focus protocol differs from button: click inside sets focus,
  // click outside releases focus.  Focus persists on mouse-release.
  const hovered = ctx.mouseInRect(rect);
  if (hovered) ctx.hotId = id;
  if (ctx.input.mousePressed) {
    ctx.activeId = hovered ? id : (ctx.activeId === id ? null : ctx.activeId);
  }
  const focused = ctx.activeId === id;
  const bg      = focused ? ctx.theme.FrameBgActive : hovered ? ctx.theme.FrameBgHovered : ctx.theme.FrameBg;
  ctx.addRect(rect, bg, ctx.theme.Border, 1, 3);

  if (focused && !opts.readonly) {
    // Apply buffered text input to the value
    const txt = ctx.input.textInput;
    if (txt) ref.value += txt;
    // Backspace
    if (ctx.input.keysPressed.has('Backspace') && ref.value.length > 0) {
      ref.value = ref.value.slice(0, -1);
    }
  }

  const display = opts.password
    ? '•'.repeat(ref.value.length)
    : ref.value.length ? ref.value : (opts.placeholder ?? '');
  const color   = ref.value.length ? ctx.theme.Text : ctx.theme.TextDisabled;
  ctx.addText(rect.x + 8, rect.y + h / 2, display, color, DEFAULT_FONT, 'middle');

  // Caret
  if (focused && !opts.readonly && Math.floor(performance.now() / 500) % 2 === 0) {
    const caretX = rect.x + 8 + ctx.measureText(display);
    ctx.addLine(caretX, rect.y + 4, caretX, rect.y + rect.h - 4, ctx.theme.Text, 1);
  }

  w.lastRowH = rect.h;
  return focused;
}

/* ---- Table --------------------------------------------------------- */

export interface TableColumn { key: string; header: string; width?: number; }

export interface TableHandle {
  rect:       Rect;
  columns:    TableColumn[];
  columnX:    number[];
  rowY:       number;
  rowIndex:   number;
  zebra:      boolean;
  id:         number;
}

export function beginTable(
  ctx: ImGuiContext, id: string, columns: TableColumn[], height?: number,
): TableHandle | null {
  const w = ctx.window;
  if (!w) return null;
  const tableId = ctx.pushId(`tbl:${id}`);
  ctx.popId();

  const totalW = w.rect.w - 2 * PAD_X - w.indent;
  // Distribute widths: use explicit widths first, divide remainder equally.
  const explicit = columns.reduce((a, c) => a + (c.width ?? 0), 0);
  const unsized  = columns.filter((c) => !c.width).length;
  const share    = unsized > 0 ? Math.max(60, Math.floor((totalW - explicit) / unsized)) : 0;

  const columnX: number[] = [];
  let cx = w.rect.x + PAD_X + w.indent;
  for (const col of columns) {
    columnX.push(cx);
    cx += col.width ?? share;
  }
  columnX.push(cx);   // sentinel right edge

  // Header row
  const rect: Rect = { x: w.rect.x + PAD_X + w.indent, y: w.cursor.y, w: totalW, h: TABLE_ROW_H };
  ctx.addRect(rect, ctx.theme.TableHeader);
  for (let i = 0; i < columns.length; i++) {
    ctx.addText(columnX[i] + 8, rect.y + rect.h / 2, columns[i].header,
                ctx.theme.TextDim, DEFAULT_FONT, 'middle');
  }
  ctx.addLine(rect.x, rect.y + rect.h, rect.x + rect.w, rect.y + rect.h, ctx.theme.TableBorder);

  const handle: TableHandle = {
    rect,
    columns,
    columnX,
    rowY:     rect.y + TABLE_ROW_H,
    rowIndex: 0,
    zebra:    true,
    id: tableId,
  };
  return handle;
}

export function tableRow(
  ctx: ImGuiContext, t: TableHandle, cells: Array<string | number | null | undefined>,
): { hovered: boolean; clicked: boolean } {
  const rowRect: Rect = { x: t.rect.x, y: t.rowY, w: t.rect.w, h: TABLE_ROW_H };
  const alt = t.zebra && t.rowIndex % 2 === 1;
  if (alt) ctx.addRect(rowRect, ctx.theme.TableRowAlt);
  for (let i = 0; i < t.columns.length && i < cells.length; i++) {
    const val = cells[i];
    ctx.addText(
      t.columnX[i] + 8,
      t.rowY + TABLE_ROW_H / 2,
      val === null || val === undefined ? '—' : String(val),
      ctx.theme.Text, DEFAULT_FONT, 'middle',
      undefined,
      (t.columnX[i + 1] - t.columnX[i]) - 16,
    );
  }
  const rowId = ctx.pushId(`row:${t.id}:${t.rowIndex}`);
  ctx.popId();
  const beh = ctx.buttonBehavior(rowId, rowRect);
  if (beh.hovered) ctx.addRect(rowRect, ctx.theme.HeaderHovered);
  t.rowY     += TABLE_ROW_H;
  t.rowIndex += 1;
  return { hovered: beh.hovered, clicked: beh.clicked };
}

export function endTable(ctx: ImGuiContext, t: TableHandle): void {
  const w = ctx.window;
  if (!w) return;
  const consumed = t.rowY - t.rect.y;
  w.cursor.y = t.rect.y + consumed + 4;
  w.lastRowH = consumed;
}

/* ---- Divider / alert ---------------------------------------------- */

export function banner(ctx: ImGuiContext, message: string, kind: 'ok' | 'warn' | 'fail' = 'ok'): void {
  const w = ctx.window;
  if (!w) return;
  const h = 28;
  const rect: Rect = {
    x: w.rect.x + PAD_X,
    y: w.cursor.y,
    w: w.rect.w - 2 * PAD_X,
    h,
  };
  const bg = kind === 'fail' ? ctx.theme.Fail : kind === 'warn' ? ctx.theme.Warn : ctx.theme.Ok;
  ctx.addRect(rect, bg + '66');   // 40% alpha over base
  ctx.addText(rect.x + 12, rect.y + h / 2, message, ctx.theme.Text, DEFAULT_FONT, 'middle');
  w.cursor.y += h + ITEM_SPACING_Y;
  w.lastRowH = h;
}

/* ---- Menu bar ----------------------------------------------------- */

export interface MenuItem { label: string; accelerator?: string; onClick: () => void; }

export function menuBar(ctx: ImGuiContext, rect: Rect, items: MenuItem[]): void {
  ctx.addRect(rect, ctx.theme.TitleBg);
  let x = rect.x + PAD_X;
  for (const item of items) {
    const w = ctx.measureText(item.label) + 16;
    const r: Rect = { x, y: rect.y, w, h: rect.h };
    const id = ctx.pushId(`menu:${item.label}`);
    ctx.popId();
    const beh = ctx.buttonBehavior(id, r);
    if (beh.hovered) ctx.addRect(r, ctx.theme.ButtonHovered);
    ctx.addText(x + 8, rect.y + rect.h / 2, item.label, ctx.theme.Text, DEFAULT_FONT, 'middle');
    if (item.accelerator) {
      ctx.addText(
        x + w - 8, rect.y + rect.h / 2, item.accelerator,
        ctx.theme.TextDim, DEFAULT_FONT, 'middle', 'right',
      );
    }
    if (beh.clicked) item.onClick();
    x += w;
  }
  ctx.addLine(rect.x, rect.y + rect.h, rect.x + rect.w, rect.y + rect.h, ctx.theme.Border);
}
