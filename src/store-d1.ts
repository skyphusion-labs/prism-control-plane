// The concrete D1 ControlPlaneStore. The one place SQL lives.
//
// Everything above this file is pure or interface-driven, so this is the un-stubbable seam: production
// wires exactly this, tests replace the whole thing, and there is no third code path.

import type {
  AccountRow,
  ClientRow,
  ControlPlaneStore,
  NewClient,
  PeriodRow,
  PlanRow,
  RateBucket,
  UsageEvent,
} from "./store";

export function d1Store(db: D1Database): ControlPlaneStore {
  return {
    async getPlan(id) {
      return await db
        .prepare(
          `SELECT id, name, included_micro_usd, requests_per_minute, max_output_tokens, allowed_tiers
             FROM plans WHERE id = ?`,
        )
        .bind(id)
        .first<PlanRow>();
    },

    async getAccount(id) {
      return await db
        .prepare(`SELECT id, plan_id, label, created_at, suspended_at FROM accounts WHERE id = ?`)
        .bind(id)
        .first<AccountRow>();
    },

    async createAccount(args) {
      await db
        .prepare(`INSERT INTO accounts (id, plan_id, label) VALUES (?, ?, ?)`)
        .bind(args.id, args.plan_id, args.label)
        .run();
      const row = await db
        .prepare(`SELECT id, plan_id, label, created_at, suspended_at FROM accounts WHERE id = ?`)
        .bind(args.id)
        .first<AccountRow>();
      if (!row) throw new Error(`account ${args.id} was inserted but could not be read back`);
      return row;
    },

    async getClientByKeyId(keyId) {
      return await db
        .prepare(
          `SELECT id, account_id, key_id, secret_hash, label, platform, created_at, last_seen_at,
                  revoked_at
             FROM clients WHERE key_id = ?`,
        )
        .bind(keyId)
        .first<ClientRow>();
    },

    async touchClient(clientId) {
      await db
        .prepare(`UPDATE clients SET last_seen_at = datetime('now') WHERE id = ?`)
        .bind(clientId)
        .run();
    },

    async createClient(client: NewClient) {
      await db
        .prepare(
          `INSERT INTO clients (id, account_id, key_id, secret_hash, label, platform)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          client.id,
          client.account_id,
          client.key_id,
          client.secret_hash,
          client.label,
          client.platform,
        )
        .run();
      const row = await db
        .prepare(
          `SELECT id, account_id, key_id, secret_hash, label, platform, created_at, last_seen_at,
                  revoked_at
             FROM clients WHERE id = ?`,
        )
        .bind(client.id)
        .first<ClientRow>();
      // A row that vanished between INSERT and SELECT is not a case to paper over with a synthesized
      // object: it would mean the write did not land, and the caller is about to hand a bearer key to
      // a device for a client that does not exist.
      if (!row) throw new Error(`client ${client.id} was inserted but could not be read back`);
      return row;
    },

    /**
     * Revoke, guarded on `revoked_at IS NULL` so the stamp records the FIRST revocation rather than the
     * most recent call. `changes` therefore answers "did this call revoke a live client", which is what
     * an operator asking twice needs to be told apart.
     */
    async revokeClient(clientId) {
      const result = await db
        .prepare(`UPDATE clients SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`)
        .bind(clientId)
        .run();
      return Boolean(result.meta.changes);
    },

    /**
     * Single-use redemption, enforced by the UPDATE's own WHERE clause.
     *
     * `meta.changes` is the guard. A SELECT-then-UPDATE would let two concurrent enrollments both see
     * an unconsumed token and both proceed; here exactly one UPDATE can match, so exactly one caller
     * gets a row back. Expiry is compared in SQLite so the comparison uses the same clock as the
     * stored timestamps rather than the Worker's.
     */
    async consumeEnrollment(tokenHash, clientId) {
      const result = await db
        .prepare(
          `UPDATE enrollments
              SET consumed_at = datetime('now'), consumed_by_client = ?
            WHERE token_hash = ?
              AND consumed_at IS NULL
              AND datetime(expires_at) > datetime('now')`,
        )
        .bind(clientId, tokenHash)
        .run();
      if (!result.meta.changes) return null;
      return await db
        .prepare(`SELECT account_id FROM enrollments WHERE token_hash = ?`)
        .bind(tokenHash)
        .first<{ account_id: string }>();
    },

    async createEnrollment(args) {
      await db
        .prepare(
          `INSERT INTO enrollments (token_hash, account_id, expires_at, note)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(args.token_hash, args.account_id, args.expires_at, args.note)
        .run();
    },

    async getPeriod(accountId, periodKey) {
      return await db
        .prepare(
          `SELECT account_id, period_key, micro_usd, requests, unmetered_requests
             FROM usage_periods WHERE account_id = ? AND period_key = ?`,
        )
        .bind(accountId, periodKey)
        .first<PeriodRow>();
    },

    /**
     * Ledger row plus counter advance.
     *
     * ORDER AND CONDITIONALITY ARE LOAD-BEARING. The ledger insert is `INSERT OR IGNORE` on the
     * (client_id, request_id) unique index, and the counter is only advanced when that insert reported
     * a change. Doing them as an unconditional batch would advance the counter on a retry whose ledger
     * row was ignored, so the rolled-up total would drift ABOVE the sum of the rows it summarises --
     * silently over-charging, and detectable only by someone who thought to compare the two.
     *
     * The two statements are not in one D1 batch precisely because the second depends on the first's
     * result. The window between them is the accepted cost: a failure there loses a counter advance,
     * leaving the total BELOW the ledger. That direction is recoverable (the rows are still there to
     * re-sum) and under-charges rather than over-charges, which is the right way for this to break.
     */
    async recordUsage(event: UsageEvent) {
      const insert = await db
        .prepare(
          `INSERT OR IGNORE INTO usage_events
             (id, request_id, account_id, client_id, model_id, period_key, input_tokens,
              output_tokens, micro_usd, metered, unmetered_reason, upstream_status, gateway_log_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          event.id,
          event.request_id,
          event.account_id,
          event.client_id,
          event.model_id,
          event.period_key,
          event.input_tokens,
          event.output_tokens,
          event.micro_usd,
          event.metered ? 1 : 0,
          event.unmetered_reason,
          event.upstream_status,
          event.gateway_log_id,
        )
        .run();
      if (!insert.meta.changes) return;

      // An unmetered request advances `requests` and `unmetered_requests` but NOT `micro_usd`. That is
      // the whole point of the third outcome: the call is counted, the gap is counted, and nothing is
      // charged from a number we do not have.
      await db
        .prepare(
          `INSERT INTO usage_periods (account_id, period_key, micro_usd, requests, unmetered_requests)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(account_id, period_key) DO UPDATE SET
             micro_usd          = micro_usd + excluded.micro_usd,
             requests           = requests + 1,
             unmetered_requests = unmetered_requests + excluded.unmetered_requests,
             updated_at         = datetime('now')`,
        )
        .bind(
          event.account_id,
          event.period_key,
          event.metered ? event.micro_usd : 0,
          event.metered ? 0 : 1,
        )
        .run();
    },

    async readRateBucket(key) {
      return await db
        .prepare(`SELECT count, window_start FROM rate_buckets WHERE bucket_key = ?`)
        .bind(key)
        .first<RateBucket>();
    },

    async writeRateBucket(key, count, windowStart) {
      await db
        .prepare(
          `INSERT INTO rate_buckets (bucket_key, count, window_start)
           VALUES (?, ?, ?)
           ON CONFLICT(bucket_key) DO UPDATE SET
             count = excluded.count,
             window_start = excluded.window_start`,
        )
        .bind(key, count, windowStart)
        .run();
    },

    /**
     * The clock comes from D1, not from the Worker.
     *
     * Stored window starts are written from this same source, so reading it here means the limiter
     * compares two values from one clock. Mixing a Worker `Date.now()` with SQLite-written timestamps
     * is how a limiter ends up either permanently open or permanently shut when the two drift.
     */
    async nowEpochSeconds() {
      const row = await db
        .prepare(`SELECT CAST(strftime('%s','now') AS INTEGER) AS now`)
        .first<{ now: number }>();
      if (!row) throw new Error("D1 did not answer the clock probe");
      return row.now;
    },

    /**
     * Deep-health probe.
     *
     * Reads the ONE row that must exist for the plane to function (a plan) and touches the ledger
     * tables. A bare `SELECT 1` would prove D1 is reachable while a database with no migrations applied
     * sailed through, which is exactly the state a fresh deploy is in.
     */
    async probeSchema() {
      await db.prepare(`SELECT COUNT(*) AS n FROM plans`).first<{ n: number }>();
      await db.prepare(`SELECT COUNT(*) AS n FROM usage_periods`).first<{ n: number }>();
      await db.prepare(`SELECT COUNT(*) AS n FROM clients`).first<{ n: number }>();
    },
  };
}
