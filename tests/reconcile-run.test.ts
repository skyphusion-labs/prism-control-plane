// One reconciliation run, end to end, against a scripted gateway feed and the in-memory store.
//
// What is actually being asserted here is a set of safety properties, not a feature:
//
//   1. A dry run writes NOTHING -- not the money, not the watermark, not the run counters.
//   2. A second live run over the same rows moves no money a second time.
//   3. A run that could not read the feed does not advance the watermark and does not report success.
//   4. The watermark only ever moves to an instant that was OBSERVED and settled.
//   5. A capped run makes progress and says it was capped, instead of dying and redoing the same prefix.
//
// Every one of those is a case where the failure is silent in production: a double charge looks like usage,
// a lost watermark looks like a quiet gateway, and an unread feed looks exactly like no drift.

import { describe, expect, it, vi } from "vitest";
import { DRIFT_ALERT_RATIO, needsLedgerLookup, runReconcile } from "../src/reconcile-run";
import { SETTLE_MS } from "../src/reconcile";
import type { UsageEvent } from "../src/store";
import { FakeLogSource, logRow } from "./fake-gateway-logs";
import { FakeStore, testPlan } from "./fake-store";

const NOW = new Date("2026-08-05T12:00:00.000Z");
/** Inside the settled window: old enough that a run is willing to consider its cost final. */
const SETTLED = "2026-08-05T10:00:00.000Z";
const FLOOR = "2026-08-05T00:00:00.000Z";
const CEILING = new Date(NOW.getTime() - SETTLE_MS).toISOString();

async function storeWithLedger(
  events: Partial<UsageEvent>[] = [{}],
  options: { credit?: number } = {},
): Promise<FakeStore> {
  const store = new FakeStore({ nowSeconds: Math.floor(NOW.getTime() / 1000) });
  store.plans.set("test", testPlan());
  await store.createAccount({
    id: "acct_1",
    plan_id: "test",
    label: null,
    credit_micro_usd: options.credit ?? 1_000_000,
    grant_id: "grant_seed",
    grant_idempotency_key: "signup:acct_1",
  });
  let n = 0;
  for (const overrides of events) {
    n += 1;
    await store.recordUsage({
      id: `ue_${n}`,
      request_id: `req_${n}`,
      account_id: "acct_1",
      client_id: "cli_1",
      model_id: "@cf/meta/llama-3.1-8b-instruct",
      period_key: "2026-08",
      input_tokens: 10,
      output_tokens: 20,
      micro_usd: 1000,
      from_allowance_micro_usd: 0,
      from_credit_micro_usd: 1000,
      metered: true,
      unmetered_reason: null,
      upstream_status: 200,
      gateway_log_id: null,
      ...overrides,
    });
    store.eventCreatedAt.set(`ue_${n}`, SETTLED);
  }
  return store;
}

function run(store: FakeStore, source: FakeLogSource, overrides: Record<string, unknown> = {}) {
  let seq = 0;
  return runReconcile({
    store,
    source,
    now: NOW,
    dryRun: true,
    since: FLOOR,
    newId: () => `adj_${++seq}`,
    ...overrides,
  });
}

describe("the first run needs a floor", () => {
  it("refuses rather than paging the gateway's entire history", async () => {
    // Defaulting to the epoch would page every log row Cloudflare still retains, on a route an operator
    // just discovered. The floor is supplied once and then the watermark carries it.
    const store = await storeWithLedger();
    const result = await run(store, new FakeLogSource(), { since: undefined });
    expect(result).toMatchObject({ ok: false, reason: "no_floor" });
  });

  it("refuses a since that is not a timestamp", async () => {
    const store = await storeWithLedger();
    const result = await run(store, new FakeLogSource(), { since: "last tuesday" });
    expect(result).toMatchObject({ ok: false, reason: "no_floor" });
  });

  it("prefers the stored watermark over the caller's floor once one exists", async () => {
    // Otherwise an operator repeating their first command would rewind the window every time.
    const store = await storeWithLedger();
    await store.advanceReconcileState({
      gateway_id: "prism-proxy",
      watermark: "2026-08-05T09:00:00.000Z",
      last_log_id: "log_0",
      rows_seen: 1,
      rows_adjusted: 0,
      at: NOW.toISOString(),
    });
    const source = new FakeLogSource();
    const result = await run(store, source, { since: FLOOR });
    expect(result.ok).toBe(true);
    expect(source.calls[0].sinceIso).toBe("2026-08-05T09:00:00.000Z");
  });
});

describe("a dry run", () => {
  it("decides everything and writes nothing at all", async () => {
    const store = await storeWithLedger();
    const source = new FakeLogSource({
      rows: [logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 1500 })],
    });
    const result = await run(store, source, { dryRun: true });
    if (!result.ok) throw new Error("expected a report");

    // The drift is FOUND and reported...
    expect(result.report.totals.adjusted_spend).toBe(1);
    expect(result.report.totals.spend_micro_usd).toBe(500);
    // ...and nothing moved. Including the watermark: a dry run that advanced it would be a live run that
    // forgot to pay, and would leave the rows it previewed permanently unreconciled.
    expect(result.report.applied).toBe(0);
    expect(result.report.watermark_after).toBeNull();
    expect(store.adjustments).toHaveLength(0);
    expect(store.accounts.get("acct_1")?.spent_micro_usd).toBe(1000);
    expect(store.reconcileState.size).toBe(0);
  });

  it("is repeatable, because it left no watermark behind", async () => {
    const store = await storeWithLedger();
    const source = new FakeLogSource({
      rows: [logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 1500 })],
    });
    const first = await run(store, source, { dryRun: true });
    const second = await run(store, source, { dryRun: true });
    if (!first.ok || !second.ok) throw new Error("expected reports");
    expect(second.report.totals).toEqual(first.report.totals);
  });
});

describe("a live run", () => {
  it("trues spend up and advances the watermark to a settled, observed instant", async () => {
    const store = await storeWithLedger();
    const source = new FakeLogSource({
      rows: [logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 1500 })],
    });
    const result = await run(store, source, { dryRun: false });
    if (!result.ok) throw new Error("expected a report");

    expect(result.report.applied).toBe(1);
    expect(store.accounts.get("acct_1")?.spent_micro_usd).toBe(1500);
    // The row is the audit trail: both numbers and their difference, not just the amount moved.
    expect(store.adjustments[0]).toMatchObject({
      account_id: "acct_1",
      usage_event_id: "ue_1",
      gateway_log_id: "log_1",
      estimate_micro_usd: 1000,
      gateway_micro_usd: 1500,
      delta_micro_usd: 500,
      direction: "spend",
      applied_micro_usd: 500,
      idempotency_key: "aig:log_1",
    });
    // The ORIGINAL LEDGER ROW IS UNTOUCHED. The drift is the finding; overwriting it destroys the evidence.
    expect(store.events[0].micro_usd).toBe(1000);
    // THE NEWEST ROW ACTUALLY SEEN, not the settling ceiling, even though the short page proves the window
    // was read to the end. The watermark is a value that was OBSERVED; the cost of the conservative choice
    // is that the next run re-reads a tail it has already trued up, which the idempotency key makes free.
    expect(store.reconcileState.get("prism-proxy")?.watermark).toBe(SETTLED);
  });

  it("trues drift down as a credit grant, never as a decrement of spend", async () => {
    const store = await storeWithLedger();
    const source = new FakeLogSource({
      rows: [logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 400 })],
    });
    const result = await run(store, source, { dryRun: false });
    if (!result.ok) throw new Error("expected a report");

    const account = store.accounts.get("acct_1");
    expect(account?.spent_micro_usd).toBe(1000);
    expect(account?.credit_micro_usd).toBe(1_000_600);
    // The grant lands in the same audit table every other top-up does, under the namespaced key.
    expect(store.grants.get("aig:log_1")).toEqual({ account_id: "acct_1", micro_usd: 600 });
    expect(result.report.totals.credit_micro_usd).toBe(600);
  });

  it("credits the month the request belongs to, not the month the run happens in", async () => {
    // A true-up for a request made on the 31st can land on the 1st. Putting it in the new month would move
    // money out of the month whose rollup it corrects, leaving both months wrong.
    const store = await storeWithLedger([{ period_key: "2026-07" }]);
    const source = new FakeLogSource({
      rows: [logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 1500 })],
    });
    await run(store, source, { dryRun: false });
    expect(store.adjustments[0].period_key).toBe("2026-07");
    expect(store.periods.get("acct_1|2026-07")?.adjust_spend_micro_usd).toBe(500);
  });

  it("moves no money a second time when the same rows come back", async () => {
    // The whole point of the unique idempotency key. Rows arrive late, a page boundary can be crossed
    // twice, and a run can die halfway; every retry has to be a no-op rather than a second charge.
    const store = await storeWithLedger();
    const source = new FakeLogSource({
      rows: [logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 1500 })],
    });
    await run(store, source, { dryRun: false });
    // Rewound deliberately, standing in for a row that arrived late inside the re-read trailing edge.
    store.reconcileState.get("prism-proxy")!.watermark = FLOOR;
    const second = await run(store, source, { dryRun: false });
    if (!second.ok) throw new Error("expected a report");

    expect(second.report.applied).toBe(0);
    expect(second.report.already_applied).toBe(1);
    expect(store.accounts.get("acct_1")?.spent_micro_usd).toBe(1500);
    expect(store.adjustments).toHaveLength(1);
  });

  it("leaves the stored watermark alone when a run would move it backwards", async () => {
    // `advanceReconcileState` gets a null and must COALESCE it away. Writing the null through would send
    // the next run back to the beginning of the gateway's history.
    const store = await storeWithLedger();
    await store.advanceReconcileState({
      gateway_id: "prism-proxy",
      watermark: CEILING,
      last_log_id: "log_0",
      rows_seen: 0,
      rows_adjusted: 0,
      at: NOW.toISOString(),
    });
    const result = await run(store, new FakeLogSource(), { dryRun: false });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.watermark_after).toBeNull();
    expect(store.reconcileState.get("prism-proxy")?.watermark).toBe(CEILING);
  });
});

describe("what a run refuses to act on", () => {
  it("counts every skip reason separately and only flags the alarming ones", async () => {
    const store = await storeWithLedger();
    const source = new FakeLogSource({
      rows: [
        logRow({ id: "log_a", createdAt: SETTLED, requestId: null }),
        logRow({ id: "log_b", createdAt: SETTLED, requestId: "req_1", cached: true }),
        logRow({ id: "log_c", createdAt: SETTLED, requestId: "req_1", costMicroUsd: null }),
        logRow({ id: "log_d", createdAt: SETTLED, requestId: "req_absent", costMicroUsd: 900 }),
        logRow({ id: "log_e", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 900, accountId: "acct_9" }),
      ],
    });
    const result = await run(store, source, { dryRun: false });
    if (!result.ok) throw new Error("expected a report");

    expect(result.report.totals).toMatchObject({
      rows: 5,
      skipped_no_request_id: 1,
      skipped_cached: 1,
      skipped_unknown_cost: 1,
      skipped_no_ledger_row: 1,
      skipped_account_mismatch: 1,
    });
    // Nothing moved on any of them.
    expect(store.adjustments).toHaveLength(0);
    expect(store.accounts.get("acct_1")?.spent_micro_usd).toBe(1000);
    // The two that need a human are carried out as findings; the three benign ones are not.
    expect(result.report.findings.map((f) => f.kind).sort()).toEqual(["account_mismatch", "no_ledger_row"]);
    // req_1 is NOT an unmatched ledger row, even though nothing was trued up against it. The reverse check
    // asks whether the gateway recorded the request at all, which the cached and unknown-cost rows prove
    // it did. Conflating "not reconciled" with "never happened" would fire on every benign skip.
    expect(result.report.unmatched_ledger_rows).toEqual([]);
  });

  it("reads no ledger row for traffic it will refuse anyway", async () => {
    // A page of another tenant's traffic on the same gateway must cost zero D1 reads, and the predicate
    // that decides that has to stay in step with the first three refusals in decideAdjustment.
    expect(needsLedgerLookup(logRow({ id: "a", createdAt: SETTLED, requestId: null }))).toBe(false);
    expect(needsLedgerLookup(logRow({ id: "a", createdAt: SETTLED, requestId: "req_1", cached: true }))).toBe(false);
    expect(
      needsLedgerLookup(logRow({ id: "a", createdAt: SETTLED, requestId: "req_1", costMicroUsd: null })),
    ).toBe(false);
    expect(needsLedgerLookup(logRow({ id: "a", createdAt: SETTLED, requestId: "req_1" }))).toBe(true);

    const store = await storeWithLedger();
    const spy = vi.spyOn(store, "getUsageEventByRequestId");
    const source = new FakeLogSource({
      rows: [logRow({ id: "log_a", createdAt: SETTLED, requestId: null })],
    });
    await run(store, source, { dryRun: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("holds back a row that is newer than the settling window", async () => {
    // Cloudflare's filter is a lower bound only, so a page can contain rows newer than the settled
    // instant. Truing one up before its cost figure is necessarily final is the thing SETTLE_MS prevents.
    const store = await storeWithLedger();
    const source = new FakeLogSource({
      rows: [
        logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 1500 }),
        logRow({ id: "log_2", createdAt: "2026-08-05T11:59:00.000Z", requestId: "req_1", costMicroUsd: 9000 }),
      ],
    });
    const result = await run(store, source, { dryRun: false });
    if (!result.ok) throw new Error("expected a report");

    expect(result.report.totals.rows).toBe(1);
    expect(result.report.truncated).toBe(true);
    // The watermark stops at the last SETTLED row, so the held-back row is inside the next run's window.
    expect(store.reconcileState.get("prism-proxy")?.watermark).toBe(SETTLED);
  });

  it("reports unreadable rows as a finding rather than as an empty page", async () => {
    const store = await storeWithLedger();
    const source = new FakeLogSource({ rows: [], malformed: 3 });
    const result = await run(store, source, { dryRun: false });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.malformed_rows).toBe(3);
    expect(result.report.findings.some((f) => f.kind === "malformed_rows")).toBe(true);
  });
});

describe("when the feed cannot be read", () => {
  it("fails loudly and leaves the watermark exactly where it was", async () => {
    // "Reconciled 0 rows" and "could not read the feed" look identical in a dashboard and mean opposite
    // things, and the second is the state where drift accumulates unseen.
    const store = await storeWithLedger();
    const source = new FakeLogSource({ fail: "ai-gateway logs: HTTP 403 (9109 Unauthorized)" });
    const result = await run(store, source, { dryRun: false });
    expect(result).toMatchObject({ ok: false, reason: "upstream" });
    if (result.ok) throw new Error("expected a refusal");
    // Cloudflare's own code survives, because 9109 and a 400 need different operator actions.
    expect(result.detail).toContain("9109");
    expect(store.reconcileState.size).toBe(0);
  });
});

describe("paging and the row cap", () => {
  it("pages until the feed returns a short page", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      logRow({
        id: `log_${i}`,
        createdAt: new Date(Date.parse(SETTLED) + i * 1000).toISOString(),
        requestId: "req_1",
        costMicroUsd: 1000,
      }),
    );
    const store = await storeWithLedger();
    const source = new FakeLogSource({ rows });
    const result = await run(store, source, { dryRun: false, perPage: 2 });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.totals.rows).toBe(5);
    // 2 + 2 + 1: the short third page is the termination condition, not a total_count comparison a
    // concurrent write can move.
    expect(result.report.pages).toBe(3);
    expect(source.calls.map((c) => c.page)).toEqual([1, 2, 3]);
  });

  it("stops at the cap, says so, and leaves the rest for the next run", async () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      logRow({
        id: `log_${i}`,
        createdAt: new Date(Date.parse(SETTLED) + i * 1000).toISOString(),
        requestId: "req_1",
        costMicroUsd: 1000,
      }),
    );
    const store = await storeWithLedger();
    const source = new FakeLogSource({ rows });
    const first = await run(store, source, { dryRun: false, maxRows: 4, perPage: 2 });
    if (!first.ok) throw new Error("expected a report");
    expect(first.report.truncated).toBe(true);
    expect(first.report.totals.rows).toBe(4);
    // A capped run MAKES PROGRESS: the watermark is at the newest row it actually looked at, so the next
    // run continues rather than redoing the same prefix forever.
    expect(store.reconcileState.get("prism-proxy")?.watermark).toBe(rows[3].createdAt);

    const second = await run(store, source, { dryRun: false, maxRows: 4, perPage: 2 });
    if (!second.ok) throw new Error("expected a report");
    expect(second.report.totals.rows).toBe(2);
    expect(second.report.truncated).toBe(false);
  });
});

describe("the reverse check", () => {
  it("reports a metered request the gateway never recorded", async () => {
    // The other direction of the same question: a request this plane charged for that never reached the
    // gateway, which is either a ledger row for a call that did not happen or a gateway row that is lost.
    const store = await storeWithLedger([{}, {}]);
    const source = new FakeLogSource({
      rows: [logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 1000 })],
    });
    const result = await run(store, source, { dryRun: false });
    if (!result.ok) throw new Error("expected a report");

    expect(result.report.unmatched_ledger_rows).toHaveLength(1);
    expect(result.report.unmatched_ledger_rows[0]).toMatchObject({ id: "ue_2", request_id: "req_2" });
    // A REPORT, NOT AN ADJUSTMENT. There is no cost figure to true anything up against.
    expect(store.adjustments).toHaveLength(0);
  });

  it("runs on a dry run too, since it moves no money", async () => {
    const store = await storeWithLedger([{}, {}]);
    const source = new FakeLogSource({
      rows: [logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 1000 })],
    });
    const result = await run(store, source, { dryRun: true });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.unmatched_ledger_rows).toHaveLength(1);
  });

  it("stays quiet when every ledger row in the window was accounted for", async () => {
    const store = await storeWithLedger();
    const source = new FakeLogSource({
      rows: [logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 1000 })],
    });
    const result = await run(store, source, { dryRun: false });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.unmatched_ledger_rows).toEqual([]);
    expect(result.report.findings).toEqual([]);
  });
});

describe("the drift ratio", () => {
  it("measures absolute drift against what the biller said", async () => {
    const store = await storeWithLedger([{ micro_usd: 1000 }, { micro_usd: 1000 }]);
    const source = new FakeLogSource({
      rows: [
        logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 2000 }),
        logRow({
          id: "log_2",
          createdAt: new Date(Date.parse(SETTLED) + 1000).toISOString(),
          requestId: "req_2",
          costMicroUsd: 1000,
        }),
      ],
    });
    const result = await run(store, source, { dryRun: false });
    if (!result.ok) throw new Error("expected a report");
    // 1000 micro-USD of drift against 3000 billed.
    expect(result.report.drift_ratio).toBeCloseTo(1 / 3);
    expect(result.report.drift_alert).toBe(true);
  });

  it("counts both directions, so an over-charge cannot hide inside an under-charge", async () => {
    // Summing signed would let the two cancel and publish a healthy zero on a window where the meter was
    // wrong on every row.
    const store = await storeWithLedger([{ micro_usd: 1000 }, { micro_usd: 1000 }]);
    const source = new FakeLogSource({
      rows: [
        logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 1500 }),
        logRow({
          id: "log_2",
          createdAt: new Date(Date.parse(SETTLED) + 1000).toISOString(),
          requestId: "req_2",
          costMicroUsd: 500,
        }),
      ],
    });
    const result = await run(store, source, { dryRun: false });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.totals.spend_micro_usd).toBe(500);
    expect(result.report.totals.credit_micro_usd).toBe(500);
    expect(result.report.drift_ratio).toBeCloseTo(0.5);
  });

  it("has no ratio at all when nothing in the window was compared", async () => {
    // Dividing by zero would publish NaN or, worse, a falsely healthy 0 on a window nobody checked.
    const store = await storeWithLedger();
    const result = await run(store, new FakeLogSource(), { dryRun: false });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.drift_ratio).toBeNull();
    expect(result.report.drift_alert).toBe(false);
  });

  it("stays quiet inside the alert ratio", async () => {
    const store = await storeWithLedger([{ micro_usd: 1_000_000 }]);
    const source = new FakeLogSource({
      rows: [logRow({ id: "log_1", createdAt: SETTLED, requestId: "req_1", costMicroUsd: 1_010_000 })],
    });
    const result = await run(store, source, { dryRun: false });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.drift_ratio).toBeLessThan(DRIFT_ALERT_RATIO);
    expect(result.report.drift_alert).toBe(false);
  });
});
