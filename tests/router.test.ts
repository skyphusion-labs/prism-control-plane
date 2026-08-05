// The vertical slice, end to end, with no workerd and no network.
//
// This is what the store interface and the InferenceRunner interface were for: every gate in
// src/routes/chat.ts is exercised here against a real Request and a real Response, so "does the plane
// refuse" and "does the ledger move" are unit-testable facts rather than things a deploy finds out.

import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { mintClientKey } from "../src/auth";
import { sha256Hex } from "../src/crypto";
import type { GatewayLogSource } from "../src/aig-logs";
import type { Env } from "../src/env";
import type { InferenceRequest, InferenceResult, InferenceRunner } from "../src/inference";
import type { CredentialOutcome, UpstreamCredentialSource } from "../src/token-minter";
import type { Ctx } from "../src/routes/shared";
import { FakeLogSource, logRow } from "./fake-gateway-logs";
import { FakeStore, testPlan } from "./fake-store";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const MODEL = "@cf/meta/llama-3.2-3b-instruct";
/** A catalog model that is not chat, so it has no door here. */
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

class FakeRunner implements InferenceRunner {
  calls: InferenceRequest[] = [];
  constructor(private readonly result: InferenceResult) {}
  async run(request: InferenceRequest): Promise<InferenceResult> {
    this.calls.push(request);
    return this.result;
  }
}

/**
 * A credential source that hands back a fixed credential.
 *
 * The point of asserting through a fake here is that the ROUTE's behaviour is what matters: that it asks for
 * a credential, refuses when there is none, and never puts the value anywhere a client can see it. Which
 * MODE produced the credential is deliberately invisible to the route, so the same fake covers both, and the
 * real minter's Cloudflare conversation is tested separately in token-minter.test.ts.
 */
class FakeCredentialSource implements UpstreamCredentialSource {
  asked: string[] = [];
  revoked: string[] = [];
  constructor(
    private readonly outcome: CredentialOutcome,
    readonly mode: "shared" | "per-user" = "shared",
  ) {}
  async forAccount(accountId: string): Promise<CredentialOutcome> {
    this.asked.push(accountId);
    return this.outcome;
  }
  async revokeForAccount(accountId: string): Promise<boolean> {
    this.revoked.push(accountId);
    return true;
  }
}

const OK_CREDENTIAL: CredentialOutcome = {
  outcome: "ok",
  credential: { tokenId: "cftok_1", value: "cf-secret-value" },
  minted: false,
};

/** Build an SSE body the way Cloudflare's OpenAI-compatible stream does, usage last. */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

const STREAM_FRAMES = [
  'data: {"choices":[{"delta":{"content":"Neurons "}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"measure compute."}}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":1000000,"completion_tokens":1000000}}\n\n',
  "data: [DONE]\n\n",
];

/** A Workers-AI-shaped answer with usable token counts. */
function okResult(inputTokens = 1_000_000, outputTokens = 1_000_000): InferenceResult {
  return {
    outcome: "ok",
    body: {
      response: "Neurons measure GPU compute.",
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
    },
    gatewayLogId: "log_1",
  };
}

interface Harness {
  ctx: Ctx;
  store: FakeStore;
  runner: FakeRunner | null;
  credentials: FakeCredentialSource | null;
  key: string;
  clientId: string;
  deferred: Promise<unknown>[];
}

async function harness(
  options: {
    result?: InferenceResult;
    plan?: ReturnType<typeof testPlan>;
    env?: Partial<Env>;
    withRunner?: boolean;
    withTokens?: boolean;
    credential?: CredentialOutcome;
    credentialMode?: "shared" | "per-user";
    credit?: number;
    /** The gateway log feed. Null is the deployment that cannot read its own bill. */
    logs?: GatewayLogSource | null;
  } = {},
): Promise<Harness> {
  const store = new FakeStore({ nowSeconds: Math.floor(NOW.getTime() / 1000) });
  const plan = options.plan ?? testPlan();
  store.plans.set("test", plan);
  await store.createAccount({
    id: "acct_1",
    plan_id: "test",
    label: null,
    credit_micro_usd: options.credit ?? plan.signup_credit_micro_usd,
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

  const runner = options.withRunner === false ? null : new FakeRunner(options.result ?? okResult());
  const credentials =
    options.withTokens === false
      ? null
      : new FakeCredentialSource(
          options.credential ?? OK_CREDENTIAL,
          options.credentialMode ?? "shared",
        );
  const deferred: Promise<unknown>[] = [];
  const ctx: Ctx = {
    env: {
      // 32 hex -- matches CF account id format enforced in gatewayConfig.
      CF_ACCOUNT_ID: "fabcb25d9c7eb087110ec474a03e50d2",
      AI_GATEWAY_ID: "prism-proxy",
      ...options.env,
    } as Env,
    store,
    runner,
    nonChatRunner: null,
    credentials,
    logs: options.logs === undefined ? new FakeLogSource() : options.logs,
    requestId: "req_test0000000000000000",
    now: NOW,
    waitUntil: (promise) => {
      deferred.push(promise);
    },
  };
  return { ctx, store, runner, credentials, key: minted.key, clientId: minted.clientId, deferred };
}

function chat(key: string | null, body: unknown): Request {
  return new Request("https://example.invalid/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, key?: string): Request {
  return new Request(`https://example.invalid${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}

const ASK = { model: MODEL, messages: [{ role: "user", content: "What is a neuron?" }] };

describe("health", () => {
  it("answers liveness without touching a binding", async () => {
    const h = await harness();
    h.store.probeFails = true;
    const response = await handleRequest(h.ctx, get("/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: "prism-control-plane" });
  });

  it("answers readiness 503 when the schema probe fails", async () => {
    const h = await harness();
    h.store.probeFails = true;
    const response = await handleRequest(h.ctx, get("/health/deep"));
    // 503, not 200-with-ok-false: a monitor watching status codes must be able to see this fail.
    expect(response.status).toBe(503);
  });

  it("answers readiness 503 when no gateway is configured", async () => {
    const h = await harness({ env: { AI_GATEWAY_ID: "" } });
    const response = await handleRequest(h.ctx, get("/health/deep"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { checks: { name: string; ok: boolean }[] };
    expect(body.checks.find((check) => check.name === "ai_gateway")?.ok).toBe(false);
  });

  it("distinguishes a missing credential from a missing gateway", async () => {
    // Both close the inference door with the same 503, which is correct behaviour and useless diagnostics.
    // Separate checks are what turn "inference is down" into "which secret is missing".
    const h = await harness({ withTokens: false });
    const response = await handleRequest(h.ctx, get("/health/deep"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { checks: { name: string; ok: boolean }[] };
    expect(body.checks.find((check) => check.name === "ai_gateway")?.ok).toBe(true);
    expect(body.checks.find((check) => check.name === "upstream_credential")?.ok).toBe(false);
  });

  it("names the shared credential posture, and flags a retired per-user misdeploy", async () => {
    // Product is one shared CF_AIG_TOKEN. Readiness says so out loud, and a leftover
    // UPSTREAM_CREDENTIAL_MODE=per-user is a closed door with an explicit reason, not a silent mint.
    const shared = await harness();
    const sharedBody = (await (await handleRequest(shared.ctx, get("/health/deep"))).json()) as {
      checks: { name: string; detail: string; ok: boolean }[];
    };
    const sharedCred = sharedBody.checks.find((check) => check.name === "upstream_credential");
    expect(sharedCred?.ok).toBe(true);
    expect(sharedCred?.detail).toMatch(/shared CF_AIG_TOKEN|cf-aig-metadata/i);

    // Harness injects a FakeCredentialSource by default; force real wiring for this misdeploy check.
    const perUser = await harness({
      env: { UPSTREAM_CREDENTIAL_MODE: "per-user", CF_AIG_TOKEN: "tok" },
      withTokens: false,
    });
    // Re-build credentials the way the Worker does: null when per-user is requested.
    const { upstreamCredentialSource } = await import("../src/index");
    perUser.ctx.credentials = upstreamCredentialSource(
      perUser.ctx.env,
      perUser.ctx.store,
      () => 0,
    );
    const perUserBody = (await (await handleRequest(perUser.ctx, get("/health/deep"))).json()) as {
      checks: { name: string; detail: string; ok: boolean }[];
    };
    const perUserCred = perUserBody.checks.find((check) => check.name === "upstream_credential");
    expect(perUserCred?.ok).toBe(false);
    expect(perUserCred?.detail).toMatch(/per-user|retired|500-token/i);
  });

  it("reports catalog pricing without failing readiness", async () => {
    // Non-chat modalities remain unpriced by design; chat is fully priced.
    // Readiness stays green either way — per-model gates own spendability.
    const h = await harness();
    const response = await handleRequest(h.ctx, get("/health/deep"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { checks: { name: string; ok: boolean; detail: string }[] };
    const pricing = body.checks.find((check) => check.name === "catalog_pricing");
    expect(pricing?.ok).toBe(true);
    expect(pricing?.detail).toMatch(/chat/);
  });

  it("answers readiness 200 when everything is wired", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, get("/health/deep"));
    expect(response.status).toBe(200);
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, get("/nope"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("404s a known path with the wrong method", async () => {
    // Method is matched, so a POST does not fall through to a handler that ignores the verb.
    const h = await harness();
    const response = await handleRequest(
      h.ctx,
      new Request("https://example.invalid/v1/models", { method: "POST" }),
    );
    expect(response.status).toBe(404);
  });

  it("stamps the api version and request id on every response", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, get("/health"));
    expect(response.headers.get("prism-api-version")).toBe("1");
    expect(response.headers.get("prism-request-id")).toBe("req_test0000000000000000");
  });
});

describe("authentication", () => {
  it("401s a missing bearer", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, get("/v1/me"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("401s a revoked key with a terminal code", async () => {
    const h = await harness();
    await h.store.revokeClient(h.clientId);
    const response = await handleRequest(h.ctx, get("/v1/me", h.key));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "client_revoked" } });
  });

  it("403s a suspended account", async () => {
    const h = await harness();
    const account = h.store.accounts.get("acct_1");
    if (account) account.suspended_at = NOW.toISOString();
    const response = await handleRequest(h.ctx, get("/v1/me", h.key));
    expect(response.status).toBe(403);
  });

  it("503s a dangling plan rather than blaming the credential", async () => {
    const h = await harness();
    h.store.plans.delete("test");
    const response = await handleRequest(h.ctx, get("/v1/me", h.key));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
  });
});

describe("GET /v1/models", () => {
  it("lists only entitled models", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, get("/v1/models", h.key));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string; tier: string }[] };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((model) => model.tier === "standard")).toBe(true);
  });

  it("lists nothing when the plan entitles nothing", async () => {
    // Absent rather than listed-and-forbidden: a picker must never offer an unusable option.
    const h = await harness({ plan: testPlan({ allowed_tiers: "" }) });
    const response = await handleRequest(h.ctx, get("/v1/models", h.key));
    expect((await response.json()) as unknown).toMatchObject({ data: [] });
  });
});

describe("POST /v1/chat/completions", () => {
  it("serves, meters, and records a completion", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(response.status).toBe(200);

    // 1,000,000 input at 50,900/Mtok = 50,900; 1,000,000 output at 335,000/Mtok = 335,000.
    expect(response.headers.get("prism-usage-micro-usd")).toBe("385900");
    expect(response.headers.get("prism-metered")).toBe("true");
    expect(response.headers.get("prism-usage-recorded")).toBe("true");
    expect(response.headers.get("prism-period")).toBe("2026-08");
    expect(response.headers.get("prism-credit-micro-usd")).toBe("1000000");
    expect(response.headers.get("prism-spent-micro-usd")).toBe("385900");
    expect(response.headers.get("prism-credit-remaining-micro-usd")).toBe("614100");
    expect(response.headers.get("prism-model")).toBe(MODEL);

    // OpenAI-shaped body so an OpenAI SDK consumes it unchanged.
    expect(await response.json()).toMatchObject({
      object: "chat.completion",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "Neurons measure GPU compute." } }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
    });

    expect(h.store.events).toHaveLength(1);
    expect(h.store.events[0]).toMatchObject({ metered: true, micro_usd: 385_900, gateway_log_id: "log_1" });
    expect(h.store.periods.get("acct_1|2026-08")).toMatchObject({
      micro_usd: 385_900,
      requests: 1,
      unmetered_requests: 0,
    });
    // The account counter, not just the period counter. This is the one the prepaid gate reads, so a period
    // row that moves while the account's spend does not would leave the gate permanently open.
    expect(h.store.accounts.get("acct_1")?.spent_micro_usd).toBe(385_900);
  });

  it("never leaks the upstream credential to the client", async () => {
    // THE CUSTODY ASSERTION. A device holding this value could call api.cloudflare.com directly, on our
    // account, past every gate in this plane. It must not appear in a body, a header, or an error.
    const h = await harness();
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    const body = await response.text();
    expect(body).not.toContain("cf-secret-value");
    expect(JSON.stringify([...response.headers])).not.toContain("cf-secret-value");
    expect(h.credentials?.asked).toEqual(["acct_1"]);
  });

  it("passes account attribution to the gateway and never message text", async () => {
    const h = await harness();
    await handleRequest(h.ctx, chat(h.key, ASK));
    const metadata = h.runner?.calls[0].metadata ?? {};
    expect(metadata).toMatchObject({ account_id: "acct_1", plan_id: "test" });
    expect(JSON.stringify(metadata)).not.toContain("neuron");
  });

  it("clamps max_tokens down to the plan ceiling and reports what was applied", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, chat(h.key, { ...ASK, max_tokens: 100_000 }));
    expect(response.headers.get("prism-max-tokens-applied")).toBe("1024");
    expect(h.runner?.calls[0].maxTokens).toBe(1024);
  });

  it("402s spent prepaid credit and does not spend anything more", async () => {
    const h = await harness();
    const account = h.store.accounts.get("acct_1");
    if (account) account.spent_micro_usd = account.credit_micro_usd;
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    // 402, not 429: budgetary, not temporal. Retrying will not help; only a top-up will.
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: { code: "quota_exhausted", credit_micro_usd: 1_000_000, spent_micro_usd: 1_000_000 },
    });
    // Refused BEFORE the upstream call and before a credential was even requested: a refusal that has
    // already asked Cloudflare for something is a refusal that costs money.
    expect(h.runner?.calls).toHaveLength(0);
    expect(h.credentials?.asked).toEqual([]);
  });

  it("stays 402 after the bounded overshoot rather than reporting a debt", async () => {
    // The last allowed request can carry an account past its credit, because the cost is unknowable until
    // the model answers. What must not happen is that state reading as anything other than "top up".
    const h = await harness();
    const account = h.store.accounts.get("acct_1");
    if (account) account.spent_micro_usd = account.credit_micro_usd + 500_000;
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(response.status).toBe(402);
    expect(h.runner?.calls).toHaveLength(0);
  });

  it("503s an indeterminate credit position rather than blaming the account", async () => {
    // A corrupt counter is OUR bug. Answering 402 would tell a paying user their credit is gone when it may
    // be untouched: plausible, user-blaming, and invisible to us.
    const h = await harness();
    const account = h.store.accounts.get("acct_1");
    if (account) account.spent_micro_usd = -1;
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(response.status).toBe(503);
    expect(h.runner?.calls).toHaveLength(0);
  });

  it("503s when no upstream credential can be obtained, without leaking why", async () => {
    const h = await harness({
      credential: { outcome: "unavailable", reason: "mint refused by Cloudflare: HTTP 403 authz" },
    });
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(response.status).toBe(503);
    const body = await response.text();
    // The operator reason is a Cloudflare permissions detail. It belongs in the log, not on a phone.
    expect(body).not.toContain("Cloudflare");
    expect(body).not.toContain("403");
    expect(h.runner?.calls).toHaveLength(0);
  });

  it("404s a model outside the catalog and 403s one outside the plan", async () => {
    const h = await harness();
    const missing = await handleRequest(h.ctx, chat(h.key, { ...ASK, model: "openai/gpt-4.1-mini" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "model_not_found" } });

    const barred = await harness({ plan: testPlan({ allowed_tiers: "premium" }) });
    const forbidden = await handleRequest(barred.ctx, chat(barred.key, ASK));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "model_not_entitled" } });
  });

  it("relays a stream byte-for-byte and meters it from the trailing usage frame", async () => {
    // TWO THINGS AT ONCE, and both matter. The bytes must reach the client unmodified, so an OpenAI SDK sees
    // Cloudflare's own frames; and the token counts in the LAST frame must still land in the ledger, because
    // a stream that serves without metering is exactly the hole this plane exists to close.
    const h = await harness({
      result: { outcome: "stream", stream: sseStream(STREAM_FRAMES), gatewayLogId: "log_stream" },
    });
    const response = await handleRequest(h.ctx, chat(h.key, { ...ASK, stream: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("prism-stream")).toBe("true");
    // The price CANNOT be a header on a stream: the counts arrive after the headers are already sent. An
    // honest absence is required here -- a zero would read as a free request.
    expect(response.headers.get("prism-usage-micro-usd")).toBeNull();
    expect(response.headers.get("prism-metered")).toBeNull();

    expect(await response.text()).toBe(STREAM_FRAMES.join(""));

    // The ledger row is written when the stream settles, via waitUntil.
    await Promise.all(h.deferred);
    expect(h.store.events).toHaveLength(1);
    expect(h.store.events[0]).toMatchObject({
      metered: true,
      micro_usd: 385_900,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      gateway_log_id: "log_stream",
    });
  });

  it("records a stream with no usage frame as unmetered rather than as free", async () => {
    // The unmetered doctrine, on the streaming path. A stream that ends without the usage frame we asked for
    // is service we cannot price; it goes in the ledger with a reason so the gap is countable.
    const h = await harness({
      result: {
        outcome: "stream",
        stream: sseStream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]),
        gatewayLogId: null,
      },
    });
    const response = await handleRequest(h.ctx, chat(h.key, { ...ASK, stream: true }));
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(h.deferred);
    expect(h.store.events).toHaveLength(1);
    expect(h.store.events[0]).toMatchObject({ metered: false, micro_usd: 0 });
    expect(h.store.events[0].unmetered_reason).toBeTruthy();
  });

  it("503s when no gateway is configured instead of calling off-gateway", async () => {
    const h = await harness({ withRunner: false });
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
  });

  it("429s past the plan's rate limit with a retry-after", async () => {
    const h = await harness({ plan: testPlan({ requests_per_minute: 2 }) });
    expect((await handleRequest(h.ctx, chat(h.key, ASK))).status).toBe(200);
    expect((await handleRequest(h.ctx, chat(h.key, ASK))).status).toBe(200);
    const limited = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("400s an invalid body before authenticating", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, chat(null, { ...ASK, tools: [] }));
    // Shape is checked before identity, so a malformed body costs no D1 read; a 401 here would mean the
    // order had been reversed.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("413s an oversized body", async () => {
    const h = await harness();
    const response = await handleRequest(
      h.ctx,
      chat(h.key, { ...ASK, messages: [{ role: "user", content: "x".repeat(300_000) }] }),
    );
    expect(response.status).toBe(413);
  });

  it("records an unmetered request when the model reports no usage", async () => {
    const h = await harness({
      result: { outcome: "ok", body: { response: "hi" }, gatewayLogId: null },
    });
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(response.status).toBe(200);
    expect(response.headers.get("prism-metered")).toBe("false");
    expect(response.headers.get("prism-usage-micro-usd")).toBe("0");
    // No `usage` block, because we have no counts to report. Reporting zeros would be a claim we cannot
    // support.
    expect(await response.json()).not.toHaveProperty("usage");

    expect(h.store.events[0]).toMatchObject({ metered: false, micro_usd: 0 });
    expect(h.store.events[0].unmetered_reason).toContain("no usable token counts");
    // Counted as a request and as a gap, charged nothing.
    expect(h.store.periods.get("acct_1|2026-08")).toMatchObject({
      micro_usd: 0,
      requests: 1,
      unmetered_requests: 1,
    });
  });

  it("504s a timeout AND writes the gap to the ledger", async () => {
    // The wait was abandoned but the model was never cancelled, so this is probably spend we cannot
    // price. Dropping it would make abandoned spend indistinguishable from a request that never happened.
    const h = await harness({ result: { outcome: "timeout", waitedMs: 60_000 } });
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "upstream_timeout" } });
    expect(h.store.events[0]).toMatchObject({ metered: false, micro_usd: 0 });
    expect(h.store.events[0].unmetered_reason).toContain("did not answer");
    expect(h.store.periods.get("acct_1|2026-08")?.unmetered_requests).toBe(1);
  });

  it("502s an upstream error and writes NO ledger row", async () => {
    // The asymmetry with the timeout is deliberate: the provider told us it did not serve the request, so
    // there is normally nothing to price, and a row per provider 429 would flood the unmetered signal.
    const h = await harness({
      result: { outcome: "upstream_error", status: 429, detail: "capacity" },
    });
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "upstream_error", upstream_status: 429 },
    });
    expect(h.store.events).toHaveLength(0);
  });

  it("502s a response with no extractable text", async () => {
    const h = await harness({
      result: { outcome: "ok", body: { unexpected: true }, gatewayLogId: null },
    });
    expect((await handleRequest(h.ctx, chat(h.key, ASK))).status).toBe(502);
  });

  it("reads the OpenAI response shape as well as the Workers AI one", async () => {
    const h = await harness({
      result: {
        outcome: "ok",
        body: {
          choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        },
        gatewayLogId: null,
      },
    });
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    });
    expect(h.store.events[0]).toMatchObject({ metered: true, input_tokens: 10, output_tokens: 20 });
  });

  it("reports a failed ledger write instead of hiding it", async () => {
    const h = await harness();
    h.store.failNextRecordUsage = true;
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    // The upstream spend already happened, so withholding the answer would waste it. The gap is reported
    // rather than swallowed.
    expect(response.status).toBe(200);
    expect(response.headers.get("prism-usage-recorded")).toBe("false");
    // The spend header reports what was RECORDED, so an unrecorded charge reads as zero spend rather than as
    // a balance movement that never happened.
    expect(response.headers.get("prism-spent-micro-usd")).toBe("0");
    expect(h.store.events).toHaveLength(0);
  });

  it("is idempotent on a replayed request id", async () => {
    const h = await harness();
    await handleRequest(h.ctx, chat(h.key, ASK));
    await handleRequest(h.ctx, chat(h.key, ASK));
    // Same pinned request id both times: the ledger ignores the duplicate and the counter does not move
    // twice. A retried write must never advance the rolled-up total past the rows it summarises.
    expect(h.store.events).toHaveLength(1);
    expect(h.store.periods.get("acct_1|2026-08")?.micro_usd).toBe(385_900);
    expect(h.store.accounts.get("acct_1")?.spent_micro_usd).toBe(385_900);
  });

  it("400s the retired chat-door image field", async () => {
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const h = await harness({ plan: testPlan({ allowed_tiers: "standard" }) });
    const res = await handleRequest(
      h.ctx,
      chat(h.key, {
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 32,
        image: tinyPng,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(h.runner?.calls).toHaveLength(0);
  });

  it("applies an operator override rate end to end", async () => {
    const h = await harness({ plan: testPlan({ allowed_tiers: "standard" }) });
    await h.store.putModelPrice({
      model_id: MODEL,
      input_micro_usd_per_mtok: 3_000_000,
      output_micro_usd_per_mtok: 15_000_000,
      unit_micro_usd: null,
      priced_at: "2026-08-04",
      note: null,
    });
    // Fake runner returns 1M/1M tokens; at 3+15 USD/Mtok that is 18 USD = 18_000_000 micro.
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(response.status).toBe(200);
    expect(response.headers.get("prism-usage-micro-usd")).toBe("18000000");
    expect(h.store.events[0]).toMatchObject({ metered: true, micro_usd: 18_000_000 });
  });

  it("501s a non-chat model on the chat door and points at the correct door", async () => {
    const h = await harness({ plan: testPlan({ allowed_tiers: "standard,premium" }) });
    const response = await handleRequest(h.ctx, chat(h.key, { ...ASK, model: IMAGE_MODEL }));
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_unsupported");
    expect(body.error.message).toContain("/v1/images/generations");
    expect(h.runner?.calls).toHaveLength(0);
  });
});

describe("GET /v1/models", () => {
  it("publishes spendable for priced chat and unit-priced image; unpriced UB image stays false", async () => {
    const h = await harness({ plan: testPlan({ allowed_tiers: "standard,premium" }) });
    const response = await handleRequest(h.ctx, get("/v1/models", h.key));
    const body = (await response.json()) as {
      data: { id: string; spendable: boolean; price: unknown; unit_price: unknown }[];
    };
    expect(body.data.find((model) => model.id === "@cf/llava-hf/llava-1.5-7b-hf")).toBeUndefined();
    // FLUX-1 schnell has a derived unit price from published rates.
    const flux = body.data.find((model) => model.id === IMAGE_MODEL);
    expect(flux?.spendable).toBe(true);
    expect(flux?.unit_price).toMatchObject({ unit: "request" });
    // Unified Billing image with no unit rate stays unspendable.
    const ubImage = body.data.find((model) => model.id === "google/nano-banana-2");
    expect(ubImage?.spendable).toBe(false);
    expect(body.data.find((model) => model.id === MODEL)?.spendable).toBe(true);
  });

  it("publishes an operator override as the price that will be charged", async () => {
    const h = await harness({ plan: testPlan({ allowed_tiers: "standard" }) });
    await h.store.putModelPrice({
      model_id: MODEL,
      input_micro_usd_per_mtok: 3_000_000,
      output_micro_usd_per_mtok: 15_000_000,
      unit_micro_usd: null,
      priced_at: "2026-08-04",
      note: null,
    });
    const response = await handleRequest(h.ctx, get("/v1/models", h.key));
    const body = (await response.json()) as {
      data: { id: string; spendable: boolean; price: { source: string; input_micro_usd_per_mtok: number } | null }[];
    };
    const overridden = body.data.find((model) => model.id === MODEL);
    expect(overridden?.spendable).toBe(true);
    expect(overridden?.price?.source).toBe("operator");
    expect(overridden?.price?.input_micro_usd_per_mtok).toBe(3_000_000);
  });
});

describe("GET /v1/usage", () => {
  it("reports the prepaid position and the unmetered count", async () => {
    const h = await harness();
    await handleRequest(h.ctx, chat(h.key, ASK));
    const response = await handleRequest(h.ctx, get("/v1/usage", h.key));
    expect(await response.json()).toEqual({
      credit_micro_usd: 1_000_000,
      spent_micro_usd: 385_900,
      remaining_micro_usd: 614_100,
      monthly_included_micro_usd: 0,
      allowance_spent_micro_usd: 0,
      allowance_remaining_micro_usd: 0,
      spendable_remaining_micro_usd: 614_100,
      overage: false,
      period: "2026-08",
      period_start: "2026-08-01T00:00:00.000Z",
      period_end: "2026-09-01T00:00:00.000Z",
      period_micro_usd: 385_900,
      period_requests: 1,
      period_unmetered_requests: 0,
      period_adjust_spend_micro_usd: 0,
      period_adjust_credit_micro_usd: 0,
      period_reconciled_micro_usd: 385_900,
    });
  });

  it("publishes a true-up in both directions without touching the estimate", async () => {
    const h = await harness();
    await handleRequest(h.ctx, chat(h.key, ASK));
    // Applied through the store the way reconciliation does, so the response is asserted against the same
    // columns a real run moves rather than against a hand-set field.
    await h.store.applyUsageAdjustment({
      id: "adj_up",
      account_id: "acct_1",
      usage_event_id: h.store.events[0].id,
      request_id: h.store.events[0].request_id,
      gateway_log_id: "log_up",
      period_key: "2026-08",
      model_id: MODEL,
      estimate_micro_usd: 385_900,
      gateway_micro_usd: 386_400,
      delta_micro_usd: 500,
      direction: "spend",
      applied_micro_usd: 500,
      idempotency_key: "aig:log_up",
      note: null,
    });
    await h.store.applyUsageAdjustment({
      id: "adj_down",
      account_id: "acct_1",
      usage_event_id: h.store.events[0].id,
      request_id: h.store.events[0].request_id,
      gateway_log_id: "log_down",
      period_key: "2026-08",
      model_id: MODEL,
      estimate_micro_usd: 385_900,
      gateway_micro_usd: 385_800,
      delta_micro_usd: -100,
      direction: "credit",
      applied_micro_usd: 100,
      idempotency_key: "aig:log_down",
      note: null,
    });

    const response = await handleRequest(h.ctx, get("/v1/usage", h.key));
    expect(await response.json()).toMatchObject({
      // THE ESTIMATE IS UNCHANGED. That is the property the two separate counters exist to preserve.
      period_micro_usd: 385_900,
      period_adjust_spend_micro_usd: 500,
      period_adjust_credit_micro_usd: 100,
      period_reconciled_micro_usd: 386_300,
      // A downward true-up is a credit grant, not a decrement of spend: both columns only ever rise.
      spent_micro_usd: 386_400,
      credit_micro_usd: 1_000_100,
      remaining_micro_usd: 613_700,
    });
  });

  it("reports a fresh account as zero spend rather than failing", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, get("/v1/usage", h.key));
    expect(await response.json()).toMatchObject({ spent_micro_usd: 0, period_requests: 0 });
  });
});

describe("GET /v1/me", () => {
  it("returns client, account, plan, and usage", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, get("/v1/me", h.key));
    expect(await response.json()).toMatchObject({
      client: { id: h.clientId, platform: "ios" },
      account: { id: "acct_1", plan_id: "test", status: "active" },
      plan: { id: "test", signup_credit_micro_usd: 1_000_000, allowed_tiers: ["standard"] },
      usage: { period: "2026-08" },
    });
  });
});

describe("enrollment", () => {
  async function mintToken(h: Harness, accountId = "acct_1"): Promise<string> {
    const token = "enroll-token-" + accountId;
    await h.store.createEnrollment({
      token_hash: await sha256Hex(token),
      account_id: accountId,
      expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
      note: null,
    });
    return token;
  }

  function enroll(body: unknown): Request {
    return new Request("https://example.invalid/v1/clients", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify(body),
    });
  }

  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it("trades a token for a usable client key, once", async () => {
    const token = await mintToken(h);
    const response = await handleRequest(
      h.ctx,
      enroll({ enrollment_token: token, label: "Test phone", platform: "android" }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { key: string; client_id: string };
    expect(body.key).toMatch(/^pcp_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);

    // The minted key authenticates immediately.
    const me = await handleRequest(h.ctx, get("/v1/me", body.key));
    expect(me.status).toBe(200);
  });

  it("refuses a replayed token", async () => {
    const token = await mintToken(h);
    expect((await handleRequest(h.ctx, enroll({ enrollment_token: token }))).status).toBe(201);
    const replay = await handleRequest(h.ctx, enroll({ enrollment_token: token }));
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("refuses an expired token", async () => {
    await h.store.createEnrollment({
      token_hash: await sha256Hex("stale-token-value"),
      account_id: "acct_1",
      expires_at: new Date(NOW.getTime() - 1000).toISOString(),
      note: null,
    });
    expect(
      (await handleRequest(h.ctx, enroll({ enrollment_token: "stale-token-value" }))).status,
    ).toBe(403);
  });

  it("gives one answer for unknown, consumed, and expired tokens", async () => {
    // Distinguishing them would turn this door into an oracle for guessing valid tokens.
    const unknown = await handleRequest(h.ctx, enroll({ enrollment_token: "no-such-token-value" }));
    expect(unknown.status).toBe(403);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toContain(
      "single-use",
    );
  });

  it("throttles enrollment attempts per network", async () => {
    for (let i = 0; i < 5; i++) await handleRequest(h.ctx, enroll({ enrollment_token: "bad-token-x" }));
    const limited = await handleRequest(h.ctx, enroll({ enrollment_token: "bad-token-x" }));
    expect(limited.status).toBe(429);
  });

  it("rejects unknown enrollment fields", async () => {
    const token = await mintToken(h);
    const response = await handleRequest(
      h.ctx,
      enroll({ enrollment_token: token, device_id: "sneaky" }),
    );
    expect(response.status).toBe(400);
  });
});

describe("operator surface", () => {
  it("503s every admin route when ADMIN_TOKEN is unset", async () => {
    // Fails closed by construction: a deploy that forgot the secret cannot be driven by anyone.
    const h = await harness();
    const response = await handleRequest(
      h.ctx,
      new Request("https://example.invalid/admin/accounts", {
        method: "POST",
        headers: { authorization: "Bearer anything", "content-type": "application/json" },
        body: JSON.stringify({ plan_id: "test" }),
      }),
    );
    expect(response.status).toBe(503);
  });

  it("mints an account, an enrollment token, and revokes a client", async () => {
    const h = await harness({ env: { ADMIN_TOKEN: "operator-secret" } });
    const admin = (path: string, body: unknown) =>
      new Request(`https://example.invalid${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer operator-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const created = await handleRequest(h.ctx, admin("/admin/accounts", { plan_id: "test" }));
    expect(created.status).toBe(201);
    const account = (await created.json()) as { id: string };

    const minted = await handleRequest(
      h.ctx,
      admin("/admin/enrollments", { account_id: account.id, ttl_minutes: 30 }),
    );
    expect(minted.status).toBe(201);
    const token = (await minted.json()) as { enrollment_token: string };

    const enrolled = await handleRequest(
      h.ctx,
      new Request("https://example.invalid/v1/clients", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({ enrollment_token: token.enrollment_token }),
      }),
    );
    expect(enrolled.status).toBe(201);
    const client = (await enrolled.json()) as { client_id: string; key: string };

    const revoked = await handleRequest(
      h.ctx,
      admin(`/admin/clients/${client.client_id}/revoke`, {}),
    );
    expect(await revoked.json()).toMatchObject({ revoked: true });

    const after = await handleRequest(h.ctx, get("/v1/me", client.key));
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ error: { code: "client_revoked" } });
  });

  it("401s a wrong operator bearer", async () => {
    const h = await harness({ env: { ADMIN_TOKEN: "operator-secret" } });
    const response = await handleRequest(
      h.ctx,
      new Request("https://example.invalid/admin/accounts", {
        method: "POST",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: JSON.stringify({ plan_id: "test" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses an account against a plan that does not exist", async () => {
    const h = await harness({ env: { ADMIN_TOKEN: "operator-secret" } });
    const response = await handleRequest(
      h.ctx,
      new Request("https://example.invalid/admin/accounts", {
        method: "POST",
        headers: { authorization: "Bearer operator-secret", "content-type": "application/json" },
        body: JSON.stringify({ plan_id: "ghost" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("upserts a plan and allows accounts against it", async () => {
    const h = await harness({ env: { ADMIN_TOKEN: "operator-secret" } });
    const admin = (path: string, body: unknown) =>
      new Request(`https://example.invalid${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer operator-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const created = await handleRequest(
      h.ctx,
      admin("/admin/plans", {
        id: "ops",
        name: "Ops (provisional)",
        signup_credit_micro_usd: 500_000,
        monthly_included_micro_usd: 0,
        requests_per_minute: 30,
        max_output_tokens: 2048,
        allowed_tiers: ["standard", "premium"],
      }),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      id: "ops",
      allowed_tiers: ["standard", "premium"],
      created: true,
    });

    const again = await handleRequest(
      h.ctx,
      admin("/admin/plans", {
        id: "ops",
        name: "Ops (provisional)",
        signup_credit_micro_usd: 500_000,
        monthly_included_micro_usd: 1_000_000,
        requests_per_minute: 30,
        max_output_tokens: 2048,
        allowed_tiers: "standard,premium",
      }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      monthly_included_micro_usd: 1_000_000,
      created: false,
    });

    const account = await handleRequest(h.ctx, admin("/admin/accounts", { plan_id: "ops" }));
    expect(account.status).toBe(201);
  });

  it("refuses a plan with no known tiers", async () => {
    const h = await harness({ env: { ADMIN_TOKEN: "operator-secret" } });
    const response = await handleRequest(
      h.ctx,
      new Request("https://example.invalid/admin/plans", {
        method: "POST",
        headers: {
          authorization: "Bearer operator-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "bad",
          name: "Bad",
          signup_credit_micro_usd: 0,
          monthly_included_micro_usd: 0,
          requests_per_minute: 10,
          max_output_tokens: 128,
          allowed_tiers: ["nope"],
        }),
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /admin/reconcile", () => {
  const OPERATOR = { ADMIN_TOKEN: "operator-secret" };

  function reconcile(body: unknown, options: { bearer?: string | null; raw?: string } = {}): Request {
    const bearer = options.bearer === undefined ? "operator-secret" : options.bearer;
    return new Request("https://example.invalid/admin/reconcile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: options.raw ?? JSON.stringify(body),
    });
  }

  /** A settled row (older than SETTLE_MS) whose cost is above what the ledger charged. */
  function driftRow() {
    return logRow({
      id: "log_1",
      createdAt: "2026-08-04T10:00:00.000Z",
      requestId: "req_seed",
      costMicroUsd: 1500,
    });
  }

  async function seedLedger(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
    await h.store.recordUsage({
      id: "ue_seed",
      request_id: "req_seed",
      account_id: "acct_1",
      client_id: h.clientId,
      model_id: MODEL,
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
    });
    h.store.eventCreatedAt.set("ue_seed", "2026-08-04T10:00:00.000Z");
  }

  it("is gated by the operator bearer like every other admin route", async () => {
    const unset = await harness();
    expect((await handleRequest(unset.ctx, reconcile({}))).status).toBe(503);

    const h = await harness({ env: OPERATOR });
    expect((await handleRequest(h.ctx, reconcile({}, { bearer: "wrong" }))).status).toBe(401);
    expect((await handleRequest(h.ctx, reconcile({}, { bearer: null }))).status).toBe(401);
  });

  it("503s when the deployment cannot read its own bill", async () => {
    // No gateway coordinates or no token with AI Gateway Read. A reconciliation job that quietly did
    // nothing would look exactly like a healthy one that found no drift, so it refuses and says which
    // pieces are missing.
    const h = await harness({ env: OPERATOR, logs: null });
    const response = await handleRequest(h.ctx, reconcile({ dry_run: true }));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unavailable");
    expect(body.error.message).toContain("AI Gateway Read");
  });

  it("previews by default and writes nothing", async () => {
    // OMITTED MEANS DRY RUN. The default has to be the safe one on a route whose live mode moves money.
    const h = await harness({ env: OPERATOR, logs: new FakeLogSource({ rows: [driftRow()] }) });
    await seedLedger(h);
    const before = h.store.accounts.get("acct_1")?.spent_micro_usd;

    const response = await handleRequest(h.ctx, reconcile({ since: "2026-08-01T00:00:00.000Z" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dry_run: true,
      applied: 0,
      watermark_after: null,
      totals: { rows: 1, adjusted_spend: 1, spend_micro_usd: 500 },
    });
    expect(h.store.accounts.get("acct_1")?.spent_micro_usd).toBe(before);
    expect(h.store.adjustments).toHaveLength(0);
  });

  it("writes only on a literal false", async () => {
    const h = await harness({ env: OPERATOR, logs: new FakeLogSource({ rows: [driftRow()] }) });
    await seedLedger(h);
    const response = await handleRequest(
      h.ctx,
      reconcile({ dry_run: false, since: "2026-08-01T00:00:00.000Z" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dry_run: false, applied: 1 });
    expect(h.store.accounts.get("acct_1")?.spent_micro_usd).toBe(1500);
  });

  it("refuses a dry_run that is not a boolean rather than reading it as truthy or falsy", async () => {
    // A truthiness check would make `"dry_run": "no"` a LIVE run, and that mistake fails in the direction
    // of a real charge against a real user's prepaid balance.
    const h = await harness({ env: OPERATOR });
    for (const value of ["no", 0, null]) {
      const response = await handleRequest(h.ctx, reconcile({ dry_run: value }));
      expect(response.status).toBe(400);
    }
  });

  it("refuses a bare POST with no body", async () => {
    // Kept rather than worked around: it means no run can start without somebody typing a body for it.
    const h = await harness({ env: OPERATOR });
    const response = await handleRequest(h.ctx, reconcile(null, { raw: "" }));
    expect(response.status).toBe(400);
  });

  it("refuses a malformed since or max_rows", async () => {
    const h = await harness({ env: OPERATOR });
    expect((await handleRequest(h.ctx, reconcile({ since: "last tuesday" }))).status).toBe(400);
    expect((await handleRequest(h.ctx, reconcile({ max_rows: 0 }))).status).toBe(400);
    expect((await handleRequest(h.ctx, reconcile({ max_rows: 1.5 }))).status).toBe(400);
  });

  it("400s a first run with no floor instead of paging the whole gateway history", async () => {
    const h = await harness({ env: OPERATOR });
    const response = await handleRequest(h.ctx, reconcile({}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("502s when the log feed cannot be read, rather than reporting an empty run", async () => {
    const h = await harness({
      env: OPERATOR,
      logs: new FakeLogSource({ fail: "ai-gateway logs: HTTP 403 (9109 Unauthorized)" }),
    });
    const response = await handleRequest(
      h.ctx,
      reconcile({ dry_run: false, since: "2026-08-01T00:00:00.000Z" }),
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("upstream_error");
    // Cloudflare's own code reaches the operator: 9109 and a 400 need different fixes.
    expect(body.error.message).toContain("9109");
    expect(h.store.reconcileState.size).toBe(0);
  });

  it("is not reachable with a client key", async () => {
    const h = await harness({ env: OPERATOR });
    const response = await handleRequest(h.ctx, reconcile({}, { bearer: h.key }));
    expect(response.status).toBe(401);
  });

  it("answers 404 on a GET, like every other method mismatch", async () => {
    const h = await harness({ env: OPERATOR });
    const response = await handleRequest(h.ctx, get("/admin/reconcile"));
    expect(response.status).toBe(404);
  });
});
