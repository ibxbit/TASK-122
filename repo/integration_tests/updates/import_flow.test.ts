import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/* =========================================================================
 *  Update loader — integration flow:
 *    package dir → manifest signed → hashes verified → staged → promoted
 *    → registry pending queued.
 *  Electron's app.getPath('userData') is stubbed to a temp directory.
 * ========================================================================= */

// vi.mock is hoisted, so module-level `let USER_DATA` would be undefined
// when the factory runs.  Hoist the path creation into the factory closure
// itself — fs.mkdtempSync is synchronous so we can keep the factory sync.
const userDataHolder = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- top of factory, no ESM import yet
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');
  return { path: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'lh-userdata-')) };
});

vi.mock('electron', () => ({
  app: {
    getPath: (_k: string) => userDataHolder.path,
    getVersion: () => '1.0.0',
  },
}));

import { importPackage, UpdateLoadError } from '../../src/main/updates/loader';

describe('importPackage() flow', () => {
  let pkgDir: string;
  let publicKeyPem: string;

  beforeEach(async () => {
    pkgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lh-pkg-'));
  });
  afterEach(async () => {
    await fs.rm(pkgDir, { recursive: true, force: true });
  });

  async function buildPackage(version: string, minFrom?: string) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const fileBody = Buffer.from(`payload for ${version}`);
    await fs.mkdir(path.join(pkgDir, 'payload'), { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'payload', 'app.txt'), fileBody);

    const manifest: any = {
      name: 'lh', version, issuer: 'LH',
      generatedAt: new Date().toISOString(),
      payloadFiles: [{
        path: 'app.txt',
        sha256: crypto.createHash('sha256').update(fileBody).digest('hex'),
        size_bytes: fileBody.length,
      }],
    };
    if (minFrom) manifest.minFromVersion = minFrom;

    const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(pkgDir, 'manifest.json'), manifestBuf);
    await fs.writeFile(path.join(pkgDir, 'signature.bin'),
      crypto.sign('RSA-SHA256', manifestBuf, privateKey));
  }

  it('imports a valid newer package', async () => {
    await buildPackage('2.0.0');
    const r = await importPackage({
      packagePath: pkgDir, publicKeyPem, currentAppVersion: '1.0.0',
    });
    expect(r.installedVersion).toBe('2.0.0');
  });

  it('rejects packages not newer than current', async () => {
    await buildPackage('1.0.0');
    await expect(importPackage({
      packagePath: pkgDir, publicKeyPem, currentAppVersion: '1.0.0',
    })).rejects.toBeInstanceOf(UpdateLoadError);
  });

  it('rejects packages whose minFromVersion is above current', async () => {
    await buildPackage('3.0.0', '2.5.0');
    await expect(importPackage({
      packagePath: pkgDir, publicKeyPem, currentAppVersion: '2.0.0',
    })).rejects.toThrow(/min_version_not_met/);
  });
});
