import { describe, expect, it } from 'vitest';
import { hashPassword, runExpiryScan } from '../../src/main/contracts/signing';
import { makeTestDb, seedAccessGraph } from '../_helpers/db';

/* =========================================================================
 *  Signing helpers — password hashing + expiry scan milestone logic.
 *  (Full signContract() flow requires Electron's BrowserWindow.printToPDF;
 *   that path is exercised by integration_tests/ with a PDF stub.)
 * ========================================================================= */

describe('hashPassword()', () => {
  it('produces a 32-byte hash + 16-byte salt (hex-encoded)', () => {
    const { hash, salt } = hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hash differs across invocations (salt changes)', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
  });
});

describe('runExpiryScan()', () => {
  function insertInstance(
    db: ReturnType<typeof makeTestDb>,
    id: string, tenantId: string, daysRemaining: number, status = 'active',
  ) {
    const tpl = `tpl_${id}`;
    db.prepare(`
      INSERT INTO contract_templates (id, tenant_id, code, name, version, body, variables, status, created_at, updated_at)
      VALUES (?, ?, 'c', 'n', 1, '', '{}', 'published', ?, ?)
    `).run(tpl, tenantId, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));

    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO contract_instances
        (id, tenant_id, template_id, instance_number, status, rendered_body, variables, effective_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '', '{}', ?, ?, ?)
    `).run(id, tenantId, tpl, `${id}-N`, status, now + daysRemaining * 86400, now, now);
  }

  it('fires the smallest applicable milestone once', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    insertInstance(db, 'ct_7', ids.tenantId, 6);     // ≤ 7 → should fire expiry_7
    const fired: string[] = [];
    const sink = {
      inApp: (n: any) => fired.push(n.kind + ':app'),
      tray:  (n: any) => fired.push(n.kind + ':tray'),
    };
    const n = runExpiryScan(db, sink);
    expect(n).toBe(1);
    expect(fired).toEqual(['expiry_7:app', 'expiry_7:tray']);

    // Running again must NOT fire again (dedupe via contract_notifications).
    const n2 = runExpiryScan(db, sink);
    expect(n2).toBe(0);
  });

  it('fires expiry_30 when more than 7 but ≤ 30 days remain', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    insertInstance(db, 'ct_30', ids.tenantId, 20);
    const fired: string[] = [];
    runExpiryScan(db, {
      inApp: (n: any) => fired.push(n.kind),
      tray:  () => {},
    });
    expect(fired).toEqual(['expiry_30']);
  });

  it('fires expiry_60 when > 30 and ≤ 60 days remain', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    insertInstance(db, 'ct_60', ids.tenantId, 45);
    const fired: string[] = [];
    runExpiryScan(db, {
      inApp: (n: any) => fired.push(n.kind),
      tray:  () => {},
    });
    expect(fired).toEqual(['expiry_60']);
  });

  it('does not fire for non-active contracts', () => {
    const db = makeTestDb(); const ids = seedAccessGraph(db);
    insertInstance(db, 'ct_draft', ids.tenantId, 3, 'draft');
    const n = runExpiryScan(db, { inApp: () => {}, tray: () => {} });
    expect(n).toBe(0);
  });
});
