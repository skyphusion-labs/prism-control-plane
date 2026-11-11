// Async Grok video: a job is charged only when there is a video to hand back.
//
// Same contract as the synchronous door (tests/video-asset.test.ts): when the R2 object never appears and
// the provider body carries no asset URL, the workflow must fail the job before the finalize step, so no
// usage row is written and nothing is charged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { PlaneLongRunWorkflow, type PlaneLongRunParams } from "../src/routes/longrun-workflow";
import { driveFakeTimers } from "./fake-timer-drive";

const params: PlaneLongRunParams = {
  jobId: "job_1",
  kind: "video",
  modelId: "xai/grok-imagine-video",
  upstreamModel: "xai/grok-imagine-video",
  prompt: "a cat",
  accountId: "acct_1",
  clientId: "cli_1",
  planId: "test",
  requestId: "req_test0000000000000000",
  unitMicroUsd: 400_000,
  unit: "request",
  monthlyIncludedMicroUsd: 0,
  origin: "https://example.invalid",
  startedAtIso: "2026-08-04T12:00:00.000Z",
  durationSec: 8,
};

/** Records every statement the workflow runs against D1; enough surface for updateAsyncJob. */
function fakeDb() {
  const statements: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          statements.push({ sql, binds });
          return {
            first: async () => ({ result_json: null, error_code: null, error_detail: null }),
            run: async () => ({ success: true }),
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  };
  return { db, statements };
}

function makeWorkflow(opts: { providerBody: unknown; objectLands: boolean }) {
  const { db, statements } = fakeDb();
  const env = {
    CF_ACCOUNT_ID: "fabcb25d9c7eb087110ec474a03e50d2",
    AI_GATEWAY_ID: "prism-proxy",
    CF_AIG_TOKEN: "x".repeat(32),
    DB: db,
    MEDIA: { head: async () => (opts.objectLands ? { key: "k" } : null) },
    AI: { run: async () => opts.providerBody },
  } as unknown as Env;
  const wf = new PlaneLongRunWorkflow({} as never, env);
  const stepsRun: string[] = [];
  const step = {
    do: async <T>(name: string, _opts: unknown, fn: () => Promise<T>): Promise<T> => {
      stepsRun.push(name);
      return fn();
    },
  };
  return { wf, step, statements, stepsRun };
}

async function drive(promise: Promise<unknown>): Promise<{ error: unknown }> {
  try {
    await driveFakeTimers(promise);
    return { error: null };
  } catch (error) {
    // A budget overrun is a harness failure, not the error the test asserts on.
    if (error instanceof Error && error.message.startsWith("driveFakeTimers:")) throw error;
    return { error };
  }
}

describe("async Grok video: charge only when there is a video to hand back", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      now: new Date("2026-08-04T12:00:00.000Z"),
      toFake: ["setTimeout", "clearTimeout", "Date"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails the job and never reaches finalize when nothing landed and the body has no asset", async () => {
    const t = makeWorkflow({ providerBody: { state: "Completed", result: {} }, objectLands: false });
    const { error } = await drive(t.wf.run({ payload: params } as never, t.step as never));
    expect(error).toBeInstanceOf(Error);
    expect(t.stepsRun).not.toContain("finalize");
    expect(t.statements.some((s) => s.sql.includes("usage_events"))).toBe(false);
    const update = t.statements.find((s) => s.sql.includes("UPDATE async_jobs"));
    expect(update?.binds[0]).toBe("failed");
  });

  it("CONTROL: reaches finalize and writes the usage row when the object landed in R2", async () => {
    const t = makeWorkflow({ providerBody: { state: "Completed", result: {} }, objectLands: true });
    await drive(t.wf.run({ payload: params } as never, t.step as never));
    expect(t.stepsRun).toContain("finalize");
    expect(t.statements.some((s) => s.sql.includes("usage_events"))).toBe(true);
  });
});
