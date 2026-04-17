import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/* =========================================================================
 * updates.handler — production-path edge-case coverage.
 *
 *  Each test drives the REAL handler registered via registerUpdatesHandlers,
 *  backed by an in-memory DB for the audit chain assertions and a fresh
 *  temp userData root so the registry writer is isolated per-test.
 *
 *  Covers:
 *    • manifest shape failures         → SignatureError surfaces to caller
 *    • missing signature / public key  → rejected
 *    • version gating (same / lower)   → rejected
 *    • rollback without installed ver  → RollbackError
 *    • cancelPending when nothing pending → no-op success
 *    • every write emits a chain-audited event
 * ========================================================================= */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

const userDataRoot = path.join(os.tmpdir(), `leasehub-updates-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, payload: unknown) => unknown) => handlers.set(ch, fn),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  app: {
    getPath:    (k: string) => k === 'userData' ? userDataRoot : userDataRoot,
    getVersion: () => '1.0.0',
    getAppPath: () => userDataRoot,
    whenReady:  () => Promise.resolve(),
  },
}));

import { makeTestDb, seedAccessGraph, type SeededIds } from '../_helpers/db';
import { initDbLifecycle } from '../../src/main/db/cleanup';
import { setSession, clearAllSessions } from '../../src/main/session';
import { registerUpdatesHandlers } from '../../src/main/ipc/updates.handler';

function invoke(channel: string, senderId: number, payload: unknown = {}): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no_handler_for:${channel}`);
  return fn({ sender: { id: senderId } }, payload);
}

function makeKeypair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

async function writePackage(root: string, manifestObj: unknown, signWith: string | null, payloadFiles: Array<{ rel: string; data: Buffer }> = []): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, 'payload'), { recursive: true });
  const manifestBytes = Buffer.from(JSON.stringify(manifestObj), 'utf8');
  await fs.writeFile(path.join(root, 'manifest.json'), manifestBytes);
  if (signWith !== null) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(manifestBytes); sign.end();
    await fs.writeFile(path.join(root, 'signature.bin'), sign.sign(signWith));
  }
  for (const f of payloadFiles) {
    const full = path.join(root, 'payload', f.rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, f.data);
  }
  return root;
}

describe('updates.handler — edge cases + audit emission', () => {
  let db: ReturnType<typeof makeTestDb>;
  let ids: SeededIds;
  const { publicKey, privateKey } = makeKeypair();

  beforeEach(async () => {
    db = makeTestDb();
    ids = seedAccessGraph(db);
    try { initDbLifecycle({ db }); } catch { /* already initialised */ }

    // Admin permissions for system.update / system.rollback
    db.prepare(`INSERT OR IGNORE INTO permissions (id, code, type, action, description) VALUES
      ('p_sys_update',   'system.update',   'api', 'write', 'Update'),
      ('p_sys_rollback', 'system.rollback', 'api', 'write', 'Rollback')`).run();
    db.prepare(`INSERT INTO role_permissions (role_id, permission_id, effect) VALUES
      ('role_tenant_admin', 'p_sys_update',   'allow'),
      ('role_tenant_admin', 'p_sys_rollback', 'allow')`).run();

    handlers.clear();
    clearAllSessions();
    registerUpdatesHandlers();
    setSession(77, {
      userId: ids.adminUserId, tenantId: ids.tenantId,
      roles: ['TenantAdmin'], loggedInAt: 0,
    });

    // Stub the bundled public key location expected by updates.handler.
    await fs.mkdir(userDataRoot, { recursive: true });
    await fs.writeFile(path.join(userDataRoot, 'public-key.pem'), publicKey, 'utf8');
  });

  afterEach(async () => {
    clearAllSessions();
    db.close();
    handlers.clear();
    try { await fs.rm(userDataRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('updates:registry returns a default shape when no packages installed', async () => {
    const reg = await invoke('updates:registry', 77, {}) as {
      currentVersion: string | null;
      installedVersions: unknown[];
      pending: unknown | null;
    };
    expect(reg.currentVersion).toBeNull();
    expect(Array.isArray(reg.installedVersions)).toBe(true);
    expect(reg.pending).toBeNull();
  });

  it('updates:versions returns an empty list before any imports', async () => {
    const vs = await invoke('updates:versions', 77, {}) as unknown[];
    expect(vs).toEqual([]);
  });

  it('updates:import rejects a manifest missing required fields', async () => {
    const pkgDir = path.join(userDataRoot, 'pkg-bad');
    await writePackage(pkgDir, { /* no name, no version, no issuer */ }, privateKey);

    await expect(
      Promise.resolve(invoke('updates:import', 77, { packagePath: pkgDir })),
    ).rejects.toThrow(/signature_error:manifest_missing_name|manifest_malformed/);
  });

  it('updates:import rejects when signature is missing', async () => {
    const pkgDir = path.join(userDataRoot, 'pkg-unsigned');
    await writePackage(pkgDir, {
      name: 'leasehub', version: '2.0.0', issuer: 'dev',
      generatedAt: new Date().toISOString(), payloadFiles: [],
    }, null);

    await expect(
      Promise.resolve(invoke('updates:import', 77, { packagePath: pkgDir })),
    ).rejects.toThrow(/signature_error:signature_missing/);
  });

  it('updates:import rejects a version equal to current (1.0.0)', async () => {
    const pkgDir = path.join(userDataRoot, 'pkg-same-ver');
    await writePackage(pkgDir, {
      name: 'leasehub', version: '1.0.0', issuer: 'dev',
      generatedAt: new Date().toISOString(), payloadFiles: [],
    }, privateKey);

    await expect(
      Promise.resolve(invoke('updates:import', 77, { packagePath: pkgDir })),
    ).rejects.toThrow(/update_load:not_newer/);
  });

  it('updates:import rejects when minFromVersion is unmet', async () => {
    const pkgDir = path.join(userDataRoot, 'pkg-min');
    await writePackage(pkgDir, {
      name: 'leasehub', version: '2.0.0', issuer: 'dev',
      generatedAt: new Date().toISOString(),
      minFromVersion: '9.9.9', payloadFiles: [],
    }, privateKey);

    await expect(
      Promise.resolve(invoke('updates:import', 77, { packagePath: pkgDir })),
    ).rejects.toThrow(/update_load:min_version_not_met/);
  });

  it('updates:rollback rejects when the target version is not installed', async () => {
    await expect(
      Promise.resolve(invoke('updates:rollback', 77, { targetVersion: '9.9.9' })),
    ).rejects.toThrow(/rollback_error:no_current_version|rollback_error:version_not_installed/);
  });

  it('updates:cancel is a safe no-op when nothing is pending', async () => {
    const r = await invoke('updates:cancel', 77, {}) as { ok: boolean };
    expect(r.ok).toBe(true);
    // And a chain-audited event is appended even for the no-op.
    const n = (db.prepare(`
      SELECT COUNT(*) AS n FROM audit_events WHERE action = 'system.pending_cancelled'
    `).get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('successful import appends a chain-audited system.update_imported event', async () => {
    const payloadBytes = Buffer.from('hello world', 'utf8');
    const sha = crypto.createHash('sha256').update(payloadBytes).digest('hex');
    const pkgDir = path.join(userDataRoot, 'pkg-good');
    await writePackage(pkgDir, {
      name: 'leasehub', version: '2.0.0', issuer: 'dev',
      generatedAt: new Date().toISOString(),
      payloadFiles: [{ path: 'app.txt', sha256: sha, size_bytes: payloadBytes.length }],
    }, privateKey, [{ rel: 'app.txt', data: payloadBytes }]);

    const r = await invoke('updates:import', 77, { packagePath: pkgDir }) as
      { installedVersion: string; fromVersion: string };
    expect(r.installedVersion).toBe('2.0.0');
    expect(r.fromVersion).toBe('1.0.0');

    // Audit trail
    const rows = db.prepare(`
      SELECT action, seq, hash_prev, hash_curr FROM audit_events
       WHERE action = 'system.update_imported' AND tenant_id = ?
    `).all(ids.tenantId) as Array<{ action: string; seq: number; hash_prev: string | null; hash_curr: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].seq).toBeGreaterThan(0);
    expect(rows[0].hash_curr).toMatch(/^[0-9a-f]{64}$/);
  });

  it('non-admin role is denied on updates:import', async () => {
    setSession(78, {
      userId: ids.opsUserId, tenantId: ids.tenantId,
      roles: ['OperationsManager'], loggedInAt: 0,
    });
    await expect(
      Promise.resolve(invoke('updates:import', 78, { packagePath: path.join(userDataRoot, 'whatever') })),
    ).rejects.toThrow(/access_denied/);
  });
});
