import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { logger } from '../logger';

/* =========================================================================
 * Version Registry + Rollback
 *
 *  Canonical store:   userData/updates/registry.json
 *  Per-version files: userData/updates/versions/<version>/
 *
 *  The registry is the authoritative record of what's installed and which
 *  version should be active on next launch.  It is never held in the DB —
 *  DB may itself live in a version-specific location, and the bootstrapper
 *  needs to read this registry BEFORE any other subsystem starts.
 *
 *  Lifecycle:
 *     importPackage()  →  appends a VersionEntry + queues pending.install
 *     rollbackTo()     →                           + queues pending.rollback
 *     applyPending()   →  called once at startup; flips currentVersion and
 *                         clears pending.  Returns the active entry so the
 *                         bootstrapper can load the right app.asar.
 * ========================================================================= */

export interface VersionEntry {
  version:          string;
  /** Path under `updates/` — relative to keep the registry portable. */
  path:             string;
  installedAt:      string;           // ISO-8601
  installedBy?:     string;
  previousVersion?: string;
  manifestName:     string;
  issuer:           string;
}

export interface PendingAction {
  action:       'install' | 'rollback';
  version:      string;
  targetPath:   string;               // absolute
  fromVersion:  string;
  requestedAt:  string;               // ISO-8601
  requestedBy?: string;
}

export interface Registry {
  currentVersion:    string | null;
  installedVersions: VersionEntry[];
  pending:           PendingAction | null;
}

const DEFAULT_REGISTRY: Registry = {
  currentVersion:    null,
  installedVersions: [],
  pending:           null,
};

export class RollbackError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(`rollback_error:${code}${detail ? `:${detail}` : ''}`);
    this.name = 'RollbackError';
  }
}

/* ------------------------------------------------------------------ *
 *  Paths                                                              *
 * ------------------------------------------------------------------ */

export function updatesDir():  string { return path.join(app.getPath('userData'), 'updates'); }
export function versionsDir(): string { return path.join(updatesDir(), 'versions'); }
export function stagingDir():  string { return path.join(updatesDir(), 'staging'); }
export function registryPath(): string { return path.join(updatesDir(), 'registry.json'); }

/* ------------------------------------------------------------------ *
 *  Registry I/O — atomic write (tmp + fsync + rename).               *
 * ------------------------------------------------------------------ */

export async function readRegistry(): Promise<Registry> {
  try {
    const raw = await fs.readFile(registryPath(), 'utf8');
    return normalise(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_REGISTRY };
    logger.warn({ err }, 'update_registry_read_failed');
    return { ...DEFAULT_REGISTRY };
  }
}

export async function writeRegistry(reg: Registry): Promise<void> {
  await fs.mkdir(updatesDir(), { recursive: true });
  const tmp = `${registryPath()}.tmp`;
  const fh  = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(reg, null, 2), 'utf8');
    await fh.sync();
  } finally { await fh.close(); }
  await fs.rename(tmp, registryPath());
}

function normalise(x: unknown): Registry {
  if (!x || typeof x !== 'object') return { ...DEFAULT_REGISTRY };
  const r = x as Record<string, unknown>;
  return {
    currentVersion:    typeof r.currentVersion === 'string' ? r.currentVersion : null,
    installedVersions: Array.isArray(r.installedVersions)   ? r.installedVersions as VersionEntry[] : [],
    pending:           r.pending && typeof r.pending === 'object'
                         ? r.pending as PendingAction
                         : null,
  };
}

/* ------------------------------------------------------------------ *
 *  Public API                                                         *
 * ------------------------------------------------------------------ */

export async function listInstalledVersions(): Promise<VersionEntry[]> {
  const reg = await readRegistry();
  return [...reg.installedVersions].sort(
    (a, b) => Date.parse(b.installedAt) - Date.parse(a.installedAt),
  );
}

export interface RollbackResult {
  targetVersion:  string;
  fromVersion:    string;
  targetPath:     string;
}

/**
 * Queue a rollback to a previously-installed version.
 * Admin gating belongs to the IPC layer — guard the handler with
 * `{ permission: 'system.rollback', type: 'api', action: 'write' }`.
 */
export async function rollbackTo(opts: {
  targetVersion: string;
  requestedBy?:  string;
}): Promise<RollbackResult> {
  const reg = await readRegistry();
  if (!reg.currentVersion)                          throw new RollbackError('no_current_version');
  if (reg.currentVersion === opts.targetVersion)    throw new RollbackError('already_current');

  const target = reg.installedVersions.find((v) => v.version === opts.targetVersion);
  if (!target)                                      throw new RollbackError('version_not_installed');

  const absPath = path.join(updatesDir(), target.path);
  try { await fs.access(absPath); }
  catch { throw new RollbackError('version_files_missing', absPath); }

  reg.pending = {
    action:       'rollback',
    version:      opts.targetVersion,
    targetPath:   absPath,
    fromVersion:  reg.currentVersion,
    requestedAt:  new Date().toISOString(),
    requestedBy:  opts.requestedBy,
  };
  await writeRegistry(reg);

  logger.warn(
    { from: reg.currentVersion, to: opts.targetVersion, by: opts.requestedBy },
    'rollback_queued',
  );
  return {
    targetVersion: opts.targetVersion,
    fromVersion:   reg.currentVersion,
    targetPath:    absPath,
  };
}

/** Abandon a queued install/rollback without touching installed files. */
export async function cancelPending(): Promise<void> {
  const reg = await readRegistry();
  if (!reg.pending) return;
  reg.pending = null;
  await writeRegistry(reg);
  logger.info('pending_cancelled');
}

export interface ApplyResult {
  active:       VersionEntry | null;
  switchedFrom: string | null;
  action:       PendingAction['action'] | null;
}

/**
 * Call ONCE at startup, before loading any app payload.
 *   - No pending  → returns currently-active version
 *   - Pending set → flips currentVersion, clears pending, returns new active
 *                   (filesystem swap is handled by the platform bootstrapper;
 *                   this module owns the registry of truth only)
 */
export async function applyPending(): Promise<ApplyResult> {
  const reg = await readRegistry();

  if (reg.pending) {
    const { action, version, fromVersion, targetPath } = reg.pending;

    try { await fs.access(targetPath); }
    catch { throw new RollbackError('pending_target_missing', targetPath); }

    reg.currentVersion = version;
    reg.pending = null;
    await writeRegistry(reg);

    logger.info({ version, fromVersion, action }, 'update_applied');
    const entry = reg.installedVersions.find((v) => v.version === version) ?? null;
    return { active: entry, switchedFrom: fromVersion, action };
  }

  const entry = reg.currentVersion
    ? reg.installedVersions.find((v) => v.version === reg.currentVersion) ?? null
    : null;
  return { active: entry, switchedFrom: null, action: null };
}
