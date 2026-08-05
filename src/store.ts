// The persistence seam: row shapes and the ControlPlaneStore interface.
//
// AN INTERFACE RATHER THAN DIRECT D1 CALLS, for one concrete reason: it makes the whole request path
// -- auth, entitlement, quota, metering, the router itself -- testable in plain Node vitest with an
// in-memory fake, no workerd and no Miniflare. The estate pattern (vivijure-control-plane's
// ControlPlaneStore / store-d1 split) exists for the same reason, and the payoff is that the tests
// which matter here are about DECISIONS, not about SQL.
//
// Row types mirror migrations/0001_init.sql exactly, snake_case included. They are deliberately not
// prettified into camelCase at this layer: a row type that does not look like its table is a type that
// can silently drift from it.

export interface PlanRow {
  id: string;
  name: string;
  /** The opening prepaid grant, applied once at account creation. Renamed in migration 0002. */
  signup_credit_micro_usd: number;
  requests_per_minute: number;
  max_output_tokens: number;
  allowed_tiers: string;
}

export interface AccountRow {
  id: string;
  plan_id: string;
  label: string | null;
  created_at: string;
  suspended_at: string | null;
  /** Total prepaid credit granted, ever. Monotonic. See balance.ts. */
  credit_micro_usd: number;
  /** Total metered spend recorded, ever. Monotonic. */
  spent_micro_usd: number;
}

/**
 * One minted upstream credential.
 *
 * `token_enc` is CIPHERTEXT and must never be logged, returned, or compared. Timestamps are epoch
 * seconds (integers) rather than the ISO strings used elsewhere in the schema, because this row is
 * written and read by code that already works in epoch seconds for the rate limiter.
 */
export interface UserTokenRow {
  account_id: string;
  cf_token_id: string;
  token_enc: string;
  minted_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

/** An operator-set per-token rate. Overrides the compiled-in catalog price. */
export interface ModelPriceRow {
  model_id: string;
  input_micro_usd_per_mtok: number;
  output_micro_usd_per_mtok: number;
  priced_at: string;
  note: string | null;
}

export interface ClientRow {
  id: string;
  account_id: string;
  key_id: string;
  /** SHA-256 hex of the bearer secret. The plaintext is never stored. */
  secret_hash: string;
  label: string | null;
  platform: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface PeriodRow {
  account_id: string;
  period_key: string;
  micro_usd: number;
  requests: number;
  unmetered_requests: number;
}

/** One ledger write. Counts only; see the migration header for why there is no text field here. */
export interface UsageEvent {
  id: string;
  request_id: string;
  account_id: string;
  client_id: string;
  model_id: string;
  period_key: string;
  input_tokens: number | null;
  output_tokens: number | null;
  micro_usd: number;
  metered: boolean;
  unmetered_reason: string | null;
  upstream_status: number | null;
  gateway_log_id: string | null;
}

export interface RateBucket {
  count: number;
  /** Epoch seconds. */
  window_start: number;
}

export interface NewClient {
  id: string;
  account_id: string;
  key_id: string;
  secret_hash: string;
  label: string | null;
  platform: string | null;
}

export interface ControlPlaneStore {
  getPlan(id: string): Promise<PlanRow | null>;
  getAccount(id: string): Promise<AccountRow | null>;
  /**
   * Create an account and apply its plan's opening grant in ONE write.
   *
   * The grant is part of creation rather than a follow-up call because an account that exists with zero
   * credit is an account that 402s on its first request, and a two-step create leaves exactly that state
   * behind whenever the second step fails.
   */
  createAccount(args: {
    id: string;
    plan_id: string;
    label: string | null;
    credit_micro_usd: number;
    grant_id: string;
    grant_idempotency_key: string;
  }): Promise<AccountRow>;

  /**
   * Add prepaid credit. Idempotent on `idempotency_key`.
   *
   * Returns `applied: false` when the key was already used, which is a SUCCESS: a retried top-up must be
   * safe. The distinction is returned rather than hidden so an operator can tell "granted" from
   * "already granted" without reading the grants table.
   */
  grantCredit(args: {
    id: string;
    account_id: string;
    micro_usd: number;
    idempotency_key: string;
    note: string | null;
  }): Promise<{ applied: boolean; creditMicroUsd: number }>;

  /** Look up by the non-secret half of the bearer. The caller compares the secret hash itself. */
  getClientByKeyId(keyId: string): Promise<ClientRow | null>;
  /** Best-effort last-seen stamp. A failure here must never fail the request it belongs to. */
  touchClient(clientId: string): Promise<void>;
  createClient(client: NewClient): Promise<ClientRow>;
  /** Kill a client key. Idempotent; returns false when there was no such live client. */
  revokeClient(clientId: string): Promise<boolean>;

  /**
   * Redeem an enrollment token, returning the account it was scoped to, or null.
   *
   * MUST be single-use by a conditional write (an UPDATE guarded on consumed_at IS NULL), never a read
   * followed by a write: two devices redeeming the same token concurrently must not both succeed.
   */
  consumeEnrollment(tokenHash: string, clientId: string): Promise<{ account_id: string } | null>;
  createEnrollment(args: {
    token_hash: string;
    account_id: string;
    expires_at: string;
    note: string | null;
  }): Promise<void>;

  getPeriod(accountId: string, periodKey: string): Promise<PeriodRow | null>;

  /**
   * Write one ledger row, advance the period counter, and advance the account's spend.
   *
   * IDEMPOTENT on (client_id, request_id): a retried write is ignored rather than double-counted. Both
   * counter increments MUST be conditional on the ledger insert having actually happened, or a retry
   * would charge one request twice. The account spend is the one the money gate reads, so a
   * double-increment there is a user being denied service for a request they made once.
   */
  recordUsage(event: UsageEvent): Promise<void>;

  /** This account's minted upstream credential, live or revoked, or null when it never had one. */
  getUserToken(accountId: string): Promise<UserTokenRow | null>;
  /** Insert or replace the credential row. Called only after a successful mint. */
  putUserToken(row: UserTokenRow): Promise<void>;
  /** Stamp revoked_at. Called only AFTER Cloudflare confirmed the revocation. */
  markUserTokenRevoked(accountId: string, at: number): Promise<void>;
  /** Best-effort usage stamp. A failure here must never fail the request it belongs to. */
  touchUserToken(accountId: string, at: number): Promise<void>;
  /**
   * How many un-revoked upstream credentials this plane currently holds.
   *
   * This is the number the per-user token budget is checked against, and it counts what WE minted, not what
   * the Cloudflare account holds in total -- the account's 500 slots are shared with vivijure and with every
   * operator token, so this number is a floor on consumption and the budget must be set with that headroom
   * already subtracted.
   */
  countLiveUserTokens(): Promise<number>;

  /** An operator price override for one model, or null when none is set. */
  getModelPrice(modelId: string): Promise<ModelPriceRow | null>;
  /** Every override, for the operator surface and for GET /v1/models. */
  listModelPrices(): Promise<ModelPriceRow[]>;
  /** Set or replace one override. */
  putModelPrice(row: ModelPriceRow): Promise<void>;

  readRateBucket(key: string): Promise<RateBucket | null>;
  writeRateBucket(key: string, count: number, windowStart: number): Promise<void>;
  /** Epoch seconds from the STORE's clock, so the limiter and the stored windows agree. */
  nowEpochSeconds(): Promise<number>;

  /** Cheap probe for GET /health/deep. Resolves when the schema this code expects is present. */
  probeSchema(): Promise<void>;
}
