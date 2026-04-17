import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImGuiContext, emptyInput, type Rect } from '../../src/renderer/imgui/runtime';
import { useContextMenu, drawMenu, cellsToTsv } from '../../src/renderer/imgui/context-menu';

/* =========================================================================
 * Context menu + deep clipboard TSV — immediate-mode widget tests.
 * ========================================================================= */

function makeCanvas(width = 800, height = 600): HTMLCanvasElement {
  const ctx: any = {
    setTransform: vi.fn(), save: vi.fn(), restore: vi.fn(), clearRect: vi.fn(),
    fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), arcTo: vi.fn(),
    closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), clip: vi.fn(), rect: vi.fn(),
    measureText: (s: string) => ({ width: s.length * 7 }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    textBaseline: 'top', textAlign: 'left',
  };
  const canvas = {
    width, height, clientWidth: width, clientHeight: height,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  (globalThis as { window?: unknown }).window = { devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  return canvas;
}

describe('useContextMenu + drawMenu', () => {
  let ctx: ImGuiContext;

  beforeEach(() => {
    ctx = new ImGuiContext();
    ctx.attach(makeCanvas());
  });

  it('opens at the requested anchor and closes on Escape', () => {
    ctx.beginFrame(emptyInput());
    const menu = useContextMenu(ctx, 'test');
    menu.open(120, 45);
    expect(menu.isOpen).toBe(true);
    expect(menu.anchor).toEqual({ x: 120, y: 45 });
    drawMenu(ctx, menu, [{ label: 'Approve', onClick: () => {} }]);
    ctx.endFrame();

    ctx.beginFrame({ ...emptyInput(), keysPressed: new Set(['Escape']) });
    drawMenu(ctx, menu, [{ label: 'Approve', onClick: () => {} }]);
    ctx.endFrame();

    expect(menu.isOpen).toBe(false);
  });

  it('click outside while open closes the menu', () => {
    ctx.beginFrame(emptyInput());
    const menu = useContextMenu(ctx, 'test2');
    menu.open(100, 100);
    drawMenu(ctx, menu, [{ label: 'Approve', onClick: () => {} }]);
    ctx.endFrame();

    // Mouse press outside the drawn rect → close
    ctx.beginFrame({ ...emptyInput(), mouseX: 1, mouseY: 1, mousePressed: true, mouseDown: true });
    drawMenu(ctx, menu, [{ label: 'Approve', onClick: () => {} }]);
    ctx.endFrame();

    expect(menu.isOpen).toBe(false);
  });

  it('clicking a menu item fires onClick and closes the menu', () => {
    ctx.beginFrame(emptyInput());
    const menu = useContextMenu(ctx, 'test3');
    menu.open(50, 50);
    let approved = false;
    drawMenu(ctx, menu, [
      { label: 'Approve', onClick: () => { approved = true; }, tone: 'accent' },
      { label: 'Reject',  onClick: () => {},                    tone: 'danger' },
    ]);
    ctx.endFrame();

    // Press on the first row (anchor 50,50; first item is at y ≈ 53)
    ctx.beginFrame({ ...emptyInput(), mouseX: 60, mouseY: 58, mouseDown: true, mousePressed: true });
    drawMenu(ctx, menu, [
      { label: 'Approve', onClick: () => { approved = true; }, tone: 'accent' },
      { label: 'Reject',  onClick: () => {},                    tone: 'danger' },
    ]);
    ctx.endFrame();
    // Release → buttonBehavior fires clicked
    ctx.beginFrame({ ...emptyInput(), mouseX: 60, mouseY: 58, mouseDown: false, mouseReleased: true });
    drawMenu(ctx, menu, [
      { label: 'Approve', onClick: () => { approved = true; }, tone: 'accent' },
      { label: 'Reject',  onClick: () => {},                    tone: 'danger' },
    ]);
    ctx.endFrame();

    expect(approved).toBe(true);
    expect(menu.isOpen).toBe(false);
  });
});

describe('cellsToTsv (deep clipboard)', () => {
  it('joins a single row with tabs', () => {
    expect(cellsToTsv([['a', 'b', 'c']])).toBe('a\tb\tc\r\n');
  });

  it('joins multiple rows with CRLF', () => {
    expect(cellsToTsv([['a', 'b'], ['c', 'd']])).toBe('a\tb\r\nc\td\r\n');
  });

  it('coerces null/undefined cells to empty strings', () => {
    expect(cellsToTsv([[null, undefined, 0]])).toBe('\t\t0\r\n');
  });

  it('sanitises embedded tabs + newlines to spaces so the grid stays valid', () => {
    expect(cellsToTsv([['a\tb\nc', 'ok']])).toBe('a b c\tok\r\n');
  });
});
