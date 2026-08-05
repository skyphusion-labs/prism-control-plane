// The concrete D1 ControlPlaneStore. The one place SQL lives.
//
// Everything above this file is pure or interface-driven, so this is the un-stubbable seam: production
// wires exactly this, tests replace the whole thing, and there is no third code path.

import type {
  AccountRow,
  ClientRow,
  ControlPlaneStore,
  ModelPriceRow,
  NewClient,
  PeriodRow,
  PlanRow,
  RateBucket,
  UsageEvent,
  UserTokenRow,
} from "./store";

const ACCOUNT_COLUMNS =
  "id, plan_id, label, created_at, suspended_at, credit_micro_usd, spent_micro_usd";

export function d1Store(db: D1Database): ControlPlaneStore {
  return {
    async getPlan(id) {
      return await db
        .prepare(
          `SELECT id, name, signup_credit_micro_usd, requests_per_minute, max_output_tokens,
                  allowed_tiers
             FROM plans WHERE id = ?`,
        )
        .bind(id)
        .first<PlanRow>();
    },

    async getAccount(id) {
      return await db
        .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`)
        .bind(id)
        .first<AccountRow>();
    },

    /**
     * Create the account WITH its opening grant, and write the grant row in the same batch.
     *
     * D1's batch is atomic, which is what makes "an account always has a grant row explaining its
     * credit" a schema-level truth rather than a habit. Splitting them would eventually produce an
     * account whose credit no grant accounts for, and reconciliation of a money column against nothing
     * is not reconciliation.
     */
    async createAccount(args) {
      await db.batch([
        db
          .prepare(`INSERT INTO accounts (id, plan_id, label, credit_micro_usd) VALUES (?, ?, ?, ?)`)
          .bind(args.id, args.plan_id, args.label, args.credit_micro_usd),
        db
          .prepare(
            `INSERT INTO credit_grants (id, account_id, micro_usd, idempotency_key, note)
             VALUES (?, ?, ?, ?, 'opening grant from plan signup credit')`,
          )
          .bind(args.grant_id, args.id, args.credit_micro_usd, args.grant_idempotency_key),
      ]);
      const row = await db
        .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`)
        .bind(args.id)
        .first<AccountRow>();
      if (!row) throw new Error(`account ${args.id} was inserted but could not be read back`);
      return row;
    },

    /**
     * Add credit, idempotent on the operator's key.
     *
     * INSERT OR IGNORE, then advance the account only when the insert landed. Same pattern as
     * recordUsage and for the same reason: a retried top-up must not grant the money twice, and the
     * database is the only place that can decide "have I seen this key" without a race.
     */
    async grantCredit(args) {
      const insert = await db
        .prepare(
          `INSERT OR IGNORE INTO credit_grants (id, account_id, micro_usd, idempotency_key, note)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(args.id, args.account_id, args.micro_usd, args.idempotency_key, args.note)
        .run();
      if (insert.meta.changes) {
        await db
          .prepare(`UPDATE accounts SET credit_micro_usd = credit_micro_usd + ? WHERE id = ?`)
          .bind(args.micro_usd, args.account_id)
          .run();
      }
      const row = await db
        .prepare(`SELECT credit_micro_usd FROM accounts WHERE id = ?`)
        .bind(args.account_id)
        .first<{ credit_micro_usd: number }>();
      return {
        applied: Boolean(insert.meta.changes),
        creditMicroUsd: row?.credit_micro_usd ?? 0,
      };
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

      // THE MONEY GATE READS THIS COLUMN, not usage_periods. It is advanced last because it is the one
      // increment that can deny the user their next request: if the process dies between the two writes,
      // the account has been under-charged (recoverable, re-summable from usage_events) rather than
      // locked out over a write that only half happened.
      if (event.metered && event.micro_usd > 0) {
        await db
          .prepare(`UPDATE accounts SET spent_micro_usd = spent_micro_usd + ? WHERE id = ?`)
          .bind(event.micro_usd, event.account_id)
          .run();
      }
    },

    async getUserToken(accountId) {
      return await db
        .prepare(
          `SELECT account_id, cf_token_id, token_enc, minted_at, revoked_at, last_used_at
             FROM user_tokens WHERE account_id = ?`,
        )
        .bind(accountId)
        .first<UserTokenRow>();
    },

    /**
     * INSERT OR REPLACE, deliberately.
     *
     * A re-mint after a revocation must overwrite the dead row rather than fail on the primary key. The
     * old ciphertext is not kept: the credential it decrypts to is already revoked at Cloudflare, so
     * retaining it would preserve nothing but an attack surface.
     */
    async putUserToken(row: UserTokenRow) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO user_tokens
             (account_id, cf_token_id, token_enc, minted_at, revoked_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.account_id,
          row.cf_token_id,
          row.token_enc,
          row.minted_at,
          row.revoked_at,
          row.last_used_at,
        )
        .run();
    },

    async countLiveUserTokens() {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM user_tokens WHERE revoked_at IS NULL`)
        .first<{ n: number }>();
      // A count that cannot be read is treated as "budget spent", not "budget free". Guessing zero here
      // would turn a transient D1 error into permission to mint past the account quota.
      if (!row || typeof row.n !== "number") throw new Error("live user token count unavailable");
      return row.n;
    },

    async markUserTokenRevoked(accountId, at) {
      await db
        .prepare(`UPDATE user_tokens SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`)
        .bind(at, accountId)
        .run();
    },

    async touchUserToken(accountId, at) {
      await db
        .prepare(`UPDATE user_tokens SET last_used_at = ? WHERE account_id = ?`)
        .bind(at, accountId)
        .run();
    },

    async getModelPrice(modelId) {
      return await db
        .prepare(
          `SELECT model_id, input_micro_usd_per_mtok, output_micro_usd_per_mtok, priced_at, note
             FROM model_prices WHERE model_id = ?`,
        )
        .bind(modelId)
        .first<ModelPriceRow>();
    },

    async listModelPrices() {
      const result = await db
        .prepare(
          `SELECT model_id, input_micro_usd_per_mtok, output_micro_usd_per_mtok, priced_at, note
             FROM model_prices ORDER BY model_id`,
        )
        .all<ModelPriceRow>();
      return result.results ?? [];
    },

    async putModelPrice(row: ModelPriceRow) {
      await db
        .prepare(
          `INSERT INTO model_prices
             (model_id, input_micro_usd_per_mtok, output_micro_usd_per_mtok, priced_at, note)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(model_id) DO UPDATE SET
             input_micro_usd_per_mtok  = excluded.input_micro_usd_per_mtok,
             output_micro_usd_per_mtok = excluded.output_micro_usd_per_mtok,
             priced_at                 = excluded.priced_at,
             note                      = excluded.note,
             updated_at                = datetime('now')`,
        )
        .bind(
          row.model_id,
          row.input_micro_usd_per_mtok,
          row.output_micro_usd_per_mtok,
          row.priced_at,
          row.note,
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
      // Migration 0002's tables. Named explicitly rather than assumed present: a database that got 0001
      // and not 0002 is exactly the half-migrated state a deploy can leave behind, and it would fail on
      // the first mint instead of at the health check.
      await db.prepare(`SELECT COUNT(*) AS n FROM user_tokens`).first<{ n: number }>();
      await db.prepare(`SELECT COUNT(*) AS n FROM credit_grants`).first<{ n: number }>();
      await db.prepare(`SELECT COUNT(*) AS n FROM model_prices`).first<{ n: number }>();
    },
  };
}
