import { describe, expect, it } from 'vitest';
import { makeTestDb } from '../../unit_tests/_helpers/db';

/* =========================================================================
 *  Integration — every migration applies cleanly against a blank SQLite
 *  and produces the tables, columns, indexes, and triggers the rest of
 *  the codebase expects.
 * ========================================================================= */

describe('migrations apply cleanly', () => {
  it('creates the full core schema', () => {
    const db = makeTestDb();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all().map((r: any) => r.name);
    for (const required of [
      'tenants', 'users', 'roles', 'permissions', 'role_permissions',
      'user_roles', 'data_scopes', 'org_units', 'orders', 'seat_rooms',
      'occupancy_snapshots', 'reviews', 'review_assets', 'review_replies',
      'review_moderation_flags', 'sensitive_words', 'contract_templates',
      'contract_instances', 'contract_clauses', 'contract_signatures',
      'contract_notifications', 'audit_events', 'audit_chain_heads',
      'route_datasets', 'route_nodes', 'route_edges', 'route_addresses',
      'route_restrictions',
    ]) {
      expect(tables, `expected table ${required}`).toContain(required);
    }
  });

  it('installs append-only triggers on audit_events', () => {
    const db = makeTestDb();
    const ids = ['t1'];
    db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run('t1', 't');
    db.prepare(`
      INSERT INTO audit_events (id, tenant_id, action, hash_curr, occurred_at, seq)
      VALUES ('a1', 't1', 'x', 'h', 1, 1)
    `).run();
    expect(() => db.prepare('UPDATE audit_events SET action = ? WHERE id = ?').run('tamper', 'a1'))
      .toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_events WHERE id = ?').run('a1'))
      .toThrow(/append-only/);
    void ids;
  });

  it('enforces append-only on contract_signatures', () => {
    const db = makeTestDb();
    db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run('t1', 't');
    db.prepare(`
      INSERT INTO users (id, tenant_id, username, display_name, verified, gov_id_last4)
      VALUES ('u1', 't1', 'u', 'U', 1, '1234')
    `).run();
    db.prepare(`
      INSERT INTO contract_templates (id, tenant_id, code, name, version, body)
      VALUES ('tpl1', 't1', 'c', 'n', 1, '')
    `).run();
    db.prepare(`
      INSERT INTO contract_instances (id, tenant_id, template_id, instance_number, rendered_body)
      VALUES ('ci1', 't1', 'tpl1', '1', '')
    `).run();
    db.prepare(`
      INSERT INTO contract_signatures (id, tenant_id, contract_instance_id, signer_user_id, gov_id_last4, signature_sha256)
      VALUES ('sig1', 't1', 'ci1', 'u1', '1234', 'deadbeef')
    `).run();
    expect(() => db.prepare('DELETE FROM contract_signatures WHERE id = ?').run('sig1'))
      .toThrow(/append-only/);
  });

  it('enforces unique tenant+seq on chained audit events', () => {
    const db = makeTestDb();
    db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run('t1', 't');
    db.prepare(`
      INSERT INTO audit_events (id, tenant_id, action, hash_curr, occurred_at, seq)
      VALUES ('a1', 't1', 'x', 'h', 1, 1)
    `).run();
    expect(() =>
      db.prepare(`
        INSERT INTO audit_events (id, tenant_id, action, hash_curr, occurred_at, seq)
        VALUES ('a2', 't1', 'x', 'h', 1, 1)
      `).run()
    ).toThrow(/UNIQUE/);
  });
});
