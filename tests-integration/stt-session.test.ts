// Durable Object harness for the live-voice STT meter.
//
// WHY THIS FILE EXISTS. Three of the four billing fixes in dc4b2d3 land in
// src/stt-session.ts (gateway metadata, bare-return finalize, operator unit
// price) and none of them had a test: this repo had no way to construct a
// SQLite-backed Durable Object. The node suite passed both before and after
// those fixes (474 tests, none of which could observe a session served and
// not charged). This file is the missing instrument.
//
// WHAT IT CAN OBSERVE
//   - env.AI.run arguments at the call site, including gateway.metadata
//     (the join key reconcile-run.ts / decideAdjustment consume)
//   - ctx.storage.sql meta after fetch (account, request, gateway_log_id)
//   - usage_events rows finalize() writes (or fails to write)
//   - the operator unit_micro_usd override versus the catalog fallback
//
// WHAT IT CANNOT OBSERVE
//   - a live Flux / OpenAI / CF upstream. AI.run is a test stub. No socket
//     is opened to Cloudflare, and no money is spent.
//   - hibernatable WebSocket close driving finalize() through workerd's
//     hibernation API. The stub can return a WebSocketPair so fetch()
//     reaches 101, but close-to-finalize is asserted by calling finalize()
//     inside runInDurableObject, not by hoping hibernation delivers
//     webSocketClose in-process.
//   - the Worker upgrade door's pre-flight (auth, balance, rate limit).
//     Those stay in the node suite (tests/stt-tickets.test.ts). This file
//     is the DO.
//
// PRE-FIX BEHAVIOUR THESE ASSERTIONS GO RED AGAINST
//   - fetch() called env.AI.run with gateway: { id } and no metadata, so
//     every live-voice gateway row landed in skipped: no_request_id
//   - finalize() on revoke / suspend / mismatch / missing-plan / not-entitled
//     did `console.error` and `return`, writing no usage row
//   - resolveUnitPrice(entry, null) ignored the operator override
//
// Precedent: prism bound STT_SESSION as a real SQLite DO so the live-voice
// path became reachable. The same binding shape is in vitest.workers.config.ts.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mintClientKey } from "../src/auth";
import { FLUX_DEFAULT_UNIT_MICRO, FLUX_STT_MODEL, SttSession } from "../src/stt-session";
import { signSttHandoff, STT_HANDOFF_TTL_SEC } from "../src/stt-handoff";
import { decideAdjustment } from "../src/reconcile";
import { logRow } from "../tests/fake-gateway-logs";

const HANDOFF_SECRET = "test-cf-aig-token-not-real";
const GATEWAY_ID = "prism-proxy";

interface Seed {
  accountId: string;
  clientId: string;
  planId: string;
  requestId: string;
}

interface SeedOpts {
  accountId?: string;
  planId?: string;
  revoked?: boolean;
  suspended?: boolean;
  allowedTiers?: string;
  unusablePlan?: boolean;
  unitMicroUsd?: number;
  extraAccountId?: string;
}

interface FluxRunOpts {
  websocket?: boolean;
  gateway?: { id: string; metadata?: Record<string, string> };
}

interface CapturedRun {
  model: string;
  input: unknown;
  opts: FluxRunOpts;
}

type SttInternals = {
  finalize: () => Promise<void>;
};

function requireSession(): DurableObjectNamespace {
  const ns = env.STT_SESSION;
  if (!ns) throw new Error("STT_SESSION binding missing; workers config is wrong");
  return ns;
}

function installFakeFlux(options: { logId?: string | null; returnSocket?: boolean } = {}): {
  calls: CapturedRun[];
} {
  const calls: CapturedRun[] = [];
  const ai = env.AI as Record<string, unknown>;
  if (!ai || typeof ai !== "object") {
    throw new Error("AI binding missing; workers config is wrong");
  }
  ai.aiGatewayLogId = options.logId ?? null;
  ai.run = async (model: string, input: unknown, opts: FluxRunOpts) => {
    calls.push({ model, input, opts });
    if (options.returnSocket) {
      const pair = new WebSocketPair();
      pair[0].accept();
      return { webSocket: pair[1] };
    }
    return { webSocket: null };
  };
  return { calls };
}

async function seed(opts: SeedOpts = {}): Promise<Seed> {
  const planId = opts.planId ?? "dev";
  const accountId = opts.accountId ?? "acct_stt_1";
  const minted = await mintClientKey();

  if (planId !== "dev") {
    const maxOut = opts.unusablePlan ? 0 : 8192;
    const tiers = opts.allowedTiers ?? "standard,premium";
    await env.DB.prepare(
      `INSERT INTO plans
         (id, name, signup_credit_micro_usd, monthly_included_micro_usd,
          requests_per_minute, max_output_tokens, allowed_tiers)
       VALUES (?, ?, 0, 0, 20, ?, ?)`,
    )
      .bind(planId, `plan ${planId}`, maxOut, tiers)
      .run();
  } else if (opts.allowedTiers || opts.unusablePlan) {
    throw new Error("do not mutate the seeded dev plan; insert a dedicated plan");
  }

  await env.DB.prepare(
    `INSERT INTO accounts (id, plan_id, label, credit_micro_usd, suspended_at)
     VALUES (?, ?, NULL, 1000000, ?)`,
  )
    .bind(accountId, planId, opts.suspended ? "2026-08-07T00:00:00.000Z" : null)
    .run();
  await env.DB.prepare(
    `INSERT INTO credit_grants (id, account_id, micro_usd, idempotency_key, note)
     VALUES (?, ?, 1000000, ?, 'test opening grant')`,
  )
    .bind(`grant_${accountId}`, accountId, `signup:${accountId}`)
    .run();

  if (opts.extraAccountId) {
    await env.DB.prepare(
      `INSERT INTO accounts (id, plan_id, label, credit_micro_usd)
       VALUES (?, ?, NULL, 1000000)`,
    )
      .bind(opts.extraAccountId, planId)
      .run();
    await env.DB.prepare(
      `INSERT INTO credit_grants (id, account_id, micro_usd, idempotency_key, note)
       VALUES (?, ?, 1000000, ?, 'extra account')`,
    )
      .bind(`grant_${opts.extraAccountId}`, opts.extraAccountId, `signup:${opts.extraAccountId}`)
      .run();
  }

  const clientAccount = opts.extraAccountId ?? accountId;
  await env.DB.prepare(
    `INSERT INTO clients (id, account_id, key_id, secret_hash, label, platform, revoked_at)
     VALUES (?, ?, ?, ?, 'device', 'ios', ?)`,
  )
    .bind(
      minted.clientId,
      clientAccount,
      minted.keyId,
      minted.secretHash,
      opts.revoked ? "2026-08-07T00:00:00.000Z" : null,
    )
    .run();

  if (opts.unitMicroUsd !== undefined) {
    await env.DB.prepare(
      `INSERT INTO model_prices
         (model_id, input_micro_usd_per_mtok, output_micro_usd_per_mtok, unit_micro_usd, priced_at, note)
       VALUES (?, 0, 0, ?, '2026-08-07T00:00:00.000Z', 'operator override')`,
    )
      .bind(FLUX_STT_MODEL, opts.unitMicroUsd)
      .run();
  }

  return {
    accountId,
    clientId: minted.clientId,
    planId,
    requestId: `req_${minted.clientId.slice(0, 16)}`,
  };
}

async function signedFetch(
  stub: DurableObjectStub,
  seedRow: Seed,
  extra: { modelId?: string } = {},
): Promise<Response> {
  const modelId = extra.modelId ?? FLUX_STT_MODEL;
  const exp = Math.floor(Date.now() / 1000) + STT_HANDOFF_TTL_SEC;
  const sig = await signSttHandoff(HANDOFF_SECRET, {
    accountId: seedRow.accountId,
    clientId: seedRow.clientId,
    planId: seedRow.planId,
    requestId: seedRow.requestId,
    modelId,
    exp,
  });
  return stub.fetch(
    new Request("https://play-proxy.skyphusion.org/v1/stt/stream", {
      headers: {
        Upgrade: "websocket",
        "x-prism-account-id": seedRow.accountId,
        "x-prism-client-id": seedRow.clientId,
        "x-prism-plan-id": seedRow.planId,
        "x-prism-request-id": seedRow.requestId,
        "x-prism-model-id": modelId,
        "x-prism-exp": String(exp),
        "x-prism-sig": sig,
      },
    }),
  );
}

async function callFinalize(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub as DurableObjectStub<SttSession>, async (instance) => {
    await (instance as unknown as SttInternals).finalize();
  });
}

async function readMeta(stub: DurableObjectStub): Promise<Map<string, string>> {
  return runInDurableObject(stub as DurableObjectStub<SttSession>, async (_instance, state) => {
    const rows = state.storage.sql.exec<{ k: string; v: string }>(`SELECT k, v FROM meta`).toArray();
    return new Map(rows.map((r) => [r.k, r.v]));
  });
}

async function usageByRequest(requestId: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(
    `SELECT request_id, account_id, client_id, model_id, micro_usd,
            from_allowance_micro_usd, from_credit_micro_usd, metered,
            unmetered_reason, gateway_log_id, upstream_status
       FROM usage_events WHERE request_id = ?`,
  )
    .bind(requestId)
    .first<Record<string, unknown>>();
}

beforeEach(async () => {
  // Isolated storage should start empty, but the suite still owns its
  // leftover rows if isolation is ever off. Wipe the tables this file writes.
  for (const table of [
    "usage_events",
    "usage_periods",
    "clients",
    "credit_grants",
    "accounts",
    "model_prices",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(`DELETE FROM plans WHERE id != 'dev'`).run();
});

describe("STT DO: gateway metadata at the AI.run call site", () => {
  it("attaches the four fields decideAdjustment joins on, and not a fabricated fifth", async () => {
    // PRE-FIX: opts.gateway was { id } only. decideAdjustment then skipped
    // every live-voice row as no_request_id -- "sent by something else".
    const seeded = await seed();
    const { calls } = installFakeFlux({ logId: "aig_test_log_1" });
    const stub = requireSession().get(requireSession().newUniqueId());

    const res = await signedFetch(stub, seeded);
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe(FLUX_STT_MODEL);
    expect(calls[0]!.opts.websocket).toBe(true);
    expect(calls[0]!.opts.gateway).toEqual({
      id: GATEWAY_ID,
      metadata: {
        account_id: seeded.accountId,
        client_id: seeded.clientId,
        plan_id: seeded.planId,
        request_id: seeded.requestId,
      },
    });

    const meta = await readMeta(stub);
    expect(meta.get("request_id")).toBe(seeded.requestId);
    expect(meta.get("gateway_log_id")).toBe("aig_test_log_1");

    // The join contract reconcile-run.ts consumes: a gateway row carrying
    // this request_id is attributable. A missing request_id is the skip.
    const withId = decideAdjustment(
      logRow({
        id: "aig_test_log_1",
        createdAt: "2026-08-07T12:00:00.000Z",
        requestId: calls[0]!.opts.gateway!.metadata!.request_id,
        accountId: calls[0]!.opts.gateway!.metadata!.account_id,
        costMicroUsd: 7700,
      }),
      null,
    );
    expect(withId.outcome).toBe("skipped");
    if (withId.outcome === "skipped") {
      expect(withId.reason).toBe("no_ledger_row");
    }

    const withoutId = decideAdjustment(
      logRow({
        id: "aig_orphan",
        createdAt: "2026-08-07T12:00:00.000Z",
        requestId: null,
        costMicroUsd: 7700,
      }),
      null,
    );
    expect(withoutId.outcome).toBe("skipped");
    if (withoutId.outcome === "skipped") {
      expect(withoutId.reason).toBe("no_request_id");
    }
  });

  it("does not invent a gateway_log_id when the binding did not surface one", async () => {
    const seeded = await seed();
    installFakeFlux({ logId: null });
    const stub = requireSession().get(requireSession().newUniqueId());
    await signedFetch(stub, seeded);
    const meta = await readMeta(stub);
    expect(meta.has("gateway_log_id")).toBe(false);
  });
});

describe("STT DO: finalize writes a usage row (red against a bare return)", () => {
  it("records a metered row at the catalog rate when the session is still owned", async () => {
    const seeded = await seed();
    installFakeFlux({ logId: "aig_ok" });
    const stub = requireSession().get(requireSession().newUniqueId());
    await signedFetch(stub, seeded);
    await callFinalize(stub);

    const row = await usageByRequest(seeded.requestId);
    expect(row).not.toBeNull();
    expect(row!.metered).toBe(1);
    expect(row!.micro_usd).toBe(FLUX_DEFAULT_UNIT_MICRO);
    expect(row!.from_allowance_micro_usd).toBe(0);
    expect(row!.from_credit_micro_usd).toBe(FLUX_DEFAULT_UNIT_MICRO);
    expect(row!.unmetered_reason).toBeNull();
    expect(row!.gateway_log_id).toBe("aig_ok");
    expect(row!.account_id).toBe(seeded.accountId);
    expect(row!.client_id).toBe(seeded.clientId);
    expect(row!.model_id).toBe(FLUX_STT_MODEL);
    expect(row!.upstream_status).toBe(101);
    expect(
      (row!.from_allowance_micro_usd as number) + (row!.from_credit_micro_usd as number),
    ).toBe(row!.micro_usd);
  });

  it("uses the operator unit_micro_usd, not the catalog fallback", async () => {
    // PRE-FIX: resolveUnitPrice(entry, null) charged 7700 after the gate
    // had already required the operator's 15000 of headroom.
    const seeded = await seed({ unitMicroUsd: 15_000 });
    installFakeFlux();
    const stub = requireSession().get(requireSession().newUniqueId());
    await signedFetch(stub, seeded);
    await callFinalize(stub);

    const row = await usageByRequest(seeded.requestId);
    expect(row).not.toBeNull();
    expect(row!.metered).toBe(1);
    expect(row!.micro_usd).toBe(15_000);
    expect(row!.micro_usd).not.toBe(FLUX_DEFAULT_UNIT_MICRO);
  });

  it("records an unmetered row when the client was revoked before close", async () => {
    // PRE-FIX: console.error + return. The session happened, cost us
    // upstream, and left no ledger row -- the user an operator just
    // revoked is exactly the user you want a record of.
    const seeded = await seed();
    installFakeFlux();
    const stub = requireSession().get(requireSession().newUniqueId());
    await signedFetch(stub, seeded);
    await env.DB.prepare(`UPDATE clients SET revoked_at = datetime('now') WHERE id = ?`)
      .bind(seeded.clientId)
      .run();
    await callFinalize(stub);

    const row = await usageByRequest(seeded.requestId);
    expect(row, "pre-fix finalize returned without writing").not.toBeNull();
    expect(row!.metered).toBe(0);
    expect(row!.micro_usd).toBe(0);
    expect(String(row!.unmetered_reason)).toMatch(/revoked/);
    expect(row!.account_id).toBe(seeded.accountId);
  });

  it("records an unmetered row when the account was suspended before close", async () => {
    const seeded = await seed();
    installFakeFlux();
    const stub = requireSession().get(requireSession().newUniqueId());
    await signedFetch(stub, seeded);
    await env.DB.prepare(`UPDATE accounts SET suspended_at = datetime('now') WHERE id = ?`)
      .bind(seeded.accountId)
      .run();
    await callFinalize(stub);

    const row = await usageByRequest(seeded.requestId);
    expect(row, "pre-fix finalize returned without writing").not.toBeNull();
    expect(row!.metered).toBe(0);
    expect(String(row!.unmetered_reason)).toMatch(/suspended/);
  });

  it("records an unmetered row when the plan no longer exists", async () => {
    const seeded = await seed({ planId: "gone-later" });
    installFakeFlux();
    const stub = requireSession().get(requireSession().newUniqueId());
    await signedFetch(stub, seeded);
    // Keep the account row (FK); drop only the plan finalize re-reads.
    await env.DB.prepare(`UPDATE accounts SET plan_id = 'dev' WHERE id = ?`)
      .bind(seeded.accountId)
      .run();
    await env.DB.prepare(`DELETE FROM plans WHERE id = ?`).bind("gone-later").run();
    await callFinalize(stub);

    const row = await usageByRequest(seeded.requestId);
    expect(row, "pre-fix finalize returned without writing").not.toBeNull();
    expect(row!.metered).toBe(0);
    expect(String(row!.unmetered_reason)).toMatch(/no longer exists/);
  });

  it("records an unmetered row when the plan is unusable", async () => {
    const seeded = await seed({ planId: "broken", unusablePlan: true });
    installFakeFlux();
    const stub = requireSession().get(requireSession().newUniqueId());
    await signedFetch(stub, seeded);
    await callFinalize(stub);

    const row = await usageByRequest(seeded.requestId);
    expect(row, "pre-fix finalize returned without writing").not.toBeNull();
    expect(row!.metered).toBe(0);
    expect(String(row!.unmetered_reason)).toMatch(/unusable/);
  });

  it("records an unmetered row when the model is no longer entitled", async () => {
    const seeded = await seed({ planId: "premium-only", allowedTiers: "premium" });
    installFakeFlux();
    const stub = requireSession().get(requireSession().newUniqueId());
    await signedFetch(stub, seeded);
    await callFinalize(stub);

    const row = await usageByRequest(seeded.requestId);
    expect(row, "pre-fix finalize returned without writing").not.toBeNull();
    expect(row!.metered).toBe(0);
    expect(String(row!.unmetered_reason)).toMatch(/no longer entitled/);
  });

  it("records an unmetered row on client/account mismatch, attributed to the client's account", async () => {
    const seeded = await seed({ extraAccountId: "acct_other" });
    installFakeFlux();
    const stub = requireSession().get(requireSession().newUniqueId());
    // signedFetch tags the session as acct_stt_1; the client belongs to acct_other.
    await signedFetch(stub, seeded);
    await callFinalize(stub);

    const row = await usageByRequest(seeded.requestId);
    expect(row, "pre-fix finalize returned without writing").not.toBeNull();
    expect(row!.metered).toBe(0);
    expect(row!.account_id).toBe("acct_other");
    expect(String(row!.unmetered_reason)).toMatch(/mismatch/);
  });

  it("still discards when the client row is gone (schema: usage_events.client_id is an FK)", async () => {
    const seeded = await seed();
    installFakeFlux();
    const stub = requireSession().get(requireSession().newUniqueId());
    await signedFetch(stub, seeded);
    await env.DB.prepare(`DELETE FROM clients WHERE id = ?`).bind(seeded.clientId).run();
    await callFinalize(stub);

    const row = await usageByRequest(seeded.requestId);
    expect(row).toBeNull();
  });

  it("is idempotent: a second finalize does not write a second row", async () => {
    const seeded = await seed();
    installFakeFlux();
    const stub = requireSession().get(requireSession().newUniqueId());
    await signedFetch(stub, seeded);
    await callFinalize(stub);
    await callFinalize(stub);
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM usage_events WHERE request_id = ?`,
    )
      .bind(seeded.requestId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe("STT DO: fetch reaches the stubbed upstream open", () => {
  it("returns 101 when the stub hands back a WebSocketPair (no live Flux)", async () => {
    const seeded = await seed();
    const { calls } = installFakeFlux({ returnSocket: true });
    const stub = requireSession().get(requireSession().newUniqueId());
    const res = await signedFetch(stub, seeded);
    expect(res.status).toBe(101);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.gateway?.metadata?.request_id).toBe(seeded.requestId);
    // Close-to-finalize through hibernation is the untested remainder.
    // Drive the meter the same way the close handler does.
    await callFinalize(stub);
    expect(await usageByRequest(seeded.requestId)).not.toBeNull();
  });
});
