// WebSocket upgrade for live voice STT (Deepgram Flux).
//
// Auth + entitlement happen here; the Durable Object only bridges sockets and meters on close.
// Clients may send the client key as Authorization: Bearer, or as ?access_token= for stacks that
// cannot set upgrade headers (some browsers). Prefer Authorization on native clients.

import { bearerFromRequest, parseClientKey, resolveClient } from "../auth";
import { decideBalance, remainingAllowanceMicroUsd, remainingMicroUsd } from "../balance";
import { findModel } from "../catalog";
import { newId } from "../crypto";
import { errorResponse } from "../http";
import { resolveUnitPrice } from "../meter";
import { periodBounds } from "../period";
import { entitlesTier, planFromRow } from "../plans";
import { checkRateLimit, inferenceBucket } from "../rate-limit";
import { FLUX_STT_MODEL, STT_WS_PROTOCOL } from "../flux-stt";
import { signSttHandoff, STT_HANDOFF_TTL_SEC } from "../stt-handoff";
import type { Ctx } from "./shared";

export { STT_WS_PROTOCOL };

export function isSttStreamUpgrade(request: Request, path: string): boolean {
  return (
    path === "/v1/stt/stream" &&
    request.method === "GET" &&
    request.headers.get("Upgrade")?.toLowerCase() === "websocket"
  );
}

/**
 * Extract the client key without putting it in the URL.
 *
 * Order: Authorization Bearer (preferred, native clients) → Sec-WebSocket-Protocol
 * `prism.v1, <key>` (browsers cannot set Authorization on WebSocket).
 *
 * Query-string tokens are deliberately NOT accepted: access_token in the URL is
 * logged by proxies, CDNs, and browser history (adversarial-audit high on PR #22).
 *
 * Any candidate is run through parseClientKey so junk `pcp_…` strings never reach D1.
 */
export function bearerFromSttUpgrade(request: Request): {
  bearer: string | null;
  /** When auth came from Sec-WebSocket-Protocol, echo this on the 101 response. */
  acceptProtocol: string | null;
} {
  const headerBearer = bearerFromRequest(request);
  if (headerBearer) {
    return {
      bearer: parseClientKey(headerBearer) ? headerBearer : null,
      acceptProtocol: null,
    };
  }

  const proto = request.headers.get("sec-websocket-protocol");
  if (!proto) return { bearer: null, acceptProtocol: null };
  const parts = proto.split(",").map((p) => p.trim()).filter(Boolean);
  // new WebSocket(url, ["prism.v1", clientKey])
  if (parts[0] === STT_WS_PROTOCOL && parts[1] && parseClientKey(parts[1])) {
    return { bearer: parts[1], acceptProtocol: STT_WS_PROTOCOL };
  }
  return { bearer: null, acceptProtocol: null };
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

  const { bearer, acceptProtocol } = bearerFromSttUpgrade(request);
  if (!bearer) {
    return errorResponse(
      ctx.requestId,
      "unauthenticated",
      "A valid client key is required: Authorization: Bearer pcp_… " +
        `or Sec-WebSocket-Protocol: ${STT_WS_PROTOCOL}, <key>. Query tokens are not accepted.`,
    );
  }
  const authHeaders = new Headers(request.headers);
  authHeaders.set("authorization", `Bearer ${bearer}`);
  // Do not forward Sec-WebSocket-Protocol list with the secret to resolveClient; only Authorization.
  authHeaders.delete("sec-websocket-protocol");
  const authRequest = new Request(request.url, { method: request.method, headers: authHeaders });

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
            : "A valid client key is required (Authorization Bearer or Sec-WebSocket-Protocol).",
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
  const handoffSecret = (ctx.env.CF_AIG_TOKEN ?? "").trim();
  if (!handoffSecret) {
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "CF_AIG_TOKEN is required to sign the STT session handoff.",
    );
  }

  const exp = Math.floor(ctx.now.getTime() / 1000) + STT_HANDOFF_TTL_SEC;
  const handoff = {
    accountId: account.id,
    clientId: client.id,
    planId: account.plan_id,
    requestId,
    modelId: FLUX_STT_MODEL,
    exp,
  };
  const sig = await signSttHandoff(handoffSecret, handoff);

  // Attribution + HMAC. Unit rate is resolved inside the DO from the catalog, not from headers.
  const headers = new Headers();
  headers.set("upgrade", "websocket");
  headers.set("x-prism-account-id", handoff.accountId);
  headers.set("x-prism-client-id", handoff.clientId);
  headers.set("x-prism-plan-id", handoff.planId);
  headers.set("x-prism-request-id", handoff.requestId);
  headers.set("x-prism-model-id", handoff.modelId);
  headers.set("x-prism-exp", String(handoff.exp));
  headers.set("x-prism-sig", sig);
  if (acceptProtocol) {
    headers.set("x-prism-ws-protocol", acceptProtocol);
  }

  const stub = ctx.env.STT_SESSION.get(ctx.env.STT_SESSION.newUniqueId());
  return stub.fetch(
    new Request(request.url, {
      method: request.method,
      headers,
    }),
  );
}
