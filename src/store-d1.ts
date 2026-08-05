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
  ReconcileStateRow,
  UsageAdjustmentRow,
  UsageEvent,
  UsageEventKey,
  UserTokenRow,
} from "./store";

const ACCOUNT_COLUMNS =
  "id, plan_id, label, created_at, suspended_at, credit_micro_usd, spent_micro_usd";

const USAGE_EVENT_COLUMNS =
  "id, request_id, account_id, client_id, model_id, period_key, input_tokens, output_tokens, " +
  "micro_usd, from_allowance_micro_usd, from_credit_micro_usd, metered, unmetered_reason, " +
  "upstream_status, gateway_log_id";

export function d1Store(db: D1Database): ControlPlaneStore {
  return {
    async getPlan(id) {
      return await db
        .prepare(
          `SELECT id, name, signup_credit_micro_usd, monthly_included_micro_usd, requests_per_minute,
                  max_output_tokens, allowed_tiers
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
          `SELECT account_id, period_key, micro_usd, requests, unmetered_requests,
                  adjust_spend_micro_usd, adjust_credit_micro_usd, allowance_spent_micro_usd
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
      const fromAllowance = event.metered ? event.from_allowance_micro_usd : 0;
      const fromCredit = event.metered ? event.from_credit_micro_usd : 0;
      const insert = await db
        .prepare(
          `INSERT OR IGNORE INTO usage_events
             (id, request_id, account_id, client_id, model_id, period_key, input_tokens,
              output_tokens, micro_usd, from_allowance_micro_usd, from_credit_micro_usd,
              metered, unmetered_reason, upstream_status, gateway_log_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          fromAllowance,
          fromCredit,
          event.metered ? 1 : 0,
          event.unmetered_reason,
          event.upstream_status,
          event.gateway_log_id,
        )
        .run();
      if (!insert.meta.changes) return;

      // An unmetered request advances `requests` and `unmetered_requests` but NOT money columns. That is
      // the whole point of the third outcome: the call is counted, the gap is counted, and nothing is
      // charged from a number we do not have.
      await db
        .prepare(
          `INSERT INTO usage_periods
             (account_id, period_key, micro_usd, requests, unmetered_requests, allowance_spent_micro_usd)
           VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT(account_id, period_key) DO UPDATE SET
             micro_usd                 = micro_usd + excluded.micro_usd,
             requests                  = requests + 1,
             unmetered_requests        = unmetered_requests + excluded.unmetered_requests,
             allowance_spent_micro_usd = allowance_spent_micro_usd + excluded.allowance_spent_micro_usd,
             updated_at                = datetime('now')`,
        )
        .bind(
          event.account_id,
          event.period_key,
          event.metered ? event.micro_usd : 0,
          event.metered ? 0 : 1,
          fromAllowance,
        )
        .run();

      // Prepaid spend only. Allowance never touches this column; the gate reads both pools.
      // Advanced last so a crash between writes under-charges (recoverable) rather than locks out.
      if (event.metered && fromCredit > 0) {
        await db
          .prepare(`UPDATE accounts SET spent_micro_usd = spent_micro_usd + ? WHERE id = ?`)
          .bind(fromCredit, event.account_id)
          .run();
      }
    },

    /**
     * Read one ledger row by correlation id.
     *
     * `metered` IS MAPPED, NOT CAST. SQLite has no boolean, so the column is an INTEGER and a bare
     * `first<UsageEvent>()` would hand back `metered: 1`, which is truthy and therefore works right up
     * until something compares it to `true` or serialises it. The reconciliation decision branches on
     * this field, so the mapping happens here rather than at each reader.
     */
    async getUsageEventByRequestId(requestId) {
      const row = await db
        .prepare(`SELECT ${USAGE_EVENT_COLUMNS} FROM usage_events WHERE request_id = ? LIMIT 1`)
        .bind(requestId)
        .first<Record<string, unknown>>();
      if (!row) return null;
      return { ...row, metered: Boolean(row.metered) } as UsageEvent;
    },

    /**
     * One true-up: the audit row, then the money.
     *
     * THE ORDER IS DELIBERATE AND THE WINDOW BETWEEN THEM IS AN ACCEPTED COST, the same trade store
     * `recordUsage` makes two functions up. The audit insert is the idempotency gate, so it has to come
     * first: writing the money first and dying before the audit row would let a re-run apply it a second
     * time, and a double charge or a double credit is the one outcome that is not recoverable by reading
     * the tables afterwards.
     *
     * So a failure between the two leaves an adjustment row whose money never moved. That direction is
     * recoverable and detectable: sum `usage_adjustments` by direction and compare it to the account's
     * columns. It under-applies rather than over-applies, which is the right way for a robot with write
     * access to a money column to break.
     *
     * The money statements are ONE D1 BATCH, so a partial money move cannot happen: an account whose
     * balance moved but whose period rollup did not would make the monthly view disagree with the
     * balance for no recorded reason.
     */
    async applyUsageAdjustment(row: UsageAdjustmentRow) {
      const insert = await db
        .prepare(
          `INSERT OR IGNORE INTO usage_adjustments
             (id, account_id, usage_event_id, request_id, gateway_log_id, period_key, model_id,
              estimate_micro_usd, gateway_micro_usd, delta_micro_usd, direction, applied_micro_usd,
              idempotency_key, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.account_id,
          row.usage_event_id,
          row.request_id,
          row.gateway_log_id,
          row.period_key,
          row.model_id,
          row.estimate_micro_usd,
          row.gateway_micro_usd,
          row.delta_micro_usd,
          row.direction,
          row.applied_micro_usd,
          row.idempotency_key,
          row.note,
        )
        .run();
      if (!insert.meta.changes) return { applied: false };

      // The period rollup gets its own monotonic counter per direction. Adding the drift into
      // `micro_usd` instead would destroy the estimate-versus-actual comparison the ledger exists for.
      const periodUpsert = db
        .prepare(
          `INSERT INTO usage_periods
             (account_id, period_key, micro_usd, requests, unmetered_requests,
              adjust_spend_micro_usd, adjust_credit_micro_usd)
           VALUES (?, ?, 0, 0, 0, ?, ?)
           ON CONFLICT(account_id, period_key) DO UPDATE SET
             adjust_spend_micro_usd  = adjust_spend_micro_usd + excluded.adjust_spend_micro_usd,
             adjust_credit_micro_usd = adjust_credit_micro_usd + excluded.adjust_credit_micro_usd,
             updated_at              = datetime('now')`,
        )
        .bind(
          row.account_id,
          row.period_key,
          row.direction === "spend" ? row.applied_micro_usd : 0,
          row.direction === "credit" ? row.applied_micro_usd : 0,
        );

      if (row.direction === "spend") {
        await db.batch([
          db
            .prepare(`UPDATE accounts SET spent_micro_usd = spent_micro_usd + ? WHERE id = ?`)
            .bind(row.applied_micro_usd, row.account_id),
          periodUpsert,
        ]);
        return { applied: true };
      }

      // A DOWNWARD TRUE-UP IS A GRANT, with its own row in the same audit table every other top-up
      // lands in. It shares the adjustment's idempotency key, which is namespaced (`aig:`) so it cannot
      // collide with an operator's invoice reference or with the `signup:` opening grant.
      await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO credit_grants (id, account_id, micro_usd, idempotency_key, note)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id,
            row.account_id,
            row.applied_micro_usd,
            row.idempotency_key,
            row.note ?? `reconciliation credit for gateway log ${row.gateway_log_id}`,
          ),
        db
          .prepare(`UPDATE accounts SET credit_micro_usd = credit_micro_usd + ? WHERE id = ?`)
          .bind(row.applied_micro_usd, row.account_id),
        periodUpsert,
      ]);
      return { applied: true };
    },

    async getReconcileState(gatewayId) {
      return await db
        .prepare(
          `SELECT gateway_id, watermark, last_log_id, last_run_at, runs, rows_seen, rows_adjusted
             FROM reconcile_state WHERE gateway_id = ?`,
        )
        .bind(gatewayId)
        .first<ReconcileStateRow>();
    },

    /**
     * Record a run.
     *
     * `COALESCE(?, watermark)` is what makes a null advance mean "leave it alone". Writing the null
     * through would reset the gateway to the beginning of its history, and the next run would page every
     * log row Cloudflare still holds.
     */
    async advanceReconcileState(args) {
      await db
        .prepare(
          `INSERT INTO reconcile_state
             (gateway_id, watermark, last_log_id, last_run_at, runs, rows_seen, rows_adjusted)
           VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(gateway_id) DO UPDATE SET
             watermark     = COALESCE(excluded.watermark, reconcile_state.watermark),
             last_log_id   = COALESCE(excluded.last_log_id, reconcile_state.last_log_id),
             last_run_at   = excluded.last_run_at,
             runs          = reconcile_state.runs + 1,
             rows_seen     = reconcile_state.rows_seen + excluded.rows_seen,
             rows_adjusted = reconcile_state.rows_adjusted + excluded.rows_adjusted,
             updated_at    = datetime('now')`,
        )
        .bind(
          args.gateway_id,
          args.watermark,
          args.last_log_id,
          args.at,
          args.rows_seen,
          args.rows_adjusted,
        )
        .run();
    },

    /**
     * Ledger rows inside a window.
     *
     * COMPARED WITH `datetime()` ON BOTH SIDES, not as strings. `usage_events.created_at` is written by
     * SQLite's `datetime('now')`, which produces `YYYY-MM-DD HH:MM:SS`; the watermark is ISO 8601 with a
     * `T` and a `Z`. Those two shapes do not compare lexically, and the failure would be silent -- an
     * empty result set reads exactly like "nothing unmatched", which is the answer this query exists to
     * distrust.
     */
    async listUsageEventsBetween(args) {
      const result = await db
        .prepare(
          `SELECT id, request_id, micro_usd, metered, created_at
             FROM usage_events
            WHERE datetime(created_at) > datetime(?)
              AND datetime(created_at) <= datetime(?)
            ORDER BY created_at
            LIMIT ?`,
        )
        .bind(args.fromIso, args.toIso, Math.max(0, Math.trunc(args.limit)))
        .all<Record<string, unknown>>();
      return (result.results ?? []).map(
        (row) =>
          ({
            id: String(row.id),
            request_id: String(row.request_id),
            micro_usd: Number(row.micro_usd),
            metered: Boolean(row.metered),
            created_at: String(row.created_at),
          }) satisfies UsageEventKey,
      );
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

    async claimRateBucket(key, nowSec, windowSeconds) {
      // One UPSERT: concurrent claims cannot all read the same count and all pass.
      // Window roll: when now - window_start >= windowSeconds, reset to count=1 at now.
      const row = await db
        .prepare(
          `INSERT INTO rate_buckets (bucket_key, count, window_start)
           VALUES (?, 1, ?)
           ON CONFLICT(bucket_key) DO UPDATE SET
             count = CASE
               WHEN (? - rate_buckets.window_start) >= ? THEN 1
               ELSE rate_buckets.count + 1
             END,
             window_start = CASE
               WHEN (? - rate_buckets.window_start) >= ? THEN ?
               ELSE rate_buckets.window_start
             END
           RETURNING count, window_start`,
        )
        .bind(key, nowSec, nowSec, windowSeconds, nowSec, windowSeconds, nowSec)
        .first<RateBucket>();
      if (!row) throw new Error(`rate_buckets claim for ${key} returned no row`);
      return row;
    },

    async putPlan(row) {
      await db
        .prepare(
          `INSERT INTO plans (
             id, name, signup_credit_micro_usd, monthly_included_micro_usd,
             requests_per_minute, max_output_tokens, allowed_tiers
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             signup_credit_micro_usd = excluded.signup_credit_micro_usd,
             monthly_included_micro_usd = excluded.monthly_included_micro_usd,
             requests_per_minute = excluded.requests_per_minute,
             max_output_tokens = excluded.max_output_tokens,
             allowed_tiers = excluded.allowed_tiers`,
        )
        .bind(
          row.id,
          row.name,
          row.signup_credit_micro_usd,
          row.monthly_included_micro_usd,
          row.requests_per_minute,
          row.max_output_tokens,
          row.allowed_tiers,
        )
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
