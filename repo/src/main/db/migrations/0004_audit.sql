-- ============================================================================
-- LeaseHub Audit Log v2 — per-tenant hash chain, sequence, retention
--
-- Extends `audit_events` from 0001_init.sql.  The append-only triggers
-- defined there still apply; this migration adds chain plumbing.
-- ============================================================================

-- ── audit_events : sequence + retention ───────────────────────────────────
ALTER TABLE audit_events ADD COLUMN seq          INTEGER;   -- per-tenant, 1..N
ALTER TABLE audit_events ADD COLUMN retain_until INTEGER;   -- unix seconds, = occurred_at + 7y

-- Seq is per tenant, monotonically increasing.  Legacy rows (before this
-- migration) have NULL seq and are outside the hash chain.
CREATE UNIQUE INDEX uq_audit_events_tenant_seq
          ON audit_events (tenant_id, seq)
       WHERE seq IS NOT NULL;

-- Retention sweeper scans by retain_until; restrict the index to rows that
-- will eventually expire (i.e. have a retention policy applied).
CREATE INDEX ix_audit_events_retain_until
          ON audit_events (retain_until)
       WHERE retain_until IS NOT NULL;

-- ── audit_chain_heads : latest hash + seq per tenant ──────────────────────
-- Mutable by design — it is an advisory cache; the authoritative chain lives
-- in audit_events and can always be re-derived.
CREATE TABLE audit_chain_heads (
  tenant_id       TEXT    PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  head_event_id   TEXT    NOT NULL REFERENCES audit_events(id),
  head_hash       TEXT    NOT NULL,
  seq             INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
