-- ============================================================================
-- LeaseHub Contracts v2 — signing prerequisites, clause catalog, signatures
-- Supports the signing workflow; extends users / contract_instances from v1.
-- ============================================================================

-- ── users : signing credentials + verification ────────────────────────────
ALTER TABLE users ADD COLUMN gov_id_last4   TEXT;                    -- last 4 of gov ID
ALTER TABLE users ADD COLUMN verified       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_hash  TEXT;                    -- pbkdf2-sha256 (hex, 32 B)
ALTER TABLE users ADD COLUMN password_salt  TEXT;                    -- per-user salt   (hex, 16 B)

-- ── contract_instances : frozen-PDF location + tamper-evidence hash ──────
ALTER TABLE contract_instances ADD COLUMN pdf_path   TEXT;
ALTER TABLE contract_instances ADD COLUMN pdf_sha256 TEXT;

-- Expiry scans touch only active contracts with a defined end date.
CREATE INDEX ix_contract_instances_active_expiry
          ON contract_instances (tenant_id, effective_to)
       WHERE effective_to IS NOT NULL AND status = 'active';

-- ── contract_clauses : reusable clause catalog ───────────────────────────
CREATE TABLE contract_clauses (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code        TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  category    TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX uq_contract_clauses_tenant_code
          ON contract_clauses (tenant_id, code);
CREATE INDEX        ix_contract_clauses_tenant_active
          ON contract_clauses (tenant_id, active);

-- ── contract_signatures : append-only signature ledger ───────────────────
CREATE TABLE contract_signatures (
  id                    TEXT    PRIMARY KEY,
  tenant_id             TEXT    NOT NULL REFERENCES tenants(id)             ON DELETE RESTRICT,
  contract_instance_id  TEXT    NOT NULL REFERENCES contract_instances(id)  ON DELETE RESTRICT,
  signer_user_id        TEXT    NOT NULL REFERENCES users(id)               ON DELETE RESTRICT,
  signed_at             INTEGER NOT NULL DEFAULT (unixepoch()),
  gov_id_last4          TEXT    NOT NULL,
  signature_sha256      TEXT    NOT NULL,   -- sha256 of the frozen PDF
  ip                    TEXT,                -- local host
  window_kind           TEXT
);
CREATE INDEX ix_contract_signatures_instance    ON contract_signatures (contract_instance_id);
CREATE INDEX ix_contract_signatures_tenant_time ON contract_signatures (tenant_id, signed_at DESC);

CREATE TRIGGER contract_signatures_no_update
BEFORE UPDATE ON contract_signatures
BEGIN SELECT RAISE(ABORT, 'contract_signatures is append-only'); END;
CREATE TRIGGER contract_signatures_no_delete
BEFORE DELETE ON contract_signatures
BEGIN SELECT RAISE(ABORT, 'contract_signatures is append-only'); END;

-- ── contract_notifications : dedupe 60/30/7-day expiry alerts ────────────
CREATE TABLE contract_notifications (
  id                    TEXT    PRIMARY KEY,
  tenant_id             TEXT    NOT NULL REFERENCES tenants(id)             ON DELETE RESTRICT,
  contract_instance_id  TEXT    NOT NULL REFERENCES contract_instances(id)  ON DELETE CASCADE,
  kind                  TEXT    NOT NULL CHECK (kind IN ('expiry_60','expiry_30','expiry_7')),
  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  dismissed_at          INTEGER,
  dismissed_by          TEXT             REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX uq_contract_notifications_once
          ON contract_notifications (contract_instance_id, kind);
CREATE INDEX        ix_contract_notifications_tenant_open
          ON contract_notifications (tenant_id, created_at DESC)
       WHERE dismissed_at IS NULL;
