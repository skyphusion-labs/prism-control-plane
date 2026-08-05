// Liveness and readiness.
//
// TWO PROBES, because they answer different questions and a monitor needs both:
//
//   /health       is this Worker running? Touches NO binding, so it stays green while D1 is down and is
//                 therefore a usable signal that the deploy itself is alive.
//   /health/deep  can this Worker actually serve? Reads D1, checks the schema is applied, and checks the
//                 catalog is priced. Answers 503 when it cannot.
//
// A GREEN GATE THAT CANNOT GO RED IS NOT A GATE. That is why /health/deep returns 503 on failure rather
// than 200 with an `ok: false` body: a monitor watching status codes must be able to see this fail.

import { CATALOG } from "../catalog";
import { gatewayConfig } from "../env";
import { jsonResponse } from "../http";
import type { Ctx } from "./shared";

export const SERVICE_NAME = "prism-control-plane";

export function handleHealth(ctx: Ctx): Response {
  return jsonResponse(ctx.requestId, { ok: true, service: SERVICE_NAME });
}

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function handleDeepHealth(ctx: Ctx): Promise<Response> {
  const checks: Check[] = [];

  try {
    await ctx.store.probeSchema();
    checks.push({ name: "d1_schema", ok: true });
  } catch (err) {
    checks.push({
      name: "d1_schema",
      ok: false,
      detail: String(err instanceof Error ? err.message : err).slice(0, 200),
    });
  }

  // Every catalog entry must carry a usable price. An unpriced entry is a spendable model with an
  // unmeterable bill, so it is a readiness failure rather than a warning.
  const unpriced = CATALOG.filter(
    (entry) =>
      !Number.isInteger(entry.price.inputMicroUsdPerMTok) ||
      !Number.isInteger(entry.price.outputMicroUsdPerMTok) ||
      !entry.price.pricedAt,
  );
  checks.push({
    name: "catalog_priced",
    ok: unpriced.length === 0,
    detail: unpriced.length ? `unpriced: ${unpriced.map((e) => e.id).join(", ")}` : `${CATALOG.length} entries`,
  });

  // A missing gateway is reported as NOT ok, because with no gateway the only paid route is closed. The
  // plane is technically up and honestly unable to do its job, and readiness is about the latter.
  const gateway = gatewayConfig(ctx.env);
  checks.push({
    name: "ai_gateway",
    ok: gateway !== null,
    detail: gateway
      ? `gateway ${gateway.id}, collectLog=${gateway.collectLog}`
      : "AI_GATEWAY_ID is unset, so POST /v1/chat/completions refuses rather than calling off-gateway",
  });

  const ok = checks.every((check) => check.ok);
  return jsonResponse(
    ctx.requestId,
    { ok, service: SERVICE_NAME, checks },
    { status: ok ? 200 : 503 },
  );
}
