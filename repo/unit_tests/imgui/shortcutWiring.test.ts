import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/* =========================================================================
 * Renderer wiring for shortcut:search + shortcut:export + checkpoint:*.
 *
 *  bootImGuiApp must register IPC listeners for all four channels and must
 *  call bridge.send('checkpoint:provide', ...) at least once per draw loop
 *  after the debounce window has elapsed.  We statically verify the source
 *  here to keep the contract fixed even if the frame loop is refactored.
 * ========================================================================= */

const APP_PATH        = path.resolve(__dirname, '../../src/renderer/imgui/app.ts');
const DASH_PATH       = path.resolve(__dirname, '../../src/renderer/imgui/views/dashboard.ts');
const CONTRACTS_PATH  = path.resolve(__dirname, '../../src/renderer/imgui/views/contracts.ts');
const AUDIT_PATH      = path.resolve(__dirname, '../../src/renderer/imgui/views/audit.ts');
const PALETTE_PATH    = path.resolve(__dirname, '../../src/renderer/imgui/views/search-palette.ts');

describe('app.ts shortcut + checkpoint wiring', () => {
  const src = readFileSync(APP_PATH, 'utf8');

  it('subscribes to shortcut:search', () => {
    expect(src).toMatch(/bridge\.on\(\s*'shortcut:search'/);
  });
  it('subscribes to shortcut:export', () => {
    expect(src).toMatch(/bridge\.on\(\s*'shortcut:export'/);
  });
  it('subscribes to checkpoint:restore', () => {
    expect(src).toMatch(/bridge\.on\(\s*'checkpoint:restore'/);
  });
  it('pushes checkpoint:provide from the frame loop', () => {
    expect(src).toMatch(/bridge\.send\(\s*'checkpoint:provide'/);
  });
  it('renders the search palette on top of signed-in views', () => {
    expect(src).toMatch(/drawSearchPalette/);
  });
});

describe('views consume the exportRequested flag', () => {
  for (const [label, file] of [
    ['dashboard', DASH_PATH],
    ['contracts', CONTRACTS_PATH],
    ['audit',     AUDIT_PATH],
  ] as const) {
    it(`${label} view reads state.exportRequested and clears it`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src, `${label}: must read exportRequested`).toMatch(/state\.exportRequested/);
      expect(src, `${label}: must clear the flag`).toMatch(/state\.exportRequested\s*=\s*false/);
    });
  }
});

describe('search palette responds to searchOpen + Escape', () => {
  const src = readFileSync(PALETTE_PATH, 'utf8');
  it('only renders when state.searchOpen is true', () => {
    expect(src).toMatch(/if\s*\(!state\.searchOpen\)\s*return/);
  });
  it('Escape closes the palette', () => {
    expect(src).toMatch(/keysPressed\.has\('Escape'\)/);
  });
  it('Enter on a single filtered match selects it', () => {
    expect(src).toMatch(/keysPressed\.has\('Enter'\)/);
  });
});

describe('main-process menu broadcasts the shortcut channels', () => {
  it('AppMenu binds Ctrl+K to shortcut:search and Ctrl+E to shortcut:export', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../src/main/shortcuts/AppMenu.ts'), 'utf8',
    );
    expect(src).toMatch(/broadcastToFocused\('shortcut:search'\)/);
    expect(src).toMatch(/broadcastToFocused\('shortcut:export'\)/);
  });
});
