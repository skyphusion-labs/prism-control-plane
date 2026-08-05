-- prism-control-plane 0002: prepaid credit, per-user upstream tokens, operator model prices.
--
-- THREE RULINGS FROM 2026-08-04 LAND HERE.
--
-- 1. PREPAID ONLY. There is no postpaid path and no overage. The gate is a BALANCE, not a monthly
--    allowance: credit granted minus spend recorded. A monthly allowance resets, and a reset is a grant
--    of money nobody decided to give; a balance only moves when someone tops it up or something is
--    spent. `plans.included_micro_usd` is therefore renamed to `signup_credit_micro_usd` -- it is the
--    opening grant applied once when an account is created, not a recurring entitlement.
--    usage_periods survives, but only for REPORTING. It gates nothing now.
--
-- 2. ONE UPSTREAM CREDENTIAL PER USER. `user_tokens` holds a Cloudflare API token minted for one
--    account, encrypted at rest. This is the only table in the plane that stores a replayable secret,
--    and it is the only one that has to: the credential is presented on the user's next request. See
--    src/token-crypto.ts for the KEK ring, and src/token-minter.ts for why the value never leaves.
--
-- 3. A MODEL WITHOUT A PRICE IS NOT SPENDABLE. Cloudflare publishes per-token rates for Workers AI but
--    not for third-party Unified Billing models, so 25 of the 45 chat models in the catalog arrive with
--    price: null. `model_prices` lets an operator supply the rate without a deploy. Until a rate exists
--    the inference door refuses the model. That ordering is the point: the money gate closes by default
--    and opens on a decision, never the other way round.
--
-- Money stays integer micro-USD everywhere (1 USD = 1,000,000 micro-USD), and the privacy invariant from
-- 0001 is unchanged: no column added here can hold prompt or completion text.

-- The opening grant, renamed from included_micro_usd. Same column, honest name.
ALTER TABLE plans RENAME COLUMN included_micro_usd TO signup_credit_micro_usd;

-- Prepaid position, held on the account rather than derived per request.
--
-- WHY TWO COLUMNS AND NOT ONE BALANCE. A single decrementing balance loses the distinction between
-- "never had much" and "spent a lot", which is exactly the pair an operator needs when a user complains.
-- Both are monotonic: credit only rises (top-ups), spend only rises (metered requests). A balance is
-- their difference and is never stored, so the two can be reconciled against credit_grants and
-- usage_events independently.
ALTER TABLE accounts ADD COLUMN credit_micro_usd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN spent_micro_usd INTEGER NOT NULL DEFAULT 0;

-- Every top-up, as a row. accounts.credit_micro_usd is the running total; this is the audit trail.
--
-- idempotency_key IS UNIQUE AND REQUIRED. A retried top-up must not grant the money twice, and the only
-- safe place to enforce that is the database. An operator supplies the key (an invoice id, a payment
-- reference); the plane refuses a grant without one rather than inventing a key that would make every
-- retry a new grant.
CREATE TABLE IF NOT EXISTS credit_grants (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  micro_usd       INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credit_grants_account ON credit_grants(account_id);

-- One minted Cloudflare upstream token per account.
--
-- token_enc IS CIPHERTEXT, base64( iv || AES-256-GCM ), under a KEK that lives only as a Worker secret.
-- A dump of this table without the KEK yields nothing spendable. cf_token_id is NOT secret and is stored
-- in the clear precisely because revocation needs it: a credential we cannot name is one we cannot kill.
--
-- revoked_at is a timestamp rather than a deletion. A deleted row loses the fact that the account ever
-- had a credential, which is the first thing anyone asks after an incident.
CREATE TABLE IF NOT EXISTS user_tokens (
  account_id   TEXT PRIMARY KEY REFERENCES accounts(id),
  cf_token_id  TEXT NOT NULL,
  token_enc    TEXT NOT NULL,
  minted_at    INTEGER NOT NULL,
  revoked_at   INTEGER,
  last_used_at INTEGER
);

-- Operator-set per-token rates, keyed by catalog model id.
--
-- An override here WINS over the compiled-in Cloudflare rate, and that direction is deliberate: the
-- compiled rate is what Cloudflare published on a given day, and the day it moves an operator must be
-- able to follow it without waiting for a deploy. priced_at records when the number was decided so a
-- stale override is visibly stale, the same discipline src/catalog.ts uses.
CREATE TABLE IF NOT EXISTS model_prices (
  model_id                    TEXT PRIMARY KEY,
  input_micro_usd_per_mtok    INTEGER NOT NULL,
  output_micro_usd_per_mtok   INTEGER NOT NULL,
  priced_at                   TEXT NOT NULL,
  note                        TEXT,
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The provisional dev plan's opening grant, restated for clarity after the rename: USD 1.00 of prepaid
-- credit, once, at account creation. Still a placeholder, still not pricing.
UPDATE plans SET signup_credit_micro_usd = 1000000 WHERE id = 'dev';
