// The reconciliation decision, in isolation.
//
// FIVE OF THE SEVEN OUTCOMES MOVE NOTHING, and that is what most of this file asserts. A job with write
// access to a money column, fed from another system's telemetry, is only trustworthy if its refusals are
// tested at least as hard as its actions -- so each refusal gets its own case here rather than being
// covered incidentally by a happy path.

import { describe, expect, it } from "vitest";
import {
  MAX_ROWS_PER_RUN,
  SETTLE_MS,
  adjustmentIdempotencyKey,
  decideAdjustment,
  emptyTotals,
  nextWatermark,
  tally,
  type LedgerEstimate,
  type ReconcileDecision,
} from "../src/reconcile";
import { logRow } from "./fake-gateway-logs";

function estimate(overrides: Partial<LedgerEstimate> = {}): LedgerEstimate {
  return {
    id: "ue_1",
    request_id: "req_1",
    account_id: "acct_1",
    period_key: "2026-08",
    model_id: "@cf/meta/llama-3.1-8b-instruct",
    micro_usd: 1000,
    metered: true,
    ...overrides,
  };
}

const AT = "2026-08-05T00:00:00.000Z";

describe("decideAdjustment", () => {
  it("adjusts spend upward when the biller charged more than we estimated", () => {
    const outcome = decideAdjustment(
      logRow({ id: "log_1", createdAt: AT, requestId: "req_1", costMicroUsd: 1500 }),
      estimate(),
    );
    expect(outcome).toEqual({
      outcome: "adjust",
      direction: "spend",
      appliedMicroUsd: 500,
      deltaMicroUsd: 500,
      estimateMicroUsd: 1000,
      gatewayMicroUsd: 1500,
      event: estimate(),
    });
  });

  it("grants credit rather than decrementing spend when the biller charged less", () => {
    // Both money columns on `accounts` are monotonic by construction so each can be re-summed against its
    // own audit trail. Decrementing spend would reach the same balance and destroy that property.
    const outcome = decideAdjustment(
      logRow({ id: "log_1", createdAt: AT, requestId: "req_1", costMicroUsd: 400 }),
      estimate(),
    );
    expect(outcome).toMatchObject({
      outcome: "adjust",
      direction: "credit",
      appliedMicroUsd: 600,
      // The DELTA stays signed, so the row records which way the meter was wrong.
      deltaMicroUsd: -600,
    });
  });

  it("prices an unmetered row from zero, which is the case it exists for most", () => {
    // A timeout or a stream with no trailing usage frame is recorded with a reason and a zero charge. This
    // is how it later acquires the real cost instead of staying a permanent free ride.
    const outcome = decideAdjustment(
      logRow({ id: "log_1", createdAt: AT, requestId: "req_1", costMicroUsd: 900 }),
      estimate({ metered: false, micro_usd: 0 }),
    );
    expect(outcome).toMatchObject({
      outcome: "adjust",
      direction: "spend",
      estimateMicroUsd: 0,
      appliedMicroUsd: 900,
    });
  });

  it("ignores a stale micro_usd on an unmetered row rather than trusting it", () => {
    // `metered: false` means the charge was never valid, so the estimate is 0 whatever the column says.
    // Reading the column anyway would compare the biller against a number this plane already disowned.
    const outcome = decideAdjustment(
      logRow({ id: "log_1", createdAt: AT, requestId: "req_1", costMicroUsd: 900 }),
      estimate({ metered: false, micro_usd: 5000 }),
    );
    expect(outcome).toMatchObject({ estimateMicroUsd: 0, appliedMicroUsd: 900 });
  });

  it("reports agreement to the micro-USD as its own outcome, not as a zero adjustment", () => {
    const outcome = decideAdjustment(
      logRow({ id: "log_1", createdAt: AT, requestId: "req_1", costMicroUsd: 1000 }),
      estimate(),
    );
    expect(outcome).toEqual({ outcome: "in_agreement", microUsd: 1000, event: estimate() });
  });

  it("skips a row with no request id: it is not traffic this plane sent", () => {
    const outcome = decideAdjustment(logRow({ id: "log_1", createdAt: AT, requestId: null }), estimate());
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "no_request_id" });
  });

  it("skips a cached row instead of refunding the whole estimate", () => {
    // The gateway runs cache_ttl=0, so a cached row means the cache was enabled without teaching the
    // ledger to read cf-aig-cache-status. Such a row arrives with cost 0, and reading that as "the biller
    // charged nothing" would credit back the entire estimate: silent free money.
    const outcome = decideAdjustment(
      logRow({ id: "log_1", createdAt: AT, requestId: "req_1", cached: true, costMicroUsd: 0 }),
      estimate(),
    );
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "cached" });
  });

  it("skips an unknown cost rather than reading it as free", () => {
    const outcome = decideAdjustment(
      logRow({ id: "log_1", createdAt: AT, requestId: "req_1", costMicroUsd: null }),
      estimate(),
    );
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "unknown_cost" });
  });

  it("records a gateway row with no ledger row as a finding, with the amount in it", () => {
    // The alarming one: spend Cloudflare billed us that this plane never recorded. The detail carries the
    // amount because a count alone does not tell an operator whether to care.
    const outcome = decideAdjustment(
      logRow({ id: "log_1", createdAt: AT, requestId: "req_missing", costMicroUsd: 1500 }),
      null,
    );
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "no_ledger_row" });
    expect(outcome).toHaveProperty("detail", expect.stringContaining("1500"));
    expect(outcome).toHaveProperty("detail", expect.stringContaining("req_missing"));
  });

  it("refuses when metadata and ledger disagree on whose request it was", () => {
    // Moving money on a row whose two identifiers disagree would charge the wrong user, which is worse
    // than not reconciling it at all.
    const outcome = decideAdjustment(
      logRow({ id: "log_1", createdAt: AT, requestId: "req_1", costMicroUsd: 1500, accountId: "acct_other" }),
      estimate(),
    );
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "account_mismatch" });
  });

  it("proceeds when the row carries no account id at all", () => {
    // Absent is not a mismatch. Older rows and rows from before the metadata was complete carry no
    // account id, and refusing them would leave a permanent unreconciled tail.
    const outcome = decideAdjustment(
      logRow({ id: "log_1", createdAt: AT, requestId: "req_1", costMicroUsd: 1500, accountId: null }),
      estimate(),
    );
    expect(outcome).toMatchObject({ outcome: "adjust" });
  });

  it("checks the cheap refusals before the ones that need a ledger row", () => {
    // The order is the order of certainty. A row with no request id must refuse for that reason even when
    // no ledger row was supplied, because the two are different facts about the world.
    expect(decideAdjustment(logRow({ id: "log_1", createdAt: AT, requestId: null }), null)).toMatchObject({
      reason: "no_request_id",
    });
    expect(
      decideAdjustment(logRow({ id: "log_1", createdAt: AT, requestId: "req_1", cached: true }), null),
    ).toMatchObject({ reason: "cached" });
    expect(
      decideAdjustment(
        logRow({ id: "log_1", createdAt: AT, requestId: "req_1", costMicroUsd: null }),
        null,
      ),
    ).toMatchObject({ reason: "unknown_cost" });
  });
});

describe("adjustmentIdempotencyKey", () => {
  it("is derived from the gateway log id and namespaced", () => {
    // Namespaced so it cannot collide with an operator's invoice reference or the `signup:` opening grant,
    // which share the credit_grants key space.
    expect(adjustmentIdempotencyKey("log_abc")).toBe("aig:log_abc");
  });
});

describe("tally", () => {
  it("gives every outcome its own counter", () => {
    // Collapsing the five skip reasons into one number would make the only alarming one indistinguishable
    // from the four benign ones, and a single number nobody can decompose gets ignored the second time it
    // is non-zero.
    const decisions: ReconcileDecision[] = [
      { log: logRow({ id: "a", createdAt: AT }), outcome: { outcome: "in_agreement", microUsd: 10, event: estimate() } },
      {
        log: logRow({ id: "b", createdAt: AT }),
        outcome: {
          outcome: "adjust",
          direction: "spend",
          appliedMicroUsd: 500,
          deltaMicroUsd: 500,
          estimateMicroUsd: 1000,
          gatewayMicroUsd: 1500,
          event: estimate(),
        },
      },
      {
        log: logRow({ id: "c", createdAt: AT }),
        outcome: {
          outcome: "adjust",
          direction: "credit",
          appliedMicroUsd: 200,
          deltaMicroUsd: -200,
          estimateMicroUsd: 1000,
          gatewayMicroUsd: 800,
          event: estimate(),
        },
      },
      { log: logRow({ id: "d", createdAt: AT }), outcome: { outcome: "skipped", reason: "no_request_id", detail: "" } },
      { log: logRow({ id: "e", createdAt: AT }), outcome: { outcome: "skipped", reason: "cached", detail: "" } },
      { log: logRow({ id: "f", createdAt: AT }), outcome: { outcome: "skipped", reason: "unknown_cost", detail: "" } },
      { log: logRow({ id: "g", createdAt: AT }), outcome: { outcome: "skipped", reason: "no_ledger_row", detail: "" } },
      {
        log: logRow({ id: "h", createdAt: AT }),
        outcome: { outcome: "skipped", reason: "account_mismatch", detail: "" },
      },
    ];
    expect(tally(decisions)).toEqual({
      rows: 8,
      in_agreement: 1,
      adjusted_spend: 1,
      adjusted_credit: 1,
      spend_micro_usd: 500,
      credit_micro_usd: 200,
      skipped_no_request_id: 1,
      skipped_cached: 1,
      skipped_unknown_cost: 1,
      skipped_no_ledger_row: 1,
      skipped_account_mismatch: 1,
    });
  });

  it("tallies nothing as zeroes, not as absent keys", () => {
    expect(tally([])).toEqual(emptyTotals());
  });
});

describe("nextWatermark", () => {
  const nowMs = Date.parse("2026-08-05T12:00:00.000Z");
  const ceiling = new Date(nowMs - SETTLE_MS).toISOString();

  it("holds the watermark behind the present by the settling lag", () => {
    // The feed is filtered on created_at, so a row that appears with a timestamp already behind the
    // watermark is invisible forever. Holding back means the trailing edge is re-read, and the unique
    // idempotency key makes re-reading free.
    expect(
      nextWatermark({ current: "2026-08-05T00:00:00.000Z", newestProcessed: "2026-08-05T11:59:00.000Z", nowMs }),
    ).toBe(ceiling);
  });

  it("advances to the newest row actually processed when that is behind the ceiling", () => {
    expect(
      nextWatermark({ current: "2026-08-05T00:00:00.000Z", newestProcessed: "2026-08-05T06:00:00.000Z", nowMs }),
    ).toBe("2026-08-05T06:00:00.000Z");
  });

  it("advances to the ceiling when a run processed nothing", () => {
    // An empty window is a window that was READ and found empty, which is progress.
    expect(nextWatermark({ current: "2026-08-05T00:00:00.000Z", newestProcessed: null, nowMs })).toBe(ceiling);
  });

  it("never moves backwards, and says so with a null", () => {
    // Rewinding would re-read rows already trued up (safe, by the key) but would also let a single odd row
    // pull the window back indefinitely.
    expect(
      nextWatermark({ current: "2026-08-05T11:50:00.000Z", newestProcessed: "2026-08-05T06:00:00.000Z", nowMs }),
    ).toBeNull();
    expect(nextWatermark({ current: ceiling, newestProcessed: null, nowMs })).toBeNull();
  });

  it("compares instants rather than strings", () => {
    // `current` came out of D1 and `newestProcessed` came out of Cloudflare, so their textual shapes are
    // two other systems' choices. These two are the same instant in different notations, and a lexical
    // comparison would call the second one newer.
    expect(nextWatermark({ current: "2026-08-05T11:45:00.000Z", newestProcessed: "2026-08-05T11:45:00Z", nowMs })).toBeNull();
    // A dropped `Z` reads as local time, which is why the parse must be relied on rather than the text.
    expect(nextWatermark({ current: "2026-08-05T00:00:00.000Z", newestProcessed: "2026-08-05T06:00:00Z", nowMs })).toBe(
      "2026-08-05T06:00:00.000Z",
    );
  });

  it("does not trust an unparseable current watermark to block an advance", () => {
    // A junk value in the column must not freeze reconciliation forever; the advance is allowed and the
    // column becomes a canonical shape again.
    expect(nextWatermark({ current: "whenever", newestProcessed: "2026-08-05T06:00:00.000Z", nowMs })).toBe(
      "2026-08-05T06:00:00.000Z",
    );
  });
});

describe("run bounds", () => {
  it("caps a run so a backlog makes progress instead of dying forever", () => {
    // 40 pages of 50. An unbounded run against a backlog would be killed partway with the watermark
    // unadvanced, so the next run would redo the same doomed prefix.
    expect(MAX_ROWS_PER_RUN).toBe(2000);
    expect(SETTLE_MS).toBe(15 * 60 * 1000);
  });
});
