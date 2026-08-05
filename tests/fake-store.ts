// In-memory ControlPlaneStore for the tests.
//
// This is the payoff for putting persistence behind an interface: the entire request path -- auth,
// entitlement, rate limit, quota, metering, routing -- runs in plain Node with no workerd, no Miniflare,
// and no network, so the tests are about DECISIONS rather than about SQL.
//
// It mirrors the D1 implementation's SEMANTICS where those semantics are load-bearing, which is the only
// way a test against this fake says anything about production:
//   - recordUsage is idempotent on (client_id, request_id) and only advances the counter when the ledger
//     row was actually new
//   - an unmetered event advances requests and unmetered_requests but NOT micro_usd
//   - consumeEnrollment is single-use and honours expiry
//   - revokeClient is idempotent and reports whether THIS call revoked a live client
//   - grantCredit is idempotent on the operator's key and reports whether THIS call granted
//   - a metered event advances accounts.spent_micro_usd, which is the column the money gate reads

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
} from "../src/store";

export interface FakeStoreOptions {
  /** Fixed clock in epoch seconds, so rate-limit windows are deterministic. */
  nowSeconds?: number;
}

export class FakeStore implements ControlPlaneStore {
  plans = new Map<string, PlanRow>();
  accounts = new Map<string, AccountRow>();
  clients = new Map<string, ClientRow>();
  enrollments = new Map<
    string,
    { account_id: string; expires_at: string; consumed_at: string | null; consumed_by_client: string | null }
  >();
  periods = new Map<string, PeriodRow>();
  events: UsageEvent[] = [];
  buckets = new Map<string, RateBucket>();
  userTokens = new Map<string, UserTokenRow>();
  modelPrices = new Map<string, ModelPriceRow>();
  grants = new Map<string, { account_id: string; micro_usd: number }>();
  nowSeconds: number;
  /** Set to make the next recordUsage throw, exercising the ledger-write-failure path. */
  failNextRecordUsage = false;
  probeFails = false;

  constructor(options: FakeStoreOptions = {}) {
    this.nowSeconds = options.nowSeconds ?? 1_785_900_000;
  }

  private iso(): string {
    return new Date(this.nowSeconds * 1000).toISOString();
  }

  async getPlan(id: string) {
    return this.plans.get(id) ?? null;
  }

  /**
   * A COPY, not the stored object, and this is load-bearing rather than tidiness.
   *
   * D1 returns a snapshot: a row read at the top of a request does not change underneath the handler when a
   * later write moves the same columns. Handing out the live Map value here breaks that, and it broke it in
   * the direction that matters -- `recordUsage` advancing `spent_micro_usd` retroactively changed the
   * `account` the route had already read, double-counting the spend in a response header. The bug was in this
   * fake and not in production, which is the worst kind: a test that fails for a reason the real store does
   * not have teaches the wrong lesson, and a test that PASSES that way hides a real one.
   */
  async getAccount(id: string) {
    const row = this.accounts.get(id);
    return row ? { ...row } : null;
  }

  async createAccount(args: {
    id: string;
    plan_id: string;
    label: string | null;
    credit_micro_usd: number;
    grant_id: string;
    grant_idempotency_key: string;
  }) {
    const row: AccountRow = {
      id: args.id,
      plan_id: args.plan_id,
      label: args.label,
      created_at: this.iso(),
      suspended_at: null,
      credit_micro_usd: args.credit_micro_usd,
      spent_micro_usd: 0,
    };
    this.accounts.set(row.id, row);
    this.grants.set(args.grant_idempotency_key, {
      account_id: row.id,
      micro_usd: args.credit_micro_usd,
    });
    return row;
  }

  /** Idempotent on the key, exactly like the D1 INSERT OR IGNORE it stands in for. */
  async grantCredit(args: {
    id: string;
    account_id: string;
    micro_usd: number;
    idempotency_key: string;
    note: string | null;
  }) {
    const account = this.accounts.get(args.account_id);
    const already = this.grants.has(args.idempotency_key);
    if (!already) {
      this.grants.set(args.idempotency_key, {
        account_id: args.account_id,
        micro_usd: args.micro_usd,
      });
      if (account) account.credit_micro_usd += args.micro_usd;
    }
    return { applied: !already, creditMicroUsd: account?.credit_micro_usd ?? 0 };
  }

  async getClientByKeyId(keyId: string) {
    for (const client of this.clients.values()) if (client.key_id === keyId) return client;
    return null;
  }

  async touchClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) client.last_seen_at = this.iso();
  }

  async createClient(client: NewClient) {
    const row: ClientRow = {
      id: client.id,
      account_id: client.account_id,
      key_id: client.key_id,
      secret_hash: client.secret_hash,
      label: client.label,
      platform: client.platform,
      created_at: this.iso(),
      last_seen_at: null,
      revoked_at: null,
    };
    this.clients.set(row.id, row);
    return row;
  }

  async revokeClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (!client || client.revoked_at) return false;
    client.revoked_at = this.iso();
    return true;
  }

  async consumeEnrollment(tokenHash: string, clientId: string) {
    const row = this.enrollments.get(tokenHash);
    if (!row) return null;
    if (row.consumed_at) return null;
    if (new Date(row.expires_at).getTime() <= this.nowSeconds * 1000) return null;
    row.consumed_at = this.iso();
    row.consumed_by_client = clientId;
    return { account_id: row.account_id };
  }

  async createEnrollment(args: {
    token_hash: string;
    account_id: string;
    expires_at: string;
    note: string | null;
  }) {
    this.enrollments.set(args.token_hash, {
      account_id: args.account_id,
      expires_at: args.expires_at,
      consumed_at: null,
      consumed_by_client: null,
    });
  }

  async getPeriod(accountId: string, periodKey: string) {
    return this.periods.get(`${accountId}|${periodKey}`) ?? null;
  }

  async recordUsage(event: UsageEvent) {
    if (this.failNextRecordUsage) {
      this.failNextRecordUsage = false;
      throw new Error("simulated ledger failure");
    }
    const duplicate = this.events.some(
      (existing) => existing.client_id === event.client_id && existing.request_id === event.request_id,
    );
    if (duplicate) return;
    this.events.push(event);

    const key = `${event.account_id}|${event.period_key}`;
    const row =
      this.periods.get(key) ??
      ({
        account_id: event.account_id,
        period_key: event.period_key,
        micro_usd: 0,
        requests: 0,
        unmetered_requests: 0,
      } satisfies PeriodRow);
    row.requests += 1;
    if (event.metered) row.micro_usd += event.micro_usd;
    else row.unmetered_requests += 1;
    this.periods.set(key, row);

    // The account counter the money gate reads. Advanced here for the same reason the D1 store does it:
    // a test that asserts the prepaid gate must see spend where production sees it.
    if (event.metered && event.micro_usd > 0) {
      const account = this.accounts.get(event.account_id);
      if (account) account.spent_micro_usd += event.micro_usd;
    }
  }

  async getUserToken(accountId: string) {
    return this.userTokens.get(accountId) ?? null;
  }

  async putUserToken(row: UserTokenRow) {
    this.userTokens.set(row.account_id, { ...row });
  }

  async markUserTokenRevoked(accountId: string, at: number) {
    const row = this.userTokens.get(accountId);
    if (row && row.revoked_at === null) row.revoked_at = at;
  }

  async touchUserToken(accountId: string, at: number) {
    const row = this.userTokens.get(accountId);
    if (row) row.last_used_at = at;
  }

  async countLiveUserTokens() {
    let n = 0;
    for (const row of this.userTokens.values()) if (row.revoked_at === null) n += 1;
    return n;
  }

  async getModelPrice(modelId: string) {
    return this.modelPrices.get(modelId) ?? null;
  }

  async listModelPrices() {
    return [...this.modelPrices.values()].sort((a, b) => a.model_id.localeCompare(b.model_id));
  }

  async putModelPrice(row: ModelPriceRow) {
    this.modelPrices.set(row.model_id, { ...row });
  }

  async readRateBucket(key: string) {
    return this.buckets.get(key) ?? null;
  }

  async writeRateBucket(key: string, count: number, windowStart: number) {
    this.buckets.set(key, { count, window_start: windowStart });
  }

  async nowEpochSeconds() {
    return this.nowSeconds;
  }

  async probeSchema() {
    if (this.probeFails) throw new Error("simulated schema probe failure");
  }
}

/** A plan whose numbers are convenient for arithmetic assertions, not a product tier. */
export function testPlan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: "test",
    name: "Test",
    signup_credit_micro_usd: 1_000_000,
    requests_per_minute: 20,
    max_output_tokens: 1024,
    allowed_tiers: "standard",
    ...overrides,
  };
}
