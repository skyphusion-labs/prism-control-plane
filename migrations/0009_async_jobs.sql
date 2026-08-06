-- Async long-run jobs (video / music) so mobile clients can poll instead of
-- holding an HTTP connection open through lock/suspend.
--
-- PRIVACY: result_json holds only asset URLs / flags (same posture as usage
-- ledger). Prompt, lyrics, and completion text MUST NOT be stored here.
-- The Worker keeps request body in the waitUntil closure for the run.

CREATE TABLE IF NOT EXISTS async_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  error_detail TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS async_jobs_client_created
  ON async_jobs (client_id, created_at DESC);
