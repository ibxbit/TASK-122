-- ============================================================================
-- LeaseHub Operations Console — Initial Schema (v1)
--
-- SQLite 3, offline.  Every non-tenant row carries tenant_id so every query
-- must filter by tenant_id — multi-tenant isolation is enforced in data
-- access (plus compound indexes leading with tenant_id for performance).
--
-- Runtime pragmas (applied by the DB layer at connection time, not here):
--   PRAGMA foreign_keys = ON;
--   PRAGMA journal_mode = WAL;
--   PRAGMA synchronous  = NORMAL;
--   PRAGMA busy_timeout = 5000;
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- CORE : Tenant, OrgUnit, User
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE org_units (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL REFERENCES tenants(id)   ON DELETE RESTRICT,
  parent_id   TEXT             REFERENCES org_units(id) ON DELETE RESTRICT,
  kind        TEXT    NOT NULL CHECK (kind IN ('location','department','team')),
  code        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  path        TEXT    NOT NULL,                     -- materialised path, e.g. "/hq/nyc/eng"
  depth       INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','inactive')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE users (
  id                   TEXT    PRIMARY KEY,
  tenant_id            TEXT    NOT NULL REFERENCES tenants(id)   ON DELETE RESTRICT,
  username             TEXT    NOT NULL,
  display_name         TEXT    NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','disabled')),
  primary_org_unit_id  TEXT             REFERENCES org_units(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ────────────────────────────────────────────────────────────────────────────
-- ACCESS : Role, Permission, DataScope   (mirrors Drizzle schema/access.ts)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE roles (
  id           TEXT    PRIMARY KEY,
  code         TEXT    NOT NULL UNIQUE
                       CHECK (code IN ('SystemAdmin','TenantAdmin','OperationsManager',
                                       'ComplianceAuditor','ContentModerator')),
  name         TEXT    NOT NULL,
  is_system    INTEGER NOT NULL DEFAULT 1,
  is_readonly  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE permissions (
  id           TEXT    PRIMARY KEY,
  code         TEXT    NOT NULL,                                   -- e.g. 'contract.delete'
  type         TEXT    NOT NULL CHECK (type   IN ('menu','api','field','resource')),
  action       TEXT    NOT NULL DEFAULT 'read'
                       CHECK (action IN ('read','write')),
  description  TEXT
);

CREATE TABLE role_permissions (
  role_id        TEXT NOT NULL REFERENCES roles(id)       ON DELETE CASCADE,
  permission_id  TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  effect         TEXT NOT NULL DEFAULT 'allow'
                      CHECK (effect IN ('allow','deny')),
  PRIMARY KEY (role_id, permission_id)
) WITHOUT ROWID;

CREATE TABLE user_roles (
  id          TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role_id     TEXT    NOT NULL REFERENCES roles(id)   ON DELETE RESTRICT,
  tenant_id   TEXT    NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  granted_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE data_scopes (
  id             TEXT    PRIMARY KEY,
  user_role_id   TEXT    NOT NULL REFERENCES user_roles(id) ON DELETE CASCADE,
  conditions     TEXT    NOT NULL,                 -- JSON { locationId?, departmentId?, ... }
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ────────────────────────────────────────────────────────────────────────────
-- OPERATIONS : Order, SeatRoom, OccupancySnapshot
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE orders (
  id                TEXT    PRIMARY KEY,
  tenant_id         TEXT    NOT NULL REFERENCES tenants(id)   ON DELETE RESTRICT,
  org_unit_id       TEXT             REFERENCES org_units(id) ON DELETE SET NULL,
  order_number      TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('lease','renewal','amendment','termination','other')),
  status            TEXT    NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','submitted','approved','rejected','completed','cancelled')),
  subject_user_id   TEXT             REFERENCES users(id)     ON DELETE SET NULL,
  assigned_user_id  TEXT             REFERENCES users(id)     ON DELETE SET NULL,
  amount_cents      INTEGER NOT NULL DEFAULT 0,
  currency          TEXT    NOT NULL DEFAULT 'USD',
  notes             TEXT,
  created_by        TEXT             REFERENCES users(id)     ON DELETE SET NULL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE seat_rooms (
  id           TEXT    PRIMARY KEY,
  tenant_id    TEXT    NOT NULL REFERENCES tenants(id)   ON DELETE RESTRICT,
  org_unit_id  TEXT    NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  code         TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('seat','room','office','suite')),
  capacity     INTEGER NOT NULL DEFAULT 1,
  status       TEXT    NOT NULL DEFAULT 'available'
                       CHECK (status IN ('available','reserved','occupied','maintenance','retired')),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE occupancy_snapshots (
  id               TEXT    PRIMARY KEY,
  tenant_id        TEXT    NOT NULL REFERENCES tenants(id)    ON DELETE RESTRICT,
  seat_room_id     TEXT    NOT NULL REFERENCES seat_rooms(id) ON DELETE CASCADE,
  captured_at      INTEGER NOT NULL,
  occupancy_count  INTEGER NOT NULL,
  capacity         INTEGER NOT NULL,                 -- denormalised — preserves historic capacity
  source           TEXT    NOT NULL DEFAULT 'manual'
                           CHECK (source IN ('manual','scheduled','sensor','import')),
  notes            TEXT
);

-- ────────────────────────────────────────────────────────────────────────────
-- REVIEWS : Review, ReviewAsset
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE reviews (
  id                TEXT    PRIMARY KEY,
  tenant_id         TEXT    NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  target_type       TEXT    NOT NULL CHECK (target_type IN ('order','contract','seat_room','other')),
  target_id         TEXT    NOT NULL,                -- polymorphic; not FK-enforced
  reviewer_user_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rating            INTEGER          CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  title             TEXT,
  body              TEXT,
  status            TEXT    NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','submitted','approved','rejected')),
  submitted_at      INTEGER,
  resolved_at       INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE review_assets (
  id           TEXT    PRIMARY KEY,
  tenant_id    TEXT    NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  review_id    TEXT    NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  file_path    TEXT    NOT NULL,                       -- relative to userData/; never a URL
  mime_type    TEXT    NOT NULL,
  size_bytes   INTEGER NOT NULL,
  checksum     TEXT    NOT NULL,                       -- sha256 hex
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ────────────────────────────────────────────────────────────────────────────
-- CONTRACTS : ContractTemplate, ContractInstance
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE contract_templates (
  id           TEXT    PRIMARY KEY,
  tenant_id    TEXT    NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code         TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  body         TEXT    NOT NULL,                       -- template source (markdown + placeholders)
  variables    TEXT    NOT NULL DEFAULT '{}',          -- JSON Schema of fill-in fields
  status       TEXT    NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','published','retired')),
  published_at INTEGER,
  created_by   TEXT             REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE contract_instances (
  id                   TEXT    PRIMARY KEY,
  tenant_id            TEXT    NOT NULL REFERENCES tenants(id)            ON DELETE RESTRICT,
  template_id          TEXT    NOT NULL REFERENCES contract_templates(id) ON DELETE RESTRICT,
  instance_number      TEXT    NOT NULL,
  counterparty_user_id TEXT             REFERENCES users(id)     ON DELETE SET NULL,
  org_unit_id          TEXT             REFERENCES org_units(id) ON DELETE SET NULL,
  status               TEXT    NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','pending_signature','active','expired','terminated')),
  rendered_body        TEXT    NOT NULL,                 -- filled template at generation time
  variables            TEXT    NOT NULL DEFAULT '{}',    -- JSON of chosen values
  effective_from       INTEGER,
  effective_to         INTEGER,
  signed_at            INTEGER,
  created_by           TEXT             REFERENCES users(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ────────────────────────────────────────────────────────────────────────────
-- AUDIT : AuditEvent — append-only, hash-chained
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE audit_events (
  id             TEXT    PRIMARY KEY,                    -- ULID (time-ordered)
  tenant_id      TEXT             REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id  TEXT             REFERENCES users(id)   ON DELETE SET NULL,
  occurred_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  action         TEXT    NOT NULL,                       -- e.g. 'contract.signed','access.denied'
  entity_type    TEXT,
  entity_id      TEXT,
  payload        TEXT,                                   -- JSON (nullable)
  window_kind    TEXT             CHECK (window_kind IS NULL OR window_kind IN ('dashboard','contracts','audit')),
  hash_prev      TEXT,
  hash_curr      TEXT    NOT NULL
);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- ============================================================================
-- INDEXES  (every compound index leads with tenant_id for isolation + pruning)
-- ============================================================================

-- Core ----------------------------------------------------------------------
CREATE INDEX        ix_org_units_tenant_parent     ON org_units   (tenant_id, parent_id);
CREATE INDEX        ix_org_units_tenant_path       ON org_units   (tenant_id, path);
CREATE UNIQUE INDEX uq_org_units_tenant_kind_code  ON org_units   (tenant_id, kind, code);

CREATE UNIQUE INDEX uq_users_tenant_username       ON users       (tenant_id, username);
CREATE INDEX        ix_users_tenant_status         ON users       (tenant_id, status);
CREATE INDEX        ix_users_tenant_org            ON users       (tenant_id, primary_org_unit_id);

-- Access --------------------------------------------------------------------
CREATE UNIQUE INDEX uq_permissions_code_type       ON permissions (code, type);
CREATE UNIQUE INDEX uq_user_roles                  ON user_roles  (user_id, role_id, tenant_id);
CREATE INDEX        ix_user_roles_tenant           ON user_roles  (tenant_id);
CREATE INDEX        ix_user_roles_user_tenant      ON user_roles  (user_id, tenant_id);
CREATE INDEX        ix_data_scopes_user_role       ON data_scopes (user_role_id);

-- Operations ----------------------------------------------------------------
CREATE UNIQUE INDEX uq_orders_tenant_number        ON orders      (tenant_id, order_number);
CREATE INDEX        ix_orders_tenant_status_time   ON orders      (tenant_id, status,            created_at DESC);
CREATE INDEX        ix_orders_tenant_assigned      ON orders      (tenant_id, assigned_user_id,  status);
CREATE INDEX        ix_orders_tenant_org_time      ON orders      (tenant_id, org_unit_id,       created_at DESC);

CREATE UNIQUE INDEX uq_seat_rooms_tenant_code      ON seat_rooms  (tenant_id, code);
CREATE INDEX        ix_seat_rooms_tenant_org       ON seat_rooms  (tenant_id, org_unit_id, status);

CREATE INDEX        ix_occupancy_tenant_seat_time  ON occupancy_snapshots (tenant_id, seat_room_id, captured_at DESC);
CREATE INDEX        ix_occupancy_tenant_time       ON occupancy_snapshots (tenant_id, captured_at DESC);

-- Reviews -------------------------------------------------------------------
CREATE INDEX        ix_reviews_tenant_target       ON reviews     (tenant_id, target_type, target_id);
CREATE INDEX        ix_reviews_tenant_reviewer     ON reviews     (tenant_id, reviewer_user_id, status);
CREATE INDEX        ix_reviews_tenant_status_time  ON reviews     (tenant_id, status, created_at DESC);
CREATE INDEX        ix_review_assets_review        ON review_assets (review_id);

-- Contracts -----------------------------------------------------------------
CREATE UNIQUE INDEX uq_contract_templates_tenant_code_ver
    ON contract_templates (tenant_id, code, version);
CREATE INDEX        ix_contract_templates_tenant_status
    ON contract_templates (tenant_id, status);

CREATE UNIQUE INDEX uq_contract_instances_tenant_number
    ON contract_instances (tenant_id, instance_number);
CREATE INDEX        ix_contract_instances_tenant_template
    ON contract_instances (tenant_id, template_id);
CREATE INDEX        ix_contract_instances_tenant_counterparty
    ON contract_instances (tenant_id, counterparty_user_id, status);
CREATE INDEX        ix_contract_instances_tenant_status_time
    ON contract_instances (tenant_id, status, created_at DESC);
CREATE INDEX        ix_contract_instances_tenant_effective
    ON contract_instances (tenant_id, effective_from, effective_to);

-- Audit ---------------------------------------------------------------------
CREATE INDEX        ix_audit_tenant_time           ON audit_events (tenant_id, occurred_at DESC);
CREATE INDEX        ix_audit_tenant_action_time    ON audit_events (tenant_id, action,        occurred_at DESC);
CREATE INDEX        ix_audit_tenant_actor_time     ON audit_events (tenant_id, actor_user_id, occurred_at DESC);
CREATE INDEX        ix_audit_tenant_entity_time    ON audit_events (tenant_id, entity_type, entity_id, occurred_at DESC);
