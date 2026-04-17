import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { logger } from '../logger';
import {
  readAndVerifyManifest,
  verifyManifestHashes,
  compareVersions,
  type PackageManifest,
} from './signature';
import {
  readRegistry, writeRegistry,
  stagingDir, versionsDir, updatesDir,
  type VersionEntry,
} from './rollback';

/* =========================================================================
 * Update Loader
 *
 *  importPackage(opts) executes the full admin-triggered install flow:
 *
 *    1. Read + RSA-SHA256-verify manifest.json / signature.bin
 *    2. Check manifest.minFromVersion against running app version
 *    3. Reject non-newer installs  (version <= current)
 *    4. SHA-256-check every payload file listed in the manifest
 *    5. Copy payload + manifest + signature into  updates/staging/<ver>/
 *    6. Atomically rename staging/<ver> → versions/<ver>
 *    7. Append VersionEntry + queue pending.install in the registry
 *
 *  The actual filesystem swap of live app files is the platform bootstrap's
 *  job — this module records the intent and verifies every trust boundary.
 *
 *  Admin gating belongs to the IPC layer:
 *     registerGuarded('updates:import',
 *                     { permission: 'system.update', type: 'api', action: 'write' },
 *                     (ctx, payload) => importPackage({ ...payload, requestedBy: ctx.userId }))
 * ========================================================================= */

export interface ImportOptions {
  packagePath:         string;         // directory containing manifest.json + signature.bin + payload/
  publicKeyPem:        string;         // bundled at build time in resources/public-key.pem
  requestedBy?:        string;
  currentAppVersion?:  string;         // defaults to app.getVersion()
}

export interface ImportResult {
  installedVersion:  string;
  installedPath:     string;
  fromVersion:       string;
  manifest:          PackageManifest;
  durationMs:        number;
}

export class UpdateLoadError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(`update_load:${code}${detail ? `:${detail}` : ''}`);
    this.name = 'UpdateLoadError';
  }
}

export async function importPackage(opts: ImportOptions): Promise<ImportResult> {
  const started = Date.now();

  // ── 1. Signature → parsed manifest ─────────────────────────────────────
  const manifest = await readAndVerifyManifest(opts.packagePath, opts.publicKeyPem);

  // ── 2. Version gates ──────────────────────────────────────────────────
  const currentAppVersion = opts.currentAppVersion ?? app.getVersion();
  if (manifest.minFromVersion &&
      compareVersions(currentAppVersion, manifest.minFromVersion) < 0) {
    throw new UpdateLoadError(
      'min_version_not_met',
      `need ≥ ${manifest.minFromVersion}, have ${currentAppVersion}`,
    );
  }
  if (compareVersions(manifest.version, currentAppVersion) <= 0) {
    throw new UpdateLoadError(
      'not_newer',
      `package ${manifest.version} ≤ current ${currentAppVersion}`,
    );
  }

  // ── 3. Payload hash verification ──────────────────────────────────────
  await verifyManifestHashes(opts.packagePath, manifest);

  // ── 4. Registry guard — reject duplicate install ──────────────────────
  const reg = await readRegistry();
  if (reg.installedVersions.some((v) => v.version === manifest.version)) {
    throw new UpdateLoadError('version_already_installed', manifest.version);
  }

  // ── 5. Stage to `updates/staging/<ver>/` ──────────────────────────────
  await fs.mkdir(stagingDir(),  { recursive: true });
  await fs.mkdir(versionsDir(), { recursive: true });

  const staging  = path.join(stagingDir(),  manifest.version);
  const finalDir = path.join(versionsDir(), manifest.version);

  await rmRf(staging);                                   // reset any prior failure
  await copyDir(path.join(opts.packagePath, 'payload'),      path.join(staging, 'payload'));
  await fs.copyFile(path.join(opts.packagePath, 'manifest.json'),  path.join(staging, 'manifest.json'));
  await fs.copyFile(path.join(opts.packagePath, 'signature.bin'),  path.join(staging, 'signature.bin'));

  // ── 6. Atomic promotion (same filesystem) ────────────────────────────
  await fs.rename(staging, finalDir);

  // ── 7. Registry append + pending.install ─────────────────────────────
  const entry: VersionEntry = {
    version:          manifest.version,
    path:             path.relative(updatesDir(), finalDir),
    installedAt:      new Date().toISOString(),
    installedBy:      opts.requestedBy,
    previousVersion:  reg.currentVersion ?? undefined,
    manifestName:     manifest.name,
    issuer:           manifest.issuer,
  };
  reg.installedVersions.push(entry);
  reg.pending = {
    action:       'install',
    version:      manifest.version,
    targetPath:   finalDir,
    fromVersion:  reg.currentVersion ?? currentAppVersion,
    requestedAt:  new Date().toISOString(),
    requestedBy:  opts.requestedBy,
  };
  await writeRegistry(reg);

  const result: ImportResult = {
    installedVersion: manifest.version,
    installedPath:    finalDir,
    fromVersion:      reg.currentVersion ?? currentAppVersion,
    manifest,
    durationMs:       Date.now() - started,
  };
  logger.info(
    { version: result.installedVersion, from: result.fromVersion, ms: result.durationMs, by: opts.requestedBy },
    'update_imported',
  );
  return result;
}

/* ------------------------------------------------------------------ *
 *  Filesystem helpers                                                 *
 * ------------------------------------------------------------------ */

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isFile()) await fs.copyFile(s, d);
    // Symlinks intentionally excluded — updates ship only regular files.
  }
}

async function rmRf(p: string): Promise<void> {
  try { await fs.rm(p, { recursive: true, force: true }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
