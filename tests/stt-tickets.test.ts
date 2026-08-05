// Single-use STT session tickets (browser Sec-WebSocket-Protocol path).

import { describe, expect, it } from "vitest";
import { mintClientKey } from "../src/auth";
import { sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";
import type { Ctx } from "../src/routes/shared";
import {
  authFromSttUpgrade,
  parseSttTicket,
  STT_TICKET_TTL_SEC,
  STT_WS_PROTOCOL,
} from "../src/routes/stt-stream";
import { FakeStore, testPlan } from "./fake-store";

const NOW = new Date("2026-08-05T12:00:00.000Z");

async function harness() {
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
  const ctx: Ctx = {
    env: {
      CF_ACCOUNT_ID: "fabcb25d9c7eb087110ec474a03e50d2",
      AI_GATEWAY_ID: "prism-proxy",
    } as Env,
    store,
    runner: null,
    nonChatRunner: null,
    credentials: null,
    logs: null,
    requestId: "req_stt_ticket_test",
    now: NOW,
    waitUntil: () => undefined,
  };
  return { ctx, store, key: minted.key, clientId: minted.clientId };
}

describe("POST /v1/stt/sessions", () => {
  it("mints a parseable stt_ ticket bound to the caller", async () => {
    const h = await harness();
    const res = await handleRequest(
      h.ctx,
      new Request("https://example.invalid/v1/stt/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${h.key}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticket: string;
      expires_in: number;
      protocol: string;
      stream_path: string;
    };
    expect(parseSttTicket(body.ticket)).toBe(body.ticket);
    expect(body.expires_in).toBe(STT_TICKET_TTL_SEC);
    expect(body.protocol).toBe(STT_WS_PROTOCOL);
    expect(body.stream_path).toBe("/v1/stt/stream");

    const consumed = await h.store.consumeSttTicket(await sha256Hex(body.ticket));
    expect(consumed).toEqual({ account_id: "acct_1", client_id: h.clientId });
  });

  it("is single-use", async () => {
    const h = await harness();
    const res = await handleRequest(
      h.ctx,
      new Request("https://example.invalid/v1/stt/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${h.key}` },
      }),
    );
    const { ticket } = (await res.json()) as { ticket: string };
    const hash = await sha256Hex(ticket);
    expect(await h.store.consumeSttTicket(hash)).not.toBeNull();
    expect(await h.store.consumeSttTicket(hash)).toBeNull();
  });

  it("honours expiry", async () => {
    const h = await harness();
    await h.store.createSttTicket({
      token_hash: await sha256Hex("stt_" + "Z".repeat(43)),
      account_id: "acct_1",
      client_id: h.clientId,
      expires_at: new Date((h.store.nowSeconds - 10) * 1000).toISOString(),
    });
    expect(await h.store.consumeSttTicket(await sha256Hex("stt_" + "Z".repeat(43)))).toBeNull();
  });

  it("requires a client key", async () => {
    const h = await harness();
    const res = await handleRequest(
      h.ctx,
      new Request("https://example.invalid/v1/stt/sessions", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("upgrade auth does not accept pcp in protocol", () => {
  it("protocol path only accepts stt_ tickets", () => {
    const pcp = `pcp_${"a".repeat(16)}_${"A".repeat(43)}`;
    const ticket = `stt_${"B".repeat(43)}`;
    const reject = new Request("https://example.invalid/v1/stt/stream", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${STT_WS_PROTOCOL}, ${pcp}`,
      },
    });
    expect(authFromSttUpgrade(reject).kind).toBeNull();

    const ok = new Request("https://example.invalid/v1/stt/stream", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${STT_WS_PROTOCOL}, ${ticket}`,
      },
    });
    expect(authFromSttUpgrade(ok).kind).toBe("stt_ticket");
  });
});
