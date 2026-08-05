-- prism-control-plane 0003: true-up of the local estimate against AI Gateway's own cost figure.
--
-- WHY THIS EXISTS (issue #12, measurements in #10). The plane prices each request locally from token
-- counts against a rate table in the tree, and that computation can be wrong through no fault of the
-- code: Cloudflare repriced two models inside an 8 hour window during the pricing research, and
-- reasoning models under-report `tokens_out` relative to what is actually billed. Cloudflare already
-- records the authoritative per-request `cost` in the AI Gateway logs, and every one of our calls
-- carries `cf-aig-metadata` with our own request id, so the biller's number is joinable to our ledger
-- row. Nothing read it back until now.
--
-- THE ORIGINAL LEDGER ROW IS NEVER REWRITTEN. A true-up lands as its own auditable row here, keyed to
-- the gateway log it came from. Overwriting `usage_events.micro_usd` in place would destroy the only
-- evidence that our meter and the biller ever disagreed, which is the single most useful fact this
-- whole mechanism produces: the drift is the finding, not an inconvenience to smooth away.
--
-- BOTH MONEY COLUMNS ON `accounts` STAY MONOTONIC, and that is what decides the shape of a true-up:
--
--   gateway cost HIGHER than our estimate  ->  a spend adjustment; `spent_micro_usd` rises.
--   gateway cost LOWER than our estimate   ->  a CREDIT GRANT; `credit_micro_usd` rises.
--
-- Refunding by decrementing `spent_micro_usd` would be the obvious move and it is wrong. Migration
-- 0002 made both columns monotonic on purpose so that each one can be reconciled independently
-- against its own audit trail (`credit_grants`, `usage_events`); a column that can go down cannot be
-- checked against a sum of rows that only goes up. Granting credit instead reaches the same balance
-- (credit minus spend) while leaving both trails re-summable, and it reuses the existing idempotent
-- grant ledger rather than inventing a second money path.
--
-- Money stays integer micro-USD (1 USD = 1,000,000). Cloudflare reports cost as a decimal USD number;
-- src/aig-logs.ts converts it through its decimal digits rather than float arithmetic, and an ABSENT
-- cost is carried as unknown, never as zero. The 0001 privacy invariant is unchanged: nothing here can
-- hold prompt or completion text, and `cf-aig-collect-log-payload: false` means the gateway rows this
-- reads do not carry it either.

-- One true-up, as a row. The audit trail for every micro-USD this mechanism moved.
--
-- idempotency_key IS UNIQUE AND IS DERIVED FROM THE GATEWAY LOG ID (`aig:<log id>`), which is what
-- makes the whole job safe to re-run. Reconciliation reads a paged, time-windowed feed from someone
-- else's system: rows arrive late, a page boundary can be crossed twice, and a run can die halfway.
-- Every one of those retries must be a no-op rather than a second charge, and the only place that can
-- be decided without a race is the database. Same discipline as credit_grants in 0002.
--
-- estimate_micro_usd and gateway_micro_usd are BOTH kept, alongside their difference. Storing only the
-- delta would make the row unreadable a month later: "we moved 240 micro-USD" does not say whether the
-- meter was 5% low or 500% low, and that ratio is the thing that tells an operator whether a rate went
-- stale or a model is under-reporting its tokens.
CREATE TABLE IF NOT EXISTS usage_adjustments (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  -- The ledger row this trues up. Nullable: a gateway row whose request id matches nothing we recorded
  -- is a real finding (spend we never metered), and it is written down rather than dropped.
  usage_event_id      TEXT,
  -- Our correlation id, read back out of the gateway row's custom metadata.
  request_id          TEXT NOT NULL,
  gateway_log_id      TEXT NOT NULL,
  period_key          TEXT NOT NULL,
  model_id            TEXT,
  estimate_micro_usd  INTEGER NOT NULL,
  gateway_micro_usd   INTEGER NOT NULL,
  -- gateway minus estimate. Signed: negative means we over-charged.
  delta_micro_usd     INTEGER NOT NULL,
  -- "spend" or "credit": which monotonic column this row advanced. Stored rather than inferred from the
  -- sign so a reader never has to re-derive the rule, and so a future third direction cannot be mistaken
  -- for one of these two.
  direction           TEXT NOT NULL,
  -- The absolute amount actually added to that column. Always positive.
  applied_micro_usd   INTEGER NOT NULL,
  idempotency_key     TEXT NOT NULL UNIQUE,
  reconciled_at       TEXT NOT NULL DEFAULT (datetime('now')),
  note                TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_adjustments_account ON usage_adjustments(account_id, period_key);
CREATE INDEX IF NOT EXISTS idx_usage_adjustments_request ON usage_adjustments(request_id);

-- The period rollup learns about true-ups too, in two more monotonic columns.
--
-- WITHOUT THESE THE MONTHLY VIEW WOULD SILENTLY DISAGREE WITH THE BALANCE. `usage_periods.micro_usd` is
-- the sum of our ESTIMATES for the month; the account's balance now includes reconciliation. Leaving the
-- period untouched would publish a monthly figure that no longer adds up to what was charged, and
-- adding the drift INTO `micro_usd` would destroy the estimate-versus-actual comparison the ledger
-- exists to support. Two separate counters keep both readable, and both only rise.
ALTER TABLE usage_periods ADD COLUMN adjust_spend_micro_usd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_periods ADD COLUMN adjust_credit_micro_usd INTEGER NOT NULL DEFAULT 0;

-- Where the last reconciliation run got to, one row per gateway.
--
-- THE WATERMARK IS DELIBERATELY BEHIND THE PRESENT. Gateway rows are not guaranteed to be readable the
-- instant a request finishes, so a run that advanced the watermark to "now" would step over anything
-- that landed a second later and never look at it again. src/reconcile.ts clamps the advance to a
-- settling lag, so the trailing edge is re-read on the next run; the unique idempotency key above is
-- what makes that overlap free.
--
-- A NULL watermark means "never run", which is different from "ran and found nothing" -- the first run
-- has no time floor to work from and must be given one explicitly rather than defaulting to the epoch
-- and paging the entire history of the gateway.
CREATE TABLE IF NOT EXISTS reconcile_state (
  gateway_id    TEXT PRIMARY KEY,
  watermark     TEXT,
  last_log_id   TEXT,
  last_run_at   TEXT,
  runs          INTEGER NOT NULL DEFAULT 0,
  rows_seen     INTEGER NOT NULL DEFAULT 0,
  rows_adjusted INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
