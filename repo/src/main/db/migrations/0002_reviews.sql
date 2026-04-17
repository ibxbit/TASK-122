-- ============================================================================
-- LeaseHub Reviews v2 — moderation, fraud, merchant reply, time windows
--
-- Extends the `reviews` + `review_assets` tables from 0001_init.sql.
-- `status` column is preserved as the lifecycle field; automated verdicts
-- land in the new `moderation_status` column so human + machine states stay
-- separable.
-- ============================================================================

-- ── reviews : add moderation + SLA columns ────────────────────────────────
ALTER TABLE reviews ADD COLUMN moderation_status TEXT    NOT NULL DEFAULT 'pending';
ALTER TABLE reviews ADD COLUMN flag_count        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN follow_up_due_at  INTEGER;     -- 14 days post-event
ALTER TABLE reviews ADD COLUMN reply_due_at      INTEGER;     -- 7  days post-submission
ALTER TABLE reviews ADD COLUMN content_hash      TEXT;        -- sha256 of normalised body

-- Partial indexes so SLA scans ignore settled rows.
CREATE INDEX ix_reviews_tenant_moderation
          ON reviews (tenant_id, moderation_status);
CREATE INDEX ix_reviews_tenant_content_hash
          ON reviews (tenant_id, content_hash);
CREATE INDEX ix_reviews_tenant_followup
          ON reviews (tenant_id, follow_up_due_at)
       WHERE follow_up_due_at IS NOT NULL;
CREATE INDEX ix_reviews_tenant_reply_due
          ON reviews (tenant_id, reply_due_at)
       WHERE reply_due_at IS NOT NULL;

-- ── sensitive_words : per-tenant moderation dictionary ────────────────────
CREATE TABLE sensitive_words (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  word        TEXT    NOT NULL,                        -- stored lower-cased
  severity    TEXT    NOT NULL CHECK (severity IN ('soft','flag','block')),
  category    TEXT,                                    -- 'profanity','pii','competitor',…
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX uq_sensitive_words_tenant_word
          ON sensitive_words (tenant_id, word);
CREATE INDEX        ix_sensitive_words_tenant_active
          ON sensitive_words (tenant_id, active, severity);

-- ── review_replies : merchant reply (7-day SLA) ───────────────────────────
CREATE TABLE review_replies (
  id              TEXT    PRIMARY KEY,
  tenant_id       TEXT    NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  review_id       TEXT    NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  author_user_id  TEXT    NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
  body            TEXT    NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX ix_review_replies_review        ON review_replies (review_id);
CREATE INDEX ix_review_replies_tenant_time   ON review_replies (tenant_id, created_at DESC);

-- ── review_moderation_flags : one row per pipeline finding ────────────────
CREATE TABLE review_moderation_flags (
  id           TEXT    PRIMARY KEY,
  tenant_id    TEXT    NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  review_id    TEXT    NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL CHECK (kind IN ('sensitive_word','rate_limit','duplicate_text','policy','manual')),
  severity     TEXT    NOT NULL CHECK (severity IN ('soft','flag','block')),
  details      TEXT,                                  -- JSON
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at  INTEGER,
  resolved_by  TEXT             REFERENCES users(id)  ON DELETE SET NULL
);

CREATE INDEX ix_review_mod_flags_review
          ON review_moderation_flags (review_id);
CREATE INDEX ix_review_mod_flags_tenant_time
          ON review_moderation_flags (tenant_id, created_at DESC);
CREATE INDEX ix_review_mod_flags_tenant_unresolved
          ON review_moderation_flags (tenant_id, kind, severity)
       WHERE resolved_at IS NULL;
