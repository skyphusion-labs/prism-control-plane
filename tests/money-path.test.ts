// The money-path invariant, on the non-chat and workflow doors.
//
// THE INVARIANT: for any ledger row written as metered, the two pool columns must
// account for the whole price.
//
//     from_allowance_micro_usd + from_credit_micro_usd === micro_usd
//
// It matters because store-d1.recordUsage drives every money move from those two
// fields alone: allowance_spent advances by from_allowance, and accounts.spent
// advances only when from_credit is positive. A metered row with both at zero
// therefore advances usage_periods.micro_usd by the full price while neither pool
// moves. The row looks perfect and the money never leaves.
//
// It is also unrecoverable downstream, which is why it needs a test here rather
// than a reconciliation finding: reconcile compares micro_usd against the
// gateway's cost, and micro_usd is correct on such a row, so the delta is zero and
// it reports in_agreement forever. Reconcile never reads the pool columns.
//
// The state below is not hypothetical. The gate reads the balance before the
// upstream call and the meter re-reads it after, so a concurrent request that
// finishes the allowance in between leaves the meter looking at an exhausted
// balance for a request that was correctly admitted. chat.ts and the STT meter
// both take that overshoot deliberately.

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { handleRequest } from "../src/index";
import { mintClientKey } from "../src/auth";
import type { Env } from "../src/env";
import type { NonChatRunner, NonChatRunRequest, NonChatRunResult } from "../src/nonchat-upstream";
import type { CredentialOutcome, UpstreamCredentialSource } from "../src/token-minter";
import type { Ctx } from "../src/routes/shared";
import type { UsageEvent } from "../src/store";
import { FakeStore, testPlan } from "./fake-store";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

class FakeNonChatRunner implements NonChatRunner {
  calls: NonChatRunRequest[] = [];
  async run(request: NonChatRunRequest): Promise<NonChatRunResult> {
    this.calls.push(request);
    return { outcome: "ok", body: { image: "b64" }, gatewayLogId: "log_1", contentType: null };
  }
}

class FakeCredentials implements UpstreamCredentialSource {
  readonly mode = "shared" as const;
  async forAccount(): Promise<CredentialOutcome> {
    return { outcome: "ok", credential: { tokenId: "cftok_1", value: "cf-secret-value" }, minted: false };
  }
  async revokeForAccount(): Promise<boolean> {
    return true;
  }
}

/**
 * A store whose period read reports a FULLY BURNED allowance from the Nth call on.
 *
 * The pre-flight gate and the meter each call getPeriod once, so `burnFromCall: 2`
 * admits the request and then meters it against an exhausted balance. That is the
 * race described above, made deterministic -- not a state invented for the test.
 */
class RacingStore extends FakeStore {
  private periodCalls = 0;
  constructor(
    private readonly burnFromCall: number,
    private readonly burnTo: number,
    opts: ConstructorParameters<typeof FakeStore>[0],
  ) {
    super(opts);
  }
  async getPeriod(accountId: string, periodKey: string) {
    this.periodCalls += 1;
    const real = await super.getPeriod(accountId, periodKey);
    if (this.periodCalls < this.burnFromCall) return real;
    return {
      account_id: accountId,
      period_key: periodKey,
      micro_usd: real?.micro_usd ?? 0,
      requests: real?.requests ?? 0,
      unmetered_requests: real?.unmetered_requests ?? 0,
      adjust_spend_micro_usd: real?.adjust_spend_micro_usd ?? 0,
      adjust_credit_micro_usd: real?.adjust_credit_micro_usd ?? 0,
      allowance_spent_micro_usd: this.burnTo,
    };
  }
}

interface Harness {
  ctx: Ctx;
  store: FakeStore;
  key: string;
  settle: () => Promise<void>;
}

async function harness(options: { burnFromCall?: number } = {}): Promise<Harness> {
  // A REAL MONTHLY ALLOWANCE AND NO PREPAID CREDIT. testPlan() defaults the allowance
  // to zero, which with zero credit makes the balance exhausted before the request is
  // even admitted -- the gate refuses with 402 and the metering path is never reached.
  // The state under test needs the gate to PASS and the meter to see an exhausted
  // balance, so the allowance has to be real and the credit has to be absent.
  const monthlyIncluded = 50_000_000;
  const plan = testPlan({ monthly_included_micro_usd: monthlyIncluded });
  const store = options.burnFromCall
    ? new RacingStore(options.burnFromCall, monthlyIncluded, {
        nowSeconds: Math.floor(NOW.getTime() / 1000),
      })
    : new FakeStore({ nowSeconds: Math.floor(NOW.getTime() / 1000) });
  store.plans.set("test", plan);
  await store.createAccount({
    id: "acct_1",
    plan_id: "test",
    label: null,
    // No prepaid credit at all, so once the allowance is gone the balance reads
    // exhausted. spent (0) >= credit (0) is what makes that reachable.
    credit_micro_usd: 0,
    grant_id: "grant_seed",
    grant_idempotency_key: "signup:acct_1",
  });
  const minted = await mintClientKey();
  await store.createClient({
    id: minted.clientId,
    account_id: "acct_1",
    key_id: minted.keyId,
    secret_hash: minted.secretHash,
    label: "device",
    platform: "ios",
  });

  const deferred: Promise<unknown>[] = [];
  const ctx: Ctx = {
    env: {
      CF_ACCOUNT_ID: "fabcb25d9c7eb087110ec474a03e50d2",
      AI_GATEWAY_ID: "prism-proxy",
    } as Env,
    store,
    runner: null,
    nonChatRunner: new FakeNonChatRunner(),
    credentials: new FakeCredentials(),
    logs: null,
    requestId: "req_test0000000000000000",
    now: NOW,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
  } as unknown as Ctx;

  return {
    ctx,
    store,
    key: minted.key,
    settle: async () => {
      await Promise.allSettled(deferred);
    },
  };
}

function imageRequest(key: string): Request {
  return new Request("https://example.invalid/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt: "a cat" }),
  });
}

/** The invariant, applied to every metered row a test produced. */
function assertMeteredRowsAccountForTheirPrice(events: UsageEvent[]): void {
  const metered = events.filter((e) => e.metered);
  // Population floor: with no metered rows this assertion is vacuous, and a change
  // that stopped metering entirely would otherwise read as a pass.
  expect(metered.length).toBeGreaterThan(0);
  for (const e of metered) {
    expect({
      id: e.id,
      sum: e.from_allowance_micro_usd + e.from_credit_micro_usd,
      micro_usd: e.micro_usd,
    }).toEqual({ id: e.id, sum: e.micro_usd, micro_usd: e.micro_usd });
  }
}

describe("non-chat door: a metered row always accounts for its own price", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it("CONTROL: with balance available, the pools carry the whole price", async () => {
    const response = await handleRequest(h.ctx, imageRequest(h.key));
    await h.settle();
    expect(response.status).toBe(200);
    assertMeteredRowsAccountForTheirPrice(h.store.events);
    // And the money actually moved, which is the thing the invariant stands for.
    const period = await h.store.getPeriod("acct_1", "2026-08");
    expect(period?.allowance_spent_micro_usd).toBeGreaterThan(0);
  });

  it("still charges when the allowance is exhausted between the gate and the meter", async () => {
    // burnFromCall 2: the gate's read is untouched so the request is admitted, and
    // the meter's read reports the allowance fully spent.
    const raced = await harness({ burnFromCall: 2 });
    const response = await handleRequest(raced.ctx, imageRequest(raced.key));
    await raced.settle();
    expect(response.status).toBe(200);

    const metered = raced.store.events.filter((e) => e.metered);
    expect(metered).toHaveLength(1);
    expect(metered[0].micro_usd).toBeGreaterThan(0);
    // THE ASSERTION THAT MATTERS. Before this was fixed the row was written metered
    // with the correct micro_usd and both pool columns at zero, so the request was
    // served and never charged, and reconcile could not see it.
    assertMeteredRowsAccountForTheirPrice(raced.store.events);
    expect(metered[0].from_credit_micro_usd).toBe(metered[0].micro_usd);
  });
});

describe("the invariant travels by class, not by file", () => {
  // The end-to-end test above drives the non-chat door. The workflow door carries the
  // identical metering block, and a fix applied to one file and not the other is the
  // usual way this class of defect survives. This asserts BOTH, cheaply, so a
  // reintroduction in either is caught even though only one has a door harness.
  const FILES = ["src/routes/nonchat.ts", "src/routes/longrun-workflow.ts"];

  it("neither metering door gates its allocation on the balance outcome", () => {
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      // POSITIVE CONTROL: the block this matcher is aimed at really is in this file,
      // so a zero below is a fact about the file and not a wrong path or a typo.
      expect(src).toContain("const split = allocateCharge(priced.microUsd, {");
      // The gate itself must be gone. Allocating only while the balance still reads
      // "allow" writes a metered row whose pool columns are both zero, which moves
      // no money and which reconcile cannot detect.
      expect(src).not.toContain('balance.outcome === "allow"');
    }
  });

  it("CONTROL: the matcher does fire on the shape it forbids", () => {
    // Without this, "not.toContain" would pass equally against a typo in the needle.
    const sample = '  if (priced.microUsd > 0 && balance.outcome === "allow") {';
    expect(sample).toContain('balance.outcome === "allow"');
  });
});
