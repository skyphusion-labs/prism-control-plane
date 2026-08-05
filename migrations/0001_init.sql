-- prism-control-plane 0001: accounts, entitlements, client keys, usage ledger.
--
-- THE PRIVACY INVARIANT IS STRUCTURAL HERE, not a policy someone has to remember. There is no
-- column in this schema that can hold prompt or completion text: the ledger stores counts, ids, and
-- a status, and tests/schema-privacy.test.ts fails the build if a forbidden column name ever
-- appears in migrations/. That is deliberately a schema-level gate rather than a code review habit,
-- because "we do not log prompts" is the kind of promise that decays one convenient debug column at
-- a time.
--
-- MONEY IS INTEGER MICRO-USD EVERYWHERE (1 USD = 1,000,000 micro-USD). No floats in the money path;
-- the unit is in every column name so nobody puts dollars in a field that counts micro-dollars.
--
-- D1 does not enforce foreign keys by default, so the relationships below are documented and unwound
-- in application code. They are written as REFERENCES anyway because that is the shape a reader
-- needs, and because a future D1 with FKs on should agree with what is here.

-- Plans are the entitlement record: what a holder may call, how fast, and how much is included.
--
-- included_micro_usd IS NOT NULL ON PURPOSE. An unset allowance is the absence of a decision, not a
-- decision of "unlimited", and a plane that treats a missing number as unlimited is one config typo
-- away from unbounded spend. A plan that has not had its allowance chosen cannot exist.
CREATE TABLE IF NOT EXISTS plans (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  included_micro_usd  INTEGER NOT NULL,
  requests_per_minute INTEGER NOT NULL,
  -- Per-request output ceiling. This is what BOUNDS the single-request overshoot the pre-flight
  -- quota gate cannot avoid (docs/CONTRACT.md, "Quota semantics"), so it is not merely a courtesy
  -- limit: it is the number that makes the overshoot statement true.
  max_output_tokens   INTEGER NOT NULL,
  -- Comma-separated tier names from src/catalog.ts ("standard", "premium"). A list rather than a
  -- join table because the tier set is small, closed, and read on every request.
  allowed_tiers       TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  -- Optional operator label. NOT an email and NOT an identity: this plane has no user identity of
  -- its own yet (docs/CONTRACT.md open decision 1), and inventing one here would be the wrong seam.
  label        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set to suspend. Every authenticated route refuses a suspended account, so this is the kill
  -- switch and it is deliberately a timestamp rather than a boolean: when it happened matters.
  suspended_at TEXT
);

-- One installed app on one device.
--
-- secret_hash IS THE ONLY STORED FORM of the bearer secret (SHA-256 hex). The plaintext exists once,
-- in the enrollment response, and is never recoverable. key_id is the indexed lookup handle and is
-- NOT secret, which is what lets a lookup happen before any comparison and keeps the compare
-- constant-time against a single candidate row.
CREATE TABLE IF NOT EXISTS clients (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  key_id       TEXT NOT NULL UNIQUE,
  secret_hash  TEXT NOT NULL,
  label        TEXT,
  platform     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_clients_account ON clients(account_id);

-- One-time enrollment tokens. The SEAM for whatever eventually decides who may enroll: an operator
-- today, a validated App Store / Play receipt or a first-party account later. Whichever lands writes
-- rows here, and the enrollment route does not change.
--
-- Stored as a hash for the same reason as client secrets: a leaked table must not be a set of usable
-- credentials.
CREATE TABLE IF NOT EXISTS enrollments (
  token_hash          TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  expires_at          TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  -- Single-use is enforced by a conditional UPDATE on this column, not by a read-then-write, so two
  -- concurrent redemptions cannot both win.
  consumed_at         TEXT,
  consumed_by_client  TEXT,
  note                TEXT
);
CREATE INDEX IF NOT EXISTS idx_enrollments_account ON enrollments(account_id);

-- The usage ledger: one row per inference request that reached a model.
--
-- COUNTS ONLY. No prompt, no completion, no message text, no title, no summary. See the header.
--
-- metered = 0 IS A FIRST-CLASS OUTCOME, not an error row. It means the model answered but reported
-- no usable token counts, so we could not price it. Such a row carries micro_usd = 0 and does NOT
-- increment usage_periods. "Nothing was owed" and "we could not tell what was owed" are different
-- facts; collapsing them turns every gap in the meter into a silent free ride that nobody finds.
CREATE TABLE IF NOT EXISTS usage_events (
  id               TEXT PRIMARY KEY,
  -- The correlation id handed back to the client as prism-request-id. Paired with client_id it is
  -- the idempotency key: a retried write for the same request is ignored rather than double-counted.
  request_id       TEXT NOT NULL,
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  client_id        TEXT NOT NULL REFERENCES clients(id),
  model_id         TEXT NOT NULL,
  period_key       TEXT NOT NULL,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  micro_usd        INTEGER NOT NULL,
  metered          INTEGER NOT NULL,
  unmetered_reason TEXT,
  upstream_status  INTEGER,
  -- AI Gateway log id when one exists, for reconciling our priced estimate against Cloudflare's
  -- authoritative cost later. NULL is the normal case while gateway logging is off.
  gateway_log_id   TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_events_period ON usage_events(account_id, period_key);

-- The rolled-up counter the pre-flight quota gate reads. Kept alongside the ledger rather than
-- derived from them on every request: the gate runs before every inference call and must not cost a
-- table scan that grows with history. usage_events stays the source of truth, so a divergence is
-- detectable by summing.
CREATE TABLE IF NOT EXISTS usage_periods (
  account_id         TEXT NOT NULL REFERENCES accounts(id),
  period_key         TEXT NOT NULL,
  micro_usd          INTEGER NOT NULL DEFAULT 0,
  requests           INTEGER NOT NULL DEFAULT 0,
  -- Surfaced to the client in GET /v1/usage. Should be 0; a non-zero value is service we did not
  -- charge for, and it is visible from both ends rather than buried in an operator dashboard.
  unmetered_requests INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, period_key)
);

-- Fixed-window rate buckets. Same shape prism uses for its auth limiter: a D1 counter rather than a
-- new binding, so the limiter is transactional with the data it protects and works identically under
-- wrangler dev.
CREATE TABLE IF NOT EXISTS rate_buckets (
  bucket_key   TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- PROVISIONAL local-development plan. NOT a product tier and NOT pricing.
--
-- USD 1.00 included per month, 20 requests per minute, 1024 output tokens, standard tier only.
-- Every number here is a placeholder chosen to be small enough that a runaway loop against a local
-- deploy costs cents, and it is seeded rather than left absent so that a fresh database is usable
-- without inventing an allowance at runtime. Real plan pricing is docs/CONTRACT.md open decision 2.
INSERT OR IGNORE INTO plans
  (id, name, included_micro_usd, requests_per_minute, max_output_tokens, allowed_tiers)
VALUES
  ('dev', 'Development (provisional)', 1000000, 20, 1024, 'standard');
