// Grok video ingress: a charge needs a video the client can actually fetch.
//
// xAI is asked to PUT the mp4 into our R2. The handler waits for that object and hands back our signed
// download URL. When the object never appears and the provider body carries no asset URL either, there
// is nothing to hand back, so the call is recorded unmetered rather than charged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { mintClientKey } from "../src/auth";
import type { Env } from "../src/env";
import type { NonChatRunner, NonChatRunRequest, NonChatRunResult } from "../src/nonchat-upstream";
import type { CredentialOutcome, UpstreamCredentialSource } from "../src/token-minter";
import type { Ctx } from "../src/routes/shared";
import { FakeStore, testPlan } from "./fake-store";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const GROK_VIDEO = "xai/grok-imagine-video";

class FakeNonChatRunner implements NonChatRunner {
  constructor(private readonly body: unknown) {}
  async run(_request: NonChatRunRequest): Promise<NonChatRunResult> {
    return { outcome: "ok", body: this.body, gatewayLogId: "log_1", contentType: null };
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
 * Await `promise` while stepping fake timers. The rehost wait polls R2 for up to 45s, and the handler
 * reaches it only after several async gate reads, so time has to advance while the promise is pending.
 */
async function untilSettled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  // Yield on the REAL event loop between steps: webcrypto resolves off-thread, so microtask flushing alone
  // can run the whole loop before the handler has reached the wait.
  for (let i = 0; i < 500 && !done; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise<void>((r) => setImmediate(r));
  }
  return tracked;
}

async function harness(opts: { body: unknown; objectLands: boolean }) {
  const store = new FakeStore({ nowSeconds: Math.floor(NOW.getTime() / 1000) });
  store.plans.set("test", testPlan({ allowed_tiers: "standard,premium" }));
  await store.createAccount({
    id: "acct_1",
    plan_id: "test",
    label: null,
    credit_micro_usd: 50_000_000,
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
  const media = { head: async () => (opts.objectLands ? { key: "k" } : null) };
  const ctx = {
    env: {
      CF_ACCOUNT_ID: "fabcb25d9c7eb087110ec474a03e50d2",
      AI_GATEWAY_ID: "prism-proxy",
      CF_AIG_TOKEN: "x".repeat(32),
      MEDIA: media,
    } as unknown as Env,
    store,
    runner: null,
    nonChatRunner: new FakeNonChatRunner(opts.body),
    credentials: new FakeCredentials(),
    logs: null,
    requestId: "req_test0000000000000000",
    now: NOW,
    waitUntil: (p: Promise<unknown>) => {
      deferred.push(p);
    },
  } as unknown as Ctx;
  const request = new Request("https://example.invalid/v1/videos/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${minted.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: GROK_VIDEO, prompt: "a cat" }),
  });
  return {
    store,
    run: async () => {
      const response = await untilSettled(handleRequest(ctx, request));
      await untilSettled(Promise.allSettled(deferred));
      return response;
    },
  };
}

describe("Grok video: charge only when there is a video to hand back", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records unmetered, and does not charge, when nothing landed and the body has no asset", async () => {
    const h = await harness({ body: { state: "Completed", result: {} }, objectLands: false });
    const response = await h.run();
    expect(response.status).not.toBe(200);
    expect(h.store.events).toHaveLength(1);
    expect(h.store.events[0]).toMatchObject({ metered: false, unmetered_reason: "no_video_payload" });
  });

  it("CONTROL: charges when the object landed in R2", async () => {
    const h = await harness({ body: { state: "Completed", result: {} }, objectLands: true });
    const response = await h.run();
    expect(response.status).toBe(200);
    expect(h.store.events.filter((e) => e.metered)).toHaveLength(1);
  });

  it("CONTROL: charges when the provider body carries an asset URL", async () => {
    const h = await harness({
      body: { state: "Completed", result: { video: "https://cdn.example.invalid/v.mp4" } },
      objectLands: false,
    });
    const response = await h.run();
    expect(response.status).toBe(200);
    expect(h.store.events.filter((e) => e.metered)).toHaveLength(1);
  });
});
