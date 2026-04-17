import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import { DEMO_CREDENTIALS } from '../../src/main/db/demo-seed';

/* =========================================================================
 * README contract tests — replaces MV-level manual review for every
 * hard-gate item the audit flagged:
 *
 *   - Project type explicitly declared at top (`desktop`).
 *   - Quick Start contains literal `docker-compose up`.
 *   - Docker-only workflow (no `npm install` prerequisite language).
 *   - Every demo credential row in code is advertised in README.
 *
 *  Also checks docker-compose.yml declares LH_DEMO_SEED=1 so the
 *  documented credentials actually exist when the container comes up.
 * ========================================================================= */

const ROOT       = path.resolve(__dirname, '../..');
const README     = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const COMPOSE    = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');

describe('README hard-gate contract', () => {
  it('declares project type "desktop" near the top', () => {
    // Must appear in the first 400 characters so a strict scanner picks
    // it up without reading the whole file.
    const header = README.slice(0, 400);
    expect(header).toMatch(/Project type:\s*`?desktop`?/);
  });

  it('Quick Start uses the literal `docker-compose up` form', () => {
    expect(README).toContain('docker-compose up');
    // And does NOT prescribe the non-strict `docker compose up` form in
    // the Quick Start section (we checked all non-prose text above).
    const firstThousand = README.slice(0, 2000);
    // The prerequisites line mentions both spellings for compatibility;
    // we accept that line.  All other occurrences must be the hyphenated
    // form.  Count `docker compose ` (space-separated) outside the
    // prerequisites line.
    const spaceForm = firstThousand
      .split('\n')
      .filter((l) => !/Docker Compose plugin/.test(l))
      .filter((l) => /\bdocker compose \b/.test(l));
    expect(spaceForm).toEqual([]);
  });

  it('states Docker-only workflow (no host npm install prerequisite)', () => {
    // Reject prose that demands `npm install` as a prerequisite step.
    expect(README).not.toMatch(/prerequisite.*npm install/i);
    // Accept the explicit "No host Node.js installation is required"
    // declaration.
    expect(README).toMatch(/No host Node\.js installation is required/);
  });

  it('documents every demo credential in the code-level DEMO_CREDENTIALS list', () => {
    for (const c of DEMO_CREDENTIALS) {
      expect(README, `README must mention username ${c.username}`).toContain(c.username);
      expect(README, `README must mention password for ${c.username}`).toContain(c.password);
      expect(README, `README must list role ${c.role}`).toContain(c.role);
    }
    expect(README).toContain('t_default');
  });

  it('docker-compose.yml wires LH_DEMO_SEED=1 so documented credentials exist', () => {
    expect(COMPOSE).toMatch(/LH_DEMO_SEED=1/);
  });

  it('README includes verification + access steps after docker-compose up', () => {
    expect(README).toMatch(/docker-compose logs app/);
    expect(README).toMatch(/docker-compose exec app/);
  });
});
