// The vertical slice, end to end, with no workerd and no network.
//
// This is what the store interface and the InferenceRunner interface were for: every gate in
// src/routes/chat.ts is exercised here against a real Request and a real Response, so "does the plane
// refuse" and "does the ledger move" are unit-testable facts rather than things a deploy finds out.

import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { mintClientKey } from "../src/auth";
import { sha256Hex } from "../src/crypto";
import type { Env } from "../src/env";
import type { InferenceRequest, InferenceResult, InferenceRunner } from "../src/inference";
import type { Ctx } from "../src/routes/shared";
import { FakeStore, testPlan } from "./fake-store";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const MODEL = "@cf/meta/llama-3.2-3b-instruct";

class FakeRunner implements InferenceRunner {
  calls: InferenceRequest[] = [];
  constructor(private readonly result: InferenceResult) {}
  async run(request: InferenceRequest): Promise<InferenceResult> {
    this.calls.push(request);
    return this.result;
  }
}

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
  key: string;
  clientId: string;
  deferred: Promise<unknown>[];
}

async function harness(
  options: { result?: InferenceResult; plan?: ReturnType<typeof testPlan>; env?: Partial<Env>; withRunner?: boolean } = {},
): Promise<Harness> {
  const store = new FakeStore({ nowSeconds: Math.floor(NOW.getTime() / 1000) });
  store.plans.set("test", options.plan ?? testPlan());
  await store.createAccount({ id: "acct_1", plan_id: "test", label: null });
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
  const deferred: Promise<unknown>[] = [];
  const ctx: Ctx = {
    env: { AI_GATEWAY_ID: "prism-hosted", ...options.env } as Env,
    store,
    runner,
    requestId: "req_test0000000000000000",
    now: NOW,
    waitUntil: (promise) => {
      deferred.push(promise);
    },
  };
  return { ctx, store, runner, key: minted.key, clientId: minted.clientId, deferred };
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

    // 1,000,000 input at 51,000/Mtok = 51,000; 1,000,000 output at 335,000/Mtok = 335,000.
    expect(response.headers.get("prism-usage-micro-usd")).toBe("386000");
    expect(response.headers.get("prism-metered")).toBe("true");
    expect(response.headers.get("prism-usage-recorded")).toBe("true");
    expect(response.headers.get("prism-quota-period")).toBe("2026-08");
    expect(response.headers.get("prism-quota-used-micro-usd")).toBe("386000");
    expect(response.headers.get("prism-quota-included-micro-usd")).toBe("1000000");
    expect(response.headers.get("prism-quota-remaining-micro-usd")).toBe("614000");
    expect(response.headers.get("prism-model")).toBe(MODEL);

    // OpenAI-shaped body so an OpenAI SDK consumes it unchanged.
    expect(await response.json()).toMatchObject({
      object: "chat.completion",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "Neurons measure GPU compute." } }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
    });

    expect(h.store.events).toHaveLength(1);
    expect(h.store.events[0]).toMatchObject({ metered: true, micro_usd: 386_000, gateway_log_id: "log_1" });
    expect(h.store.periods.get("acct_1|2026-08")).toMatchObject({
      micro_usd: 386_000,
      requests: 1,
      unmetered_requests: 0,
    });
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

  it("402s a spent allowance with the period and reset instant", async () => {
    const h = await harness();
    h.store.periods.set("acct_1|2026-08", {
      account_id: "acct_1",
      period_key: "2026-08",
      micro_usd: 1_000_000,
      requests: 3,
      unmetered_requests: 0,
    });
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    // 402, not 429: budgetary, not temporal. Retrying will not help until the period rolls.
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: { code: "quota_exhausted", period: "2026-08", resets_at: "2026-09-01T00:00:00.000Z" },
    });
    // And nothing was spent.
    expect(h.runner?.calls).toHaveLength(0);
  });

  it("503s an indeterminate usage position rather than blaming the account", async () => {
    const h = await harness();
    h.store.periods.set("acct_1|2026-08", {
      account_id: "acct_1",
      period_key: "2026-08",
      micro_usd: -1,
      requests: 0,
      unmetered_requests: 0,
    });
    const response = await handleRequest(h.ctx, chat(h.key, ASK));
    expect(response.status).toBe(503);
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

  it("501s streaming rather than silently ignoring it", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, chat(h.key, { ...ASK, stream: true }));
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: { code: "not_implemented" } });
    expect(h.runner?.calls).toHaveLength(0);
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
    expect(h.store.events[0].unmetered_reason).toContain("may have run");
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
    expect(response.headers.get("prism-quota-used-micro-usd")).toBe("0");
    expect(h.store.events).toHaveLength(0);
  });

  it("is idempotent on a replayed request id", async () => {
    const h = await harness();
    await handleRequest(h.ctx, chat(h.key, ASK));
    await handleRequest(h.ctx, chat(h.key, ASK));
    // Same pinned request id both times: the ledger ignores the duplicate and the counter does not move
    // twice. A retried write must never advance the rolled-up total past the rows it summarises.
    expect(h.store.events).toHaveLength(1);
    expect(h.store.periods.get("acct_1|2026-08")?.micro_usd).toBe(386_000);
  });
});

describe("GET /v1/usage", () => {
  it("reports the period, the allowance, and the unmetered count", async () => {
    const h = await harness();
    await handleRequest(h.ctx, chat(h.key, ASK));
    const response = await handleRequest(h.ctx, get("/v1/usage", h.key));
    expect(await response.json()).toEqual({
      period: "2026-08",
      period_start: "2026-08-01T00:00:00.000Z",
      period_end: "2026-09-01T00:00:00.000Z",
      included_micro_usd: 1_000_000,
      used_micro_usd: 386_000,
      remaining_micro_usd: 614_000,
      requests: 1,
      unmetered_requests: 0,
    });
  });

  it("reports a fresh account as zero rather than failing", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, get("/v1/usage", h.key));
    expect(await response.json()).toMatchObject({ used_micro_usd: 0, requests: 0 });
  });
});

describe("GET /v1/me", () => {
  it("returns client, account, plan, and usage", async () => {
    const h = await harness();
    const response = await handleRequest(h.ctx, get("/v1/me", h.key));
    expect(await response.json()).toMatchObject({
      client: { id: h.clientId, platform: "ios" },
      account: { id: "acct_1", plan_id: "test", status: "active" },
      plan: { id: "test", included_micro_usd: 1_000_000, allowed_tiers: ["standard"] },
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
});
