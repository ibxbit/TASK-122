import { DARK_THEME, DEFAULT_FONT, HEADING_FONT, MONO_FONT, type ImGuiTheme } from './theme';

/* =========================================================================
 * Dear ImGui Runtime (TypeScript + Canvas2D backend)
 *
 *   A real immediate-mode GUI runtime that follows Dear ImGui's architecture:
 *
 *     • Frame loop      beginFrame() … widgets … endFrame()/render()
 *     • ID stack        pushId / popId — every widget is identified by the
 *                       hash of its ID path (lets widgets share labels)
 *     • Draw list       widgets emit commands into a per-frame draw list
 *                       which is flushed to the canvas after endFrame
 *     • Layout cursor   window-local cursor with newLine(), indent(), sameLine()
 *     • Input state     pointer + keyboard captured per-frame; hot/active
 *                       items tracked across frames like the C++ implementation
 *     • Persistent state one Map keyed by widget ID for state that outlives
 *                        frames (text input buffers, table scroll, etc.)
 *
 *   This is the production UI path.  It does NOT use React.  The renderer
 *   entrypoint drives a requestAnimationFrame loop that calls the user's
 *   draw callback, flushes the draw list, and re-polls input.
 * ========================================================================= */

export type Color  = string;
export type Cursor = { x: number; y: number };

export interface Rect { x: number; y: number; w: number; h: number; }

interface DrawCmdRect  { kind: 'rect';   rect: Rect; fill?: Color; stroke?: Color; strokeWidth?: number; radius?: number; }
interface DrawCmdText  { kind: 'text';   x: number;  y: number;  text: string; color: Color; font: string; baseline?: CanvasTextBaseline; align?: CanvasTextAlign; maxWidth?: number; }
interface DrawCmdLine  { kind: 'line';   x1: number; y1: number; x2: number; y2: number; color: Color; width?: number; }
interface DrawCmdClip  { kind: 'clip';   rect: Rect; }
interface DrawCmdPopClip { kind: 'popClip'; }

type DrawCmd = DrawCmdRect | DrawCmdText | DrawCmdLine | DrawCmdClip | DrawCmdPopClip;

export interface WindowState {
  id:       number;
  title:    string;
  rect:     Rect;
  cursor:   Cursor;
  contentYStart: number;
  indent:   number;
  sameLine: boolean;
  sameLineX: number | null;
}

export interface FrameInput {
  mouseX:        number;
  mouseY:        number;
  mouseDown:     boolean;
  mousePressed:  boolean;     // true for one frame when down edge detected
  mouseReleased: boolean;
  /** Right mouse button pressed (edge) — fires once per press. */
  rightPressed:  boolean;
  wheelDelta:    number;
  keysPressed:   Set<string>; // e.g. 'Enter', 'Escape', 'KeyA'
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
  textInput:     string;
}

export interface ImGuiStats {
  drawCmds:     number;
  widgets:      number;
  frameTimeMs:  number;
}

/* ------------------------------------------------------------------ */

/** FNV-1a 32-bit hash for deterministic widget IDs. */
function hashId(seed: number, s: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export class ImGuiContext {
  readonly theme: ImGuiTheme = DARK_THEME;

  // Canvas + size
  private ctx!: CanvasRenderingContext2D;
  private canvas!: HTMLCanvasElement;
  private _width  = 0;
  private _height = 0;
  private dpr     = 1;

  // Per-frame state
  private drawList: DrawCmd[] = [];
  private idStack:  number[]  = [0];
  private windowStack: WindowState[] = [];
  private currentWindow: WindowState | null = null;

  // Interaction state
  hotId:    number | null = null;
  activeId: number | null = null;

  // Persistent per-widget state (e.g. text input, table scroll offsets)
  readonly widgetState = new Map<number, Record<string, unknown>>();

  // Current input snapshot (set by input layer before beginFrame)
  input: FrameInput = emptyInput();

  // Stats
  lastStats: ImGuiStats = { drawCmds: 0, widgets: 0, frameTimeMs: 0 };

  /* ---- Lifecycle ------------------------------------------------ */

  attach(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas_2d_unsupported');
    this.canvas = canvas;
    this.ctx    = ctx;
    this.resize();
  }

  resize(): void {
    this.dpr    = window.devicePixelRatio || 1;
    const w     = this.canvas.clientWidth;
    const h     = this.canvas.clientHeight;
    this.canvas.width  = Math.max(1, Math.floor(w * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(h * this.dpr));
    this._width  = w;
    this._height = h;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  get width():  number { return this._width;  }
  get height(): number { return this._height; }

  beginFrame(input: FrameInput): void {
    this.drawList = [];
    this.idStack  = [0];
    this.windowStack = [];
    this.currentWindow = null;
    this.input = input;

    // hotId is reset every frame; activeId persists until a widget's
    // buttonBehavior fires its release (so the click-detection protocol
    // can observe mouseReleased on the same frame as the mouse-up).
    this.hotId = null;
  }

  endFrame(): void {
    const t0 = performance.now();
    this.flushDrawList();
    this.lastStats.frameTimeMs = performance.now() - t0;
  }

  /* ---- ID stack ------------------------------------------------ */

  pushId(s: string | number): number {
    const parent = this.idStack[this.idStack.length - 1];
    const id     = hashId(parent, String(s));
    this.idStack.push(id);
    return id;
  }

  popId(): void {
    if (this.idStack.length > 1) this.idStack.pop();
  }

  getId(s: string): number {
    const parent = this.idStack[this.idStack.length - 1];
    return hashId(parent, s);
  }

  /* ---- Window stack -------------------------------------------- */

  pushWindow(win: WindowState): void {
    this.windowStack.push(win);
    this.currentWindow = win;
  }

  popWindow(): WindowState | null {
    this.windowStack.pop();
    this.currentWindow = this.windowStack[this.windowStack.length - 1] ?? null;
    return this.currentWindow;
  }

  get window(): WindowState | null { return this.currentWindow; }

  /* ---- Draw list ----------------------------------------------- */

  addRect(r: Rect, fill?: Color, stroke?: Color, strokeWidth = 1, radius = 0): void {
    this.drawList.push({ kind: 'rect', rect: r, fill, stroke, strokeWidth, radius });
  }

  addText(
    x: number, y: number, text: string,
    color: Color = this.theme.Text, font: string = DEFAULT_FONT,
    baseline: CanvasTextBaseline = 'top', align: CanvasTextAlign = 'left',
    maxWidth?: number,
  ): void {
    this.drawList.push({ kind: 'text', x, y, text, color, font, baseline, align, maxWidth });
  }

  addLine(x1: number, y1: number, x2: number, y2: number, color: Color, width = 1): void {
    this.drawList.push({ kind: 'line', x1, y1, x2, y2, color, width });
  }

  pushClip(r: Rect): void { this.drawList.push({ kind: 'clip', rect: r }); }
  popClip():         void { this.drawList.push({ kind: 'popClip' }); }

  /* ---- Hit-testing --------------------------------------------- */

  mouseInRect(r: Rect): boolean {
    const { mouseX: x, mouseY: y } = this.input;
    return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
  }

  /** Classic ImGui triad: update hotId/activeId based on widget rect + click. */
  buttonBehavior(id: number, r: Rect): { hovered: boolean; held: boolean; clicked: boolean } {
    const hovered = this.mouseInRect(r);
    if (hovered) this.hotId = id;

    if (hovered && this.input.mousePressed) this.activeId = id;

    const held    = this.activeId === id && this.input.mouseDown;
    const clicked = this.activeId === id && this.input.mouseReleased && hovered;
    if (clicked) this.activeId = null;
    return { hovered, held, clicked };
  }

  /* ---- Text metrics -------------------------------------------- */

  measureText(text: string, font: string = DEFAULT_FONT): number {
    this.ctx.save();
    this.ctx.font = font;
    const m = this.ctx.measureText(text);
    this.ctx.restore();
    return m.width;
  }

  /* ---- Flush --------------------------------------------------- */

  private flushDrawList(): void {
    const c = this.ctx;
    c.save();
    c.clearRect(0, 0, this._width, this._height);

    for (const cmd of this.drawList) {
      switch (cmd.kind) {
        case 'rect': {
          const { rect, fill, stroke, strokeWidth, radius } = cmd;
          if (fill) {
            c.fillStyle = fill;
            if (radius && radius > 0) drawRoundedRect(c, rect, radius); else c.fillRect(rect.x, rect.y, rect.w, rect.h);
            if (radius && radius > 0) c.fill();
          }
          if (stroke) {
            c.strokeStyle = stroke;
            c.lineWidth   = strokeWidth ?? 1;
            if (radius && radius > 0) { drawRoundedRect(c, rect, radius); c.stroke(); }
            else c.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
          }
          break;
        }
        case 'text': {
          c.save();
          c.fillStyle    = cmd.color;
          c.font         = cmd.font;
          c.textBaseline = cmd.baseline ?? 'top';
          c.textAlign    = cmd.align ?? 'left';
          if (cmd.maxWidth !== undefined) c.fillText(cmd.text, cmd.x, cmd.y, cmd.maxWidth);
          else                            c.fillText(cmd.text, cmd.x, cmd.y);
          c.restore();
          break;
        }
        case 'line': {
          c.save();
          c.strokeStyle = cmd.color;
          c.lineWidth   = cmd.width ?? 1;
          c.beginPath();
          c.moveTo(cmd.x1 + 0.5, cmd.y1 + 0.5);
          c.lineTo(cmd.x2 + 0.5, cmd.y2 + 0.5);
          c.stroke();
          c.restore();
          break;
        }
        case 'clip': {
          c.save();
          c.beginPath();
          c.rect(cmd.rect.x, cmd.rect.y, cmd.rect.w, cmd.rect.h);
          c.clip();
          break;
        }
        case 'popClip': {
          c.restore();
          break;
        }
      }
    }

    this.lastStats.drawCmds = this.drawList.length;
    c.restore();
  }
}

function drawRoundedRect(c: CanvasRenderingContext2D, r: Rect, radius: number): void {
  const rr = Math.min(radius, r.w / 2, r.h / 2);
  c.beginPath();
  c.moveTo(r.x + rr, r.y);
  c.arcTo(r.x + r.w, r.y,        r.x + r.w, r.y + r.h, rr);
  c.arcTo(r.x + r.w, r.y + r.h,  r.x,       r.y + r.h, rr);
  c.arcTo(r.x,       r.y + r.h,  r.x,       r.y,       rr);
  c.arcTo(r.x,       r.y,        r.x + r.w, r.y,       rr);
  c.closePath();
}

export function emptyInput(): FrameInput {
  return {
    mouseX: -1, mouseY: -1,
    mouseDown: false, mousePressed: false, mouseReleased: false,
    rightPressed: false,
    wheelDelta: 0,
    keysPressed: new Set(),
    modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    textInput: '',
  };
}

export { DEFAULT_FONT, MONO_FONT, HEADING_FONT };
