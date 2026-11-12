// The in-flight cap (#100) on the live voice door (GET /v1/stt/stream).
//
// A voice session is charged when it closes, so it stays in flight for its whole life. The door claims
// the slot under the request id, hands it to the session DO (which releases it in finalize; see
// tests-integration/stt-session.test.ts), and releases it itself if the DO never opens the socket.
// The DO here is a stub: no socket, no Flux, no money.

import { describe, expect, it } from "vitest";
import { mintClientKey } from "../src/auth";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";
import type { Ctx } from "../src/routes/shared";
import { FakeStore, testPlan } from "./fake-store";

const NOW = new Date("2026-08-05T12:00:00.000Z");

type StubAnswer = "open" | "refuse" | "throw";

async function harness(answer: StubAnswer, cap = "2") {
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
  const fetched: Request[] = [];
  const stub = {
    async fetch(req: Request): Promise<Response> {
      fetched.push(req);
      if (answer === "throw") throw new Error("simulated DO failure");
      // Node cannot construct a 101 Response; the door reads only .status.
      if (answer === "open") return { status: 101 } as unknown as Response;
      return Response.json({ error: { code: "internal" } }, { status: 500 });
    },
  };
  const ctx: Ctx = {
    env: {
      CF_ACCOUNT_ID: "fabcb25d9c7eb087110ec474a03e50d2",
      AI_GATEWAY_ID: "prism-proxy",
      CF_AIG_TOKEN: "test-cf-aig-token-not-real",
      AI: {},
      STT_SESSION: { newUniqueId: () => "do_1", get: () => stub },
      MAX_IN_FLIGHT_PER_ACCOUNT: cap,
    } as unknown as Env,
    store,
    runner: null,
    nonChatRunner: null,
    credentials: null,
    logs: null,
    requestId: "req_voice_1",
    now: NOW,
    waitUntil: () => undefined,
  };
  return { ctx, store, key: minted.key, fetched };
}

function upgrade(key: string): Request {
  return new Request("https://example.invalid/v1/stt/stream", {
    method: "GET",
    headers: { upgrade: "websocket", authorization: `Bearer ${key}` },
  });
}

describe("the in-flight cap on the live voice door (#100)", () => {
  it("hands an opened session slot to the DO: the door does not release it", async () => {
    const h = await harness("open");
    const response = await handleRequest(h.ctx, upgrade(h.key));
    expect(response.status).toBe(101);
    expect(h.fetched).toHaveLength(1);
    // Held under the request id, which the signed handoff carries to the DO.
    expect(h.fetched[0].headers.get("x-prism-request-id")).toBe("req_voice_1");
    expect(h.store.inflight.get("req_voice_1")).toMatchObject({ account_id: "acct_1", kind: "voice" });
  });

  it("refuses at the cap before the DO is reached", async () => {
    const h = await harness("open", "1");
    h.store.inflight.set("req_busy", { account_id: "acct_1", kind: "chat", expires_at: 2_000_000_000 });
    const response = await handleRequest(h.ctx, upgrade(h.key));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "rate_limited", in_flight_cap: 1 } });
    expect(h.fetched).toHaveLength(0);
  });

  it("releases the slot when the DO does not open the socket", async () => {
    const h = await harness("refuse");
    const response = await handleRequest(h.ctx, upgrade(h.key));
    expect(response.status).toBe(500);
    expect(h.store.inflight.size).toBe(0);
  });

  it("releases the slot when the DO call throws", async () => {
    const h = await harness("throw");
    await expect(handleRequest(h.ctx, upgrade(h.key))).rejects.toThrow("simulated DO failure");
    expect(h.store.inflight.size).toBe(0);
  });
});
