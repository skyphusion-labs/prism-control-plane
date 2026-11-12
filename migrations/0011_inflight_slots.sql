-- prism-control-plane 0011: per-account in-flight cap (#100).
--
-- The prepaid gate reserves nothing, so each in-flight request can overshoot the
-- remaining balance by one request. This table holds one row per admitted request
-- that has not settled yet: a sync request, a chat stream until its ledger row is
-- written, a live voice session until the session finalizes. Running async jobs
-- are counted from async_jobs instead (status = 'running').
--
-- The claim is a single INSERT ... SELECT ... WHERE count < cap (store-d1.ts), so
-- concurrent claims cannot all pass. expires_at bounds a row whose release never
-- ran. id is the request id; it carries no prompt, no body, nothing but the hold.

CREATE TABLE IF NOT EXISTS inflight_slots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS inflight_slots_account_expires
  ON inflight_slots (account_id, expires_at);

-- The claim counts running jobs per account; 0009 indexed jobs by client only.
CREATE INDEX IF NOT EXISTS async_jobs_account_status_created
  ON async_jobs (account_id, status, created_at);
