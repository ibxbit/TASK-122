import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/* =========================================================================
 * View routing — static coverage for MV-2 "every window kind renders its
 * matching view".  Ensures the renderer bundle has:
 *
 *    - A view module for every declared WindowKind
 *    - app.ts wires each WindowKind to its view
 *    - index.html exposes the `#imgui-canvas` element the entrypoint needs
 * ========================================================================= */

const SRC       = path.resolve(__dirname, '../..');
const IMGUI_DIR = path.join(SRC, 'src/renderer/imgui');
const VIEWS     = path.join(IMGUI_DIR, 'views');

const EXPECTED_KINDS = ['dashboard', 'contracts', 'audit', 'reviews', 'routing', 'admin', 'login'];

describe('Dear ImGui view routing', () => {
  it('every declared WindowKind has a view file', () => {
    for (const kind of EXPECTED_KINDS) {
      expect(
        existsSync(path.join(VIEWS, `${kind}.ts`)),
        `missing view: imgui/views/${kind}.ts`,
      ).toBe(true);
    }
  });

  it('app.ts routes every WindowKind to its draw function', () => {
    const app = readFileSync(path.join(IMGUI_DIR, 'app.ts'), 'utf8');
    for (const kind of EXPECTED_KINDS) {
      if (kind === 'login') {
        // login is not a WindowKind — it's the pre-auth fallback.
        expect(app, 'app.ts must import drawLoginView').toMatch(/drawLoginView/);
        continue;
      }
      const fn = `draw${kind[0].toUpperCase()}${kind.slice(1)}View`;
      expect(app, `app.ts missing router entry for ${kind}: expected ${fn}`).toContain(fn);
    }
  });

  it('renderer main.ts whitelists each WindowKind from the URL query', () => {
    const main = readFileSync(path.join(SRC, 'src/renderer/main.ts'), 'utf8');
    for (const kind of EXPECTED_KINDS) {
      if (kind === 'login') continue;  // not URL-selectable
      expect(main, `main.ts must accept ?window=${kind}`).toContain(`'${kind}'`);
    }
  });

  it('index.html exposes #imgui-canvas and loads main.ts', () => {
    const html = readFileSync(path.join(SRC, 'src/renderer/index.html'), 'utf8');
    expect(html).toContain('id="imgui-canvas"');
    expect(html).toContain('./main.ts');
  });

  it('index.html ships a strict CSP that allows only self-origin resources', () => {
    const html = readFileSync(path.join(SRC, 'src/renderer/index.html'), 'utf8');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toMatch(/default-src\s+'self'/);
    expect(html).toMatch(/script-src\s+'self'/);
    expect(html).toMatch(/connect-src\s+'self'/);
  });
});
