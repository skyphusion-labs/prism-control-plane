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
  included_micro_usd: number;
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
  createAccount(args: { id: string; plan_id: string; label: string | null }): Promise<AccountRow>;

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
   * Write one ledger row and advance the period counter, atomically enough that they cannot disagree.
   *
   * IDEMPOTENT on (client_id, request_id): a retried write is ignored rather than double-counted. The
   * counter increment MUST be conditional on the ledger insert having actually happened, or a retry
   * would advance the counter twice against one request.
   */
  recordUsage(event: UsageEvent): Promise<void>;

  readRateBucket(key: string): Promise<RateBucket | null>;
  writeRateBucket(key: string, count: number, windowStart: number): Promise<void>;
  /** Epoch seconds from the STORE's clock, so the limiter and the stored windows agree. */
  nowEpochSeconds(): Promise<number>;

  /** Cheap probe for GET /health/deep. Resolves when the schema this code expects is present. */
  probeSchema(): Promise<void>;
}
