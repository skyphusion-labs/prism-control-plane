// Liveness and readiness.
//
// TWO PROBES, because they answer different questions and a monitor needs both:
//
//   /health       is this Worker running? Touches NO binding, so it stays green while D1 is down and is
//                 therefore a usable signal that the deploy itself is alive.
//   /health/deep  can this Worker actually serve? Reads D1, checks the schema is applied, and checks that
//                 both halves of the spend path (a gateway to route through, a way to mint per-user
//                 credentials) are wired. Answers 503 when it cannot.
//
// A GREEN GATE THAT CANNOT GO RED IS NOT A GATE. That is why /health/deep returns 503 on failure rather
// than 200 with an `ok: false` body: a monitor watching status codes must be able to see this fail.

import { CATALOG } from "../catalog";
import { credentialMode, gatewayConfig } from "../env";
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

  // Chat models that no rate can price yet.
  //
  // REPORTED, NOT FAILED, and that is a change from the earlier posture. When the catalog held three
  // Workers AI models an unpriced entry meant a mistake. It now holds every model prism offers, and
  // Cloudflare publishes no per-token rate for third-party Unified Billing models at all, so unpriced is
  // the EXPECTED state for a large part of the catalog. Failing readiness over it would mean this plane is
  // permanently unhealthy for a reason nobody can fix from here. The door still refuses each one
  // individually (model_unpriced), which is where that gate belongs.
  const chat = CATALOG.filter((entry) => entry.modality === "chat");
  const unpriced = chat.filter((entry) => entry.price === null);
  checks.push({
    name: "catalog_pricing",
    ok: true,
    detail:
      `${CATALOG.length} models, ${chat.length} chat, ${chat.length - unpriced.length} priced from ` +
      `Cloudflare; ${unpriced.length} awaiting an operator rate (POST /admin/model-prices)`,
  });

  // A missing gateway is reported as NOT ok, because with no gateway the only paid route is closed. The
  // plane is technically up and honestly unable to do its job, and readiness is about the latter.
  const gateway = gatewayConfig(ctx.env);
  checks.push({
    name: "ai_gateway",
    ok: gateway !== null,
    detail: gateway
      ? `gateway ${gateway.id}, collectLog=${gateway.collectLog}`
      : "CF_ACCOUNT_ID or AI_GATEWAY_ID is unset, so POST /v1/chat/completions refuses rather than calling off-gateway",
  });

  // The credential path, reported SEPARATELY from the gateway. Both closing the door with the same 503 is
  // correct behaviour and useless diagnostics: this check is what turns "inference is down" into "which
  // secret is missing", and it names the CONFIGURED mode so a deploy that silently landed in the wrong one
  // is visible without reading the Worker's secrets.
  const mode = credentialMode(ctx.env);
  checks.push({
    name: "upstream_credential",
    ok: ctx.credentials !== null,
    detail: ctx.credentials
      ? mode === "shared"
        ? "shared account credential configured; per-user attribution rides on cf-aig-metadata and the ledger"
        : "per-user tokens can be minted, stored encrypted, and are inside the configured budget"
      : mode === "shared"
        ? "CF_AIG_TOKEN is unset, so inference is closed"
        : "PCP_CF_API_TOKEN, USER_TOKEN_KEK, or USER_TOKEN_BUDGET is unset, so inference is closed",
  });

  const ok = checks.every((check) => check.ok);
  return jsonResponse(
    ctx.requestId,
    { ok, service: SERVICE_NAME, checks },
    { status: ok ? 200 : 503 },
  );
}
