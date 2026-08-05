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
import { gatewayConfig, perUserModeRequested } from "../env";
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
  const unpricedChat = chat.filter((entry) => entry.price === null);
  const nonChat = CATALOG.filter((entry) => entry.modality !== "chat");
  const unitPriced = nonChat.filter((entry) => entry.unitPrice !== null);
  checks.push({
    name: "catalog_pricing",
    ok: true,
    detail:
      `${CATALOG.length} models, ${chat.length} chat (${chat.length - unpricedChat.length} token-priced), ` +
      `${nonChat.length} non-chat doors (${unitPriced.length} unit-priced); ` +
      `${unpricedChat.length + (nonChat.length - unitPriced.length)} awaiting operator rate`,
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

  // The credential path, reported SEPARATELY from the gateway. Product is one shared CF_AIG_TOKEN for
  // every account (Cloudflare's 500-token ceiling rules out minting one per Prism account). Attribution is
  // cf-aig-metadata + the D1 ledger. A leftover UPSTREAM_CREDENTIAL_MODE=per-user is a misdeploy and closes
  // the door rather than minting.
  checks.push({
    name: "upstream_credential",
    ok: ctx.credentials !== null,
    detail: ctx.credentials
      ? "shared CF_AIG_TOKEN configured; per-account attribution is cf-aig-metadata + the D1 ledger"
      : perUserModeRequested(ctx.env)
        ? "UPSTREAM_CREDENTIAL_MODE=per-user is retired (500-token account ceiling); unset it and use CF_AIG_TOKEN"
        : "CF_AIG_TOKEN is unset, so inference is closed",
  });

  const ok = checks.every((check) => check.ok);
  return jsonResponse(
    ctx.requestId,
    { ok, service: SERVICE_NAME, checks },
    { status: ok ? 200 : 503 },
  );
}
