-- ============================================================================
-- LeaseHub Offline Routing — road graph, addresses, versioned restrictions
--
-- Dataset rows are global (roads aren't tenant-scoped).  Only one dataset is
-- `active = 1` at a time; older imports are retained for rollback.
-- ============================================================================

CREATE TABLE route_datasets (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  version      TEXT    NOT NULL,
  source_path  TEXT,
  file_sha256  TEXT,                      -- aggregate hash of listed files
  imported_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  imported_by  TEXT             REFERENCES users(id) ON DELETE SET NULL,
  node_count   INTEGER NOT NULL DEFAULT 0,
  edge_count   INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uq_route_datasets_name_version ON route_datasets (name, version);
CREATE INDEX        ix_route_datasets_active       ON route_datasets (active) WHERE active = 1;

CREATE TABLE route_nodes (
  dataset_id  TEXT    NOT NULL REFERENCES route_datasets(id) ON DELETE CASCADE,
  node_id     INTEGER NOT NULL,
  lat         REAL    NOT NULL,
  lon         REAL    NOT NULL,
  PRIMARY KEY (dataset_id, node_id)
) WITHOUT ROWID;

CREATE TABLE route_edges (
  dataset_id      TEXT    NOT NULL REFERENCES route_datasets(id) ON DELETE CASCADE,
  edge_id         INTEGER NOT NULL,
  from_node_id    INTEGER NOT NULL,
  to_node_id      INTEGER NOT NULL,
  length_meters   REAL    NOT NULL,
  speed_kph       REAL    NOT NULL,
  toll_cents      INTEGER NOT NULL DEFAULT 0,
  road_class      TEXT,
  one_way         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dataset_id, edge_id)
) WITHOUT ROWID;
CREATE INDEX ix_route_edges_from ON route_edges (dataset_id, from_node_id);
CREATE INDEX ix_route_edges_to   ON route_edges (dataset_id, to_node_id);

CREATE TABLE route_addresses (
  dataset_id  TEXT    NOT NULL REFERENCES route_datasets(id) ON DELETE CASCADE,
  address_key TEXT    NOT NULL,            -- normalised "street number city postal"
  display     TEXT    NOT NULL,
  node_id     INTEGER NOT NULL,
  PRIMARY KEY (dataset_id, address_key)
) WITHOUT ROWID;
CREATE INDEX ix_route_addresses_display ON route_addresses (dataset_id, display);

-- Versioned detours / restrictions.  A new version supersedes the prior one
-- via `superseded_by`; the active row for (dataset, edge) is the latest
-- version whose time window covers "now".
CREATE TABLE route_restrictions (
  id             TEXT    PRIMARY KEY,
  dataset_id     TEXT    NOT NULL REFERENCES route_datasets(id) ON DELETE CASCADE,
  edge_id        INTEGER NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('closure','detour','truck_only','low_clearance')),
  valid_from     INTEGER,
  valid_to       INTEGER,
  version        INTEGER NOT NULL DEFAULT 1,
  detour_path    TEXT,                     -- JSON array of edge_ids (kind='detour')
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  superseded_by  TEXT             REFERENCES route_restrictions(id)
);
CREATE INDEX ix_route_restrictions_dataset_edge ON route_restrictions (dataset_id, edge_id);
CREATE INDEX ix_route_restrictions_live
          ON route_restrictions (dataset_id, valid_from, valid_to)
       WHERE superseded_by IS NULL;
