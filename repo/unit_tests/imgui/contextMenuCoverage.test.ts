import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/* =========================================================================
 * Right-click context-menu coverage — static assertion that every table
 * view wires the menu + deep-copy helpers.  A full runtime hit-test
 * already exists in contextMenu.test.ts against a headless canvas.
 * ========================================================================= */

const ROOT = path.resolve(__dirname, '../..');

const VIEWS_WITH_MENUS = [
  'src/renderer/imgui/views/contracts.ts',
  'src/renderer/imgui/views/reviews.ts',
  'src/renderer/imgui/views/audit.ts',
  'src/renderer/imgui/views/routing.ts',
];

describe('Context-menu + deep-copy wired on every row-table view', () => {
  for (const rel of VIEWS_WITH_MENUS) {
    it(`${rel} uses useContextMenu + drawMenu + copyRowAsTsv`, () => {
      const src = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src, `${rel}: missing useContextMenu`).toMatch(/useContextMenu\(/);
      expect(src, `${rel}: missing drawMenu`).toMatch(/drawMenu\(/);
      expect(src, `${rel}: missing copyRowAsTsv`).toMatch(/copyRowAsTsv\(/);
    });

    it(`${rel} opens the menu on rightPressed in the hovered row`, () => {
      const src = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src, `${rel}: missing rightPressed binding`).toMatch(/ctx\.input\.rightPressed/);
    });
  }
});
