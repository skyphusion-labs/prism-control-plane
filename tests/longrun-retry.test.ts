// Async job retries: a provider call that already returned must not be re-run.
//
// The invoke-model step is retried by the Workflows runtime on any thrown error. A failure AFTER the
// provider has answered (here: storing the result) would otherwise re-issue the provider call, which is
// billed upstream again. The fake step below mirrors the runtime rule that matters: retry up to
// `retries.limit` times, except for a NonRetryableError.

import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { PlaneLongRunWorkflow, type PlaneLongRunParams } from "../src/routes/longrun-workflow";

const params: PlaneLongRunParams = {
  jobId: "job_1",
  kind: "image",
  modelId: "openai/gpt-image-2",
  upstreamModel: "openai/gpt-image-2",
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
};

function fakeDb() {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            first: async () => ({ result_json: null, error_code: null, error_detail: null }),
            run: async () => ({ success: true }),
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  };
  return db;
}

/** Runs invoke-model, retrying up to opts.retries.limit times unless the error is a NonRetryableError. */
const retryingStep = {
  do: async <T>(name: string, opts: unknown, fn: () => Promise<T>): Promise<T> => {
    // Only invoke-model is under test; the later steps (rehost, finalize) are not run.
    if (name !== "invoke-model") return undefined as T;
    const limit = (opts as { retries?: { limit?: number } }).retries?.limit ?? 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const fatal = err instanceof Error && err.name === "NonRetryableError";
        if (fatal || attempt >= limit) throw err;
      }
    }
  },
};

function makeWorkflow(aiRun: () => Promise<unknown>) {
  const env = {
    CF_ACCOUNT_ID: "fabcb25d9c7eb087110ec474a03e50d2",
    AI_GATEWAY_ID: "prism-proxy",
    CF_AIG_TOKEN: "x".repeat(32),
    // The runner leaves its timeout timer pending after a fast answer; keep it short so it cannot hold the run open.
    NONCHAT_UPSTREAM_TIMEOUT_MS: "1000",
    DB: fakeDb(),
    MEDIA: { put: async () => undefined },
    AI: { run: aiRun },
  } as unknown as Env;
  return new PlaneLongRunWorkflow({} as never, env);
}

describe("invoke-model step retries", () => {
  it("does not re-run the provider call when storing its result fails", async () => {
    let providerCalls = 0;
    const wf = makeWorkflow(async () => {
      providerCalls += 1;
      // Not valid base64, so storing the returned image throws after the provider answered.
      return { image: "!!!not-base64!!!" };
    });
    await expect(wf.run({ payload: params } as never, retryingStep as never)).rejects.toThrow();
    expect(providerCalls).toBe(1);
  });

  it("CONTROL: still retries a provider call that failed before answering", async () => {
    let providerCalls = 0;
    const wf = makeWorkflow(async () => {
      providerCalls += 1;
      if (providerCalls === 1) throw new Error("transient upstream failure");
      return { image: "aGVsbG8=" };
    });
    await wf.run({ payload: params } as never, retryingStep as never);
    expect(providerCalls).toBe(2);
  });
});
