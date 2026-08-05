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

import type {
  AccountRow,
  ClientRow,
  ControlPlaneStore,
  NewClient,
  PeriodRow,
  PlanRow,
  RateBucket,
  UsageEvent,
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

  async getAccount(id: string) {
    return this.accounts.get(id) ?? null;
  }

  async createAccount(args: { id: string; plan_id: string; label: string | null }) {
    const row: AccountRow = {
      id: args.id,
      plan_id: args.plan_id,
      label: args.label,
      created_at: this.iso(),
      suspended_at: null,
    };
    this.accounts.set(row.id, row);
    return row;
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
    included_micro_usd: 1_000_000,
    requests_per_minute: 20,
    max_output_tokens: 1024,
    allowed_tiers: "standard",
    ...overrides,
  };
}
