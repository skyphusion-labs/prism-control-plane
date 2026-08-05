// WebSocket upgrade for live voice STT (Deepgram Flux).
//
// Auth + entitlement happen here; the Durable Object only bridges sockets and meters on close.
// Clients may send the client key as Authorization: Bearer, or as ?access_token= for stacks that
// cannot set upgrade headers (some browsers). Prefer Authorization on native clients.

import { resolveClient } from "../auth";
import { decideBalance, remainingAllowanceMicroUsd, remainingMicroUsd } from "../balance";
import { findModel } from "../catalog";
import { newId } from "../crypto";
import { errorResponse } from "../http";
import { resolveUnitPrice } from "../meter";
import { periodBounds } from "../period";
import { entitlesTier, planFromRow } from "../plans";
import { checkRateLimit, inferenceBucket } from "../rate-limit";
import { FLUX_DEFAULT_UNIT_MICRO, FLUX_STT_MODEL } from "../flux-stt";
import type { Ctx } from "./shared";

export function isSttStreamUpgrade(request: Request, path: string): boolean {
  return (
    path === "/v1/stt/stream" &&
    request.method === "GET" &&
    request.headers.get("Upgrade")?.toLowerCase() === "websocket"
  );
}

/**
 * Authenticate, gate, and forward the upgrade to a fresh SttSession DO.
 */
export async function handleSttStreamUpgrade(ctx: Ctx, request: Request): Promise<Response> {
  if (!ctx.env.STT_SESSION) {
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "STT stream is not configured on this deployment (missing STT_SESSION Durable Object binding).",
    );
  }
  if (!ctx.env.AI) {
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "Deepgram Flux requires the Worker AI binding. Add [ai] binding = \"AI\" to wrangler config.",
    );
  }

  // Bearer header, or access_token query (WebSocket clients that cannot set Authorization).
  let authRequest = request;
  if (!request.headers.get("authorization")) {
    const url = new URL(request.url);
    const token = url.searchParams.get("access_token") ?? url.searchParams.get("key");
    if (token) {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${token}`);
      authRequest = new Request(request.url, { method: request.method, headers });
    }
  }

  const resolved = await resolveClient(ctx.store, authRequest);
  if (!resolved.ok) {
    const map = {
      unauthenticated: "unauthenticated" as const,
      revoked: "client_revoked" as const,
      suspended: "forbidden" as const,
      misconfigured: "unavailable" as const,
    };
    return errorResponse(
      ctx.requestId,
      map[resolved.failure],
      resolved.failure === "revoked"
        ? "This client key has been revoked."
        : resolved.failure === "suspended"
          ? "This account is suspended."
          : resolved.failure === "misconfigured"
            ? "Account or plan is misconfigured."
            : "A valid client key is required (Authorization Bearer or access_token query).",
    );
  }

  const { client, account, plan: planRow } = resolved.caller;
  const planResult = planFromRow(planRow);
  if (!planResult.ok) {
    return errorResponse(ctx.requestId, "unavailable", planResult.reason);
  }
  const plan = planResult.plan;

  const model = findModel(FLUX_STT_MODEL);
  if (!model) {
    return errorResponse(ctx.requestId, "model_not_found", `Model "${FLUX_STT_MODEL}" is not in the catalog.`);
  }
  if (!entitlesTier(plan, model.tier)) {
    return errorResponse(
      ctx.requestId,
      "model_not_entitled",
      `Plan "${plan.id}" does not include ${model.tier}-tier models.`,
    );
  }

  const priceRow = await ctx.store.getModelPrice(model.id);
  const unitPrice = resolveUnitPrice(model, priceRow);
  if (!unitPrice) {
    return errorResponse(
      ctx.requestId,
      "model_unpriced",
      `Model "${model.id}" has no unit rate. Set unit_micro_usd via POST /admin/model-prices.`,
    );
  }

  const rate = await checkRateLimit(ctx.store, inferenceBucket(account.id), plan.requestsPerMinute);
  if (!rate.allowed) {
    return errorResponse(
      ctx.requestId,
      "rate_limited",
      `Plan allows ${plan.requestsPerMinute} requests per minute.`,
      {},
      { "retry-after": String(rate.retryAfterSeconds) },
    );
  }

  const bounds = periodBounds(ctx.now);
  const periodBefore = await ctx.store.getPeriod(account.id, bounds.key);
  const balance = decideBalance({
    creditMicroUsd: account.credit_micro_usd,
    spentMicroUsd: account.spent_micro_usd,
    monthlyIncludedMicroUsd: plan.monthlyIncludedMicroUsd,
    allowanceSpentMicroUsd: periodBefore?.allowance_spent_micro_usd ?? 0,
  });
  if (balance.outcome === "exhausted") {
    return errorResponse(
      ctx.requestId,
      "quota_exhausted",
      "No remaining monthly allowance or prepaid credit for a voice session.",
      { period: bounds.key, resets_at: bounds.end },
    );
  }
  if (balance.outcome === "indeterminate") {
    return errorResponse(ctx.requestId, "unavailable", "Account balance cannot be read reliably.");
  }

  // Pre-flight: at least one audio minute of unit rate must fit (zero rate always ok).
  const minCharge = unitPrice.microUsdPerUnit > 0 ? unitPrice.microUsdPerUnit : 0;
  if (minCharge > 0) {
    const remaining =
      remainingAllowanceMicroUsd({
        monthlyIncludedMicroUsd: plan.monthlyIncludedMicroUsd,
        allowanceSpentMicroUsd: periodBefore?.allowance_spent_micro_usd ?? 0,
      }) +
      remainingMicroUsd({
        creditMicroUsd: account.credit_micro_usd,
        spentMicroUsd: account.spent_micro_usd,
      });
    if (remaining < minCharge) {
      return errorResponse(
        ctx.requestId,
        "quota_exhausted",
        `Remaining balance ${remaining} micro-USD is below one audio minute (${minCharge}).`,
        { period: bounds.key },
      );
    }
  }

  const requestId = ctx.requestId || newId("req");
  const headers = new Headers(request.headers);
  headers.set("x-prism-account-id", account.id);
  headers.set("x-prism-client-id", client.id);
  headers.set("x-prism-plan-id", account.plan_id);
  headers.set("x-prism-request-id", requestId);
  headers.set(
    "x-prism-unit-micro-usd",
    String(unitPrice.microUsdPerUnit >= 0 ? unitPrice.microUsdPerUnit : FLUX_DEFAULT_UNIT_MICRO),
  );

  const stub = ctx.env.STT_SESSION.get(ctx.env.STT_SESSION.newUniqueId());
  return stub.fetch(
    new Request(request.url, {
      method: request.method,
      headers,
      // body unused on WS upgrade
    }),
  );
}
