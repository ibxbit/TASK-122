import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/* =========================================================================
 * DPI scaling — replaces MV-7 "high-DPI crisp rendering" manual step.
 *
 *  Static coverage of:
 *    1. enableHighDpi() appends the two Electron command-line switches the
 *       renderer depends on (high-dpi-support=1, force-device-scale-factor=1).
 *    2. ImGuiContext.resize() reads window.devicePixelRatio and resizes
 *       the backing buffer accordingly, so hairline borders stay crisp at
 *       200 % zoom without the widget code doing anything special.
 * ========================================================================= */

describe('enableHighDpi() — command-line switches', () => {
  const appended: Array<[string, string | undefined]> = [];

  beforeEach(() => {
    appended.length = 0;
    vi.resetModules();
  });

  it('sets high-dpi-support and force-device-scale-factor on app.commandLine', async () => {
    vi.doMock('electron', () => ({
      app: {
        commandLine: {
          appendSwitch: (name: string, value?: string) => { appended.push([name, value]); },
        },
      },
      BrowserWindow: class { static getAllWindows() { return []; } },
      screen: { getPrimaryDisplay: () => ({ workArea: { width: 1920, height: 1080, x: 0, y: 0 }, scaleFactor: 1 }) },
    }));
    const mod = await import('../../src/main/windows/WindowManager');
    mod.enableHighDpi();
    const names = appended.map(([n]) => n);
    expect(names).toContain('high-dpi-support');
    expect(names).toContain('force-device-scale-factor');
    const pair = Object.fromEntries(appended);
    expect(pair['high-dpi-support']).toBe('1');
    expect(pair['force-device-scale-factor']).toBe('1');
  });
});

describe('ImGuiContext.resize() — devicePixelRatio scaling', () => {
  it('scales the backing canvas buffer by devicePixelRatio while keeping CSS pixels constant', async () => {
    // Simulate a 200 % HiDPI display.
    (globalThis as { window?: unknown }).window = {
      devicePixelRatio: 2,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const transformCalls: number[][] = [];
    const canvas = {
      width: 0, height: 0,
      clientWidth: 800, clientHeight: 600,
      getContext: () => ({
        setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
          transformCalls.push([a, b, c, d, e, f]);
        },
        save: vi.fn(), restore: vi.fn(), clearRect: vi.fn(),
        measureText: () => ({ width: 10 }),
      }),
    } as unknown as HTMLCanvasElement;

    const { ImGuiContext } = await import('../../src/renderer/imgui/runtime');
    const ctx = new ImGuiContext();
    ctx.attach(canvas);
    // Post-attach → resize() has run once.
    expect(canvas.width).toBe(800 * 2);
    expect(canvas.height).toBe(600 * 2);
    expect(ctx.width).toBe(800);     // CSS pixels unchanged
    expect(ctx.height).toBe(600);
    expect(transformCalls[0][0]).toBe(2);   // dpr scale on X
    expect(transformCalls[0][3]).toBe(2);   // dpr scale on Y
  });
});

describe('Minimum-size safeguards', () => {
  it('WindowManager sets a minimum 1024×720 on every BrowserWindow', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../src/main/windows/WindowManager.ts'), 'utf8',
    );
    expect(src).toMatch(/minWidth:\s*1024/);
    expect(src).toMatch(/minHeight:\s*720/);
  });
});
