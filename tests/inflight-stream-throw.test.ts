// #100 review finding 2 (rollins, PR #124): a chat stream's in-flight slot must be released even when
// the settle callback throws while it prices the stream, BEFORE its waitUntil is registered. stream.ts
// catches and logs that throw (settleOnce), so nothing else would ever free the slot; it would sit for
// SYNC_HOLD_SEC (30 min), a quarter of the default cap. The meter is mocked to throw here, which is the
// only way to reach that path: real pricing does not throw on any input the suite can build.

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/meter", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/meter")>();
  return {
    ...real,
    meterUsageObject: () => {
      throw new Error("simulated pricing failure");
    },
  };
});

import { mintClientKey } from "../src/auth";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";
import type { InferenceRequest, InferenceResult, InferenceRunner } from "../src/inference";
import type { CredentialOutcome, UpstreamCredentialSource } from "../src/token-minter";
import type { Ctx } from "../src/routes/shared";
import { FakeStore, testPlan } from "./fake-store";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const MODEL = "@cf/meta/llama-3.2-3b-instruct";
const FRAMES = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":10}}\n\n',
  "data: [DONE]\n\n",
];

class StreamRunner implements InferenceRunner {
  async run(_request: InferenceRequest): Promise<InferenceResult> {
    const encoder = new TextEncoder();
    return {
      outcome: "stream",
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          for (const f of FRAMES) c.enqueue(encoder.encode(f));
          c.close();
        },
      }),
      gatewayLogId: "log_stream",
    };
  }
}

class OkCredentials implements UpstreamCredentialSource {
  readonly mode = "shared" as const;
  async forAccount(): Promise<CredentialOutcome> {
    return { outcome: "ok", credential: { tokenId: "cftok_1", value: "cf-secret-value" }, minted: false };
  }
  async revokeForAccount(): Promise<boolean> {
    return true;
  }
}

describe("a chat stream whose settle throws (#100 review)", () => {
  it("still releases its in-flight slot", async () => {
    const store = new FakeStore({ nowSeconds: Math.floor(NOW.getTime() / 1000) });
    store.plans.set("test", testPlan());
    await store.createAccount({
      id: "acct_1",
      plan_id: "test",
      label: null,
      credit_micro_usd: 1_000_000,
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
      env: { CF_ACCOUNT_ID: "fabcb25d9c7eb087110ec474a03e50d2", AI_GATEWAY_ID: "prism-proxy" } as Env,
      store,
      runner: new StreamRunner(),
      nonChatRunner: null,
      credentials: new OkCredentials(),
      logs: null,
      requestId: "req_stream_throw",
      now: NOW,
      waitUntil: (p) => {
        deferred.push(p);
      },
    };
    const response = await handleRequest(
      ctx,
      new Request("https://example.invalid/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${minted.key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(response.status).toBe(200);
    expect(store.inflight.has("req_stream_throw")).toBe(true);
    await response.text();
    await Promise.all(deferred);
    expect(store.inflight.size).toBe(0);
  });
});
