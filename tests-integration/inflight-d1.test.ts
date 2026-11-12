// The in-flight claim SQL (#100) against real D1 in workerd, with the real migrations applied.
//
// WHY HERE AND NOT ONLY IN THE NODE SUITE. The node suite drives the routes against FakeStore, and a
// fake encodes my reading of the SQL. This file runs the statement store-d1.ts actually sends:
// the count of live slots plus running jobs, the cap, the expiry sweep, the OR IGNORE on a repeated id,
// the account scope on release, and concurrent claims that must not all pass.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { d1Store } from "../src/store-d1";
import type { InflightClaim } from "../src/store";

const NOW = 1_800_000_000;
const SINCE = new Date((NOW - 7200) * 1000).toISOString();

function claim(over: Partial<InflightClaim> = {}): InflightClaim {
  return {
    id: `req_${Math.random().toString(16).slice(2, 14)}`,
    accountId: "acc_a",
    kind: "chat",
    nowSec: NOW,
    expiresAtSec: NOW + 1800,
    asyncSinceIso: SINCE,
    cap: 2,
    ...over,
  };
}

async function slotCount(accountId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM inflight_slots WHERE account_id = ?`)
    .bind(accountId)
    .first<{ n: number }>();
  return r?.n ?? -1;
}

async function addJob(id: string, accountId: string, status: string, createdAtSec: number): Promise<void> {
  const iso = new Date(createdAtSec * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO async_jobs (id, account_id, client_id, kind, model_id, status, result_json, error_code,
       error_detail, request_id, created_at, updated_at)
     VALUES (?, ?, 'cli_x', 'video', 'm', ?, NULL, NULL, NULL, ?, ?, ?)`,
  )
    .bind(id, accountId, status, id, iso, iso)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM inflight_slots`).run();
  await env.DB.prepare(`DELETE FROM async_jobs`).run();
});

describe("claimInflightSlot on D1", () => {
  it("admits up to the cap and refuses the next", async () => {
    const store = d1Store(env.DB);
    expect(await store.claimInflightSlot(claim())).toBe(true);
    expect(await store.claimInflightSlot(claim())).toBe(true);
    expect(await store.claimInflightSlot(claim())).toBe(false);
    expect(await slotCount("acc_a")).toBe(2);
  });

  it("counts per account: another account is not limited by this one", async () => {
    const store = d1Store(env.DB);
    await store.claimInflightSlot(claim());
    await store.claimInflightSlot(claim());
    expect(await store.claimInflightSlot(claim({ accountId: "acc_b" }))).toBe(true);
  });

  it("frees a slot on release, scoped by account", async () => {
    const store = d1Store(env.DB);
    const a = claim({ id: "req_one" });
    await store.claimInflightSlot(a);
    await store.claimInflightSlot(claim());
    // The wrong account cannot free it.
    await store.releaseInflightSlot("req_one", "acc_b");
    expect(await store.claimInflightSlot(claim())).toBe(false);
    await store.releaseInflightSlot("req_one", "acc_a");
    expect(await store.claimInflightSlot(claim())).toBe(true);
  });

  it("does not count an expired slot, and sweeps it", async () => {
    const store = d1Store(env.DB);
    await store.claimInflightSlot(claim({ expiresAtSec: NOW - 1, nowSec: NOW - 100 }));
    await store.claimInflightSlot(claim({ expiresAtSec: NOW, nowSec: NOW - 100 }));
    expect(await slotCount("acc_a")).toBe(2);
    expect(await store.claimInflightSlot(claim())).toBe(true);
    expect(await slotCount("acc_a")).toBe(1);
  });

  it("counts running async jobs, not finished ones, and not stale ones", async () => {
    const store = d1Store(env.DB);
    await addJob("job_run", "acc_a", "running", NOW - 60);
    await addJob("job_done", "acc_a", "succeeded", NOW - 60);
    await addJob("job_fail", "acc_a", "failed", NOW - 60);
    await addJob("job_stale", "acc_a", "running", NOW - 7300);
    await addJob("job_other", "acc_b", "running", NOW - 60);
    expect(await store.claimInflightSlot(claim())).toBe(true);
    // One slot plus one running job is the cap of two.
    expect(await store.claimInflightSlot(claim())).toBe(false);
  });

  it("treats a repeated id as no second claim", async () => {
    const store = d1Store(env.DB);
    expect(await store.claimInflightSlot(claim({ id: "req_dup", cap: 5 }))).toBe(true);
    expect(await store.claimInflightSlot(claim({ id: "req_dup", cap: 5 }))).toBe(false);
    expect(await slotCount("acc_a")).toBe(1);
  });

  it("lets exactly cap of many concurrent claims through", async () => {
    const store = d1Store(env.DB);
    const results = await Promise.all(Array.from({ length: 12 }, () => store.claimInflightSlot(claim({ cap: 3 }))));
    expect(results.filter(Boolean).length).toBe(3);
    expect(await slotCount("acc_a")).toBe(3);
  });

  it("the deep health probe reads the table", async () => {
    await expect(d1Store(env.DB).probeSchema()).resolves.toBeUndefined();
  });
});
