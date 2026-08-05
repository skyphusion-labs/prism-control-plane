// WebSocket upgrade for live voice STT (Deepgram Flux) + short-lived session tickets.
//
// Auth happens here; the Durable Object only bridges sockets and meters on close.
//
// TWO paths (never put the long-lived client key in Sec-WebSocket-Protocol):
//
//   1. Native: Authorization: Bearer pcp_... on the upgrade (preferred).
//   2. Browser: POST /v1/stt/sessions with Bearer pcp_... → stt_ ticket,
//      then new WebSocket(url, ["prism.v1", ticket]). Protocol carries only the
//      single-use short-lived ticket; query tokens are rejected (proxy logs).

import { bearerFromRequest, parseClientKey, resolveClient, type Caller } from "../auth";
import { decideBalance, remainingAllowanceMicroUsd, remainingMicroUsd } from "../balance";
import { findModel } from "../catalog";
import { newId, randomSecret, sha256Hex } from "../crypto";
import {
  FLUX_STT_MODEL,
  STT_TICKET_PREFIX,
  STT_TICKET_TTL_SEC,
  STT_WS_PROTOCOL,
} from "../flux-stt";
import { errorResponse, jsonResponse } from "../http";
import { resolveUnitPrice } from "../meter";
import { periodBounds } from "../period";
import { entitlesTier, planFromRow } from "../plans";
import { checkRateLimit, inferenceBucket } from "../rate-limit";
import { requireHandoffSecret, signSttHandoff, STT_HANDOFF_TTL_SEC } from "../stt-handoff";
import { authFailureResponse, requireCaller, type Ctx } from "./shared";

export { STT_WS_PROTOCOL, STT_TICKET_PREFIX, STT_TICKET_TTL_SEC };

/** base64url secret length from crypto.randomSecret (256-bit → 43 chars). */
const STT_TICKET_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Parse a plaintext STT session ticket (`stt_<secret>`).
 * Shape-checked before any D1 work so junk never hits the store.
 */
export function parseSttTicket(raw: string): string | null {
  const first = raw.indexOf("_");
  if (first < 0 || raw.slice(0, first) !== STT_TICKET_PREFIX) return null;
  const secret = raw.slice(first + 1);
  if (!STT_TICKET_SECRET_RE.test(secret)) return null;
  return raw;
}

export function formatSttTicket(secret: string): string {
  return `${STT_TICKET_PREFIX}_${secret}`;
}

export function isSttStreamUpgrade(request: Request, path: string): boolean {
  return (
    path === "/v1/stt/stream" &&
    request.method === "GET" &&
    request.headers.get("Upgrade")?.toLowerCase() === "websocket"
  );
}

export type SttUpgradeAuth =
  | { kind: "client_key"; bearer: string; acceptProtocol: null }
  | { kind: "stt_ticket"; ticket: string; acceptProtocol: string }
  | { kind: null; bearer: null; acceptProtocol: null };

/**
 * Extract upgrade credentials without putting secrets in the URL.
 *
 * Order:
 *   1. Authorization Bearer with a well-formed pcp_ client key (native clients).
 *   2. Sec-WebSocket-Protocol: prism.v1, stt_<ticket> (browsers; ticket only, never pcp_).
 *
 * Query-string tokens are deliberately NOT accepted.
 * A pcp_ key in the protocol list is deliberately NOT accepted (that was the residual leak).
 */
export function authFromSttUpgrade(request: Request): SttUpgradeAuth {
  const headerBearer = bearerFromRequest(request);
  if (headerBearer) {
    if (parseClientKey(headerBearer)) {
      return { kind: "client_key", bearer: headerBearer, acceptProtocol: null };
    }
    // stt_ on Authorization is not the browser path; refuse rather than dual-path confuse.
    return { kind: null, bearer: null, acceptProtocol: null };
  }

  const proto = request.headers.get("sec-websocket-protocol");
  if (!proto) return { kind: null, bearer: null, acceptProtocol: null };
  const parts = proto.split(",").map((p) => p.trim()).filter(Boolean);
  // new WebSocket(url, ["prism.v1", sttTicket])
  if (parts[0] === STT_WS_PROTOCOL && parts[1] && parseSttTicket(parts[1])) {
    return {
      kind: "stt_ticket",
      ticket: parts[1],
      acceptProtocol: STT_WS_PROTOCOL,
    };
  }
  return { kind: null, bearer: null, acceptProtocol: null };
}

/**
 * @deprecated Prefer authFromSttUpgrade. Kept for tests that only care about Bearer pcp shape.
 * Protocol path no longer returns a pcp bearer.
 */
export function bearerFromSttUpgrade(request: Request): {
  bearer: string | null;
  acceptProtocol: string | null;
} {
  const auth = authFromSttUpgrade(request);
  if (auth.kind === "client_key") {
    return { bearer: auth.bearer, acceptProtocol: null };
  }
  if (auth.kind === "stt_ticket") {
    // Not a client key; callers that only understand pcp must not treat the ticket as one.
    return { bearer: null, acceptProtocol: auth.acceptProtocol };
  }
  return { bearer: null, acceptProtocol: null };
}

/**
 * POST /v1/stt/sessions
 *
 * Mint a single-use short-lived ticket for browser WebSocket auth.
 * Requires Authorization: Bearer pcp_... (the long-lived key stays on HTTPS POST only).
 */
export async function handleCreateSttSession(ctx: Ctx, request: Request): Promise<Response> {
  const authed = await requireCaller(ctx, request);
  if (!authed.ok) return authed.response;

  const { client, account } = authed.caller;
  const secret = randomSecret();
  const ticket = formatSttTicket(secret);
  const expiresAt = new Date(ctx.now.getTime() + STT_TICKET_TTL_SEC * 1000);

  await ctx.store.createSttTicket({
    token_hash: await sha256Hex(ticket),
    account_id: account.id,
    client_id: client.id,
    expires_at: expiresAt.toISOString(),
  });

  return jsonResponse(ctx.requestId, {
    ticket,
    expires_at: expiresAt.toISOString(),
    expires_in: STT_TICKET_TTL_SEC,
    protocol: STT_WS_PROTOCOL,
    // Client wiring hint: new WebSocket(wsUrl, [protocol, ticket])
    stream_path: "/v1/stt/stream",
  });
}

/**
 * Resolve the caller for a WebSocket upgrade: client key path or single-use ticket.
 */
async function resolveSttCaller(
  ctx: Ctx,
  request: Request,
  auth: Exclude<SttUpgradeAuth, { kind: null }>,
): Promise<{ ok: true; caller: Caller; acceptProtocol: string | null } | { ok: false; response: Response }> {
  if (auth.kind === "client_key") {
    const authHeaders = new Headers(request.headers);
    authHeaders.set("authorization", `Bearer ${auth.bearer}`);
    authHeaders.delete("sec-websocket-protocol");
    const authRequest = new Request(request.url, { method: request.method, headers: authHeaders });
    const resolved = await resolveClient(ctx.store, authRequest);
    if (!resolved.ok) {
      return {
        ok: false,
        response: authFailureResponse(ctx.requestId, resolved.failure, resolved.detail),
      };
    }
    return { ok: true, caller: resolved.caller, acceptProtocol: null };
  }

  // Ticket path: consume once, then re-load live client/account (do not trust mint-time state alone).
  const consumed = await ctx.store.consumeSttTicket(await sha256Hex(auth.ticket));
  if (!consumed) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "unauthenticated",
        "That STT session ticket is not valid. Tickets are single-use and expire quickly; mint a new one via POST /v1/stt/sessions.",
      ),
    };
  }

  const client = await ctx.store.getClient(consumed.client_id);
  if (!client || client.account_id !== consumed.account_id) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "unauthenticated",
        "That STT session ticket is not valid.",
      ),
    };
  }
  if (client.revoked_at) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "client_revoked",
        "This client key has been revoked. Delete the stored key and enroll again; retrying will not help.",
      ),
    };
  }

  const account = await ctx.store.getAccount(consumed.account_id);
  if (!account) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "unavailable",
        "This client resolves to an account that is not configured.",
      ),
    };
  }
  if (account.suspended_at) {
    return {
      ok: false,
      response: errorResponse(ctx.requestId, "forbidden", "This account is suspended."),
    };
  }

  const plan = await ctx.store.getPlan(account.plan_id);
  if (!plan) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "unavailable",
        "This client resolves to a plan that is not configured.",
      ),
    };
  }

  return {
    ok: true,
    caller: { client, account, plan },
    acceptProtocol: auth.acceptProtocol,
  };
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

  const auth = authFromSttUpgrade(request);
  if (auth.kind === null) {
    return errorResponse(
      ctx.requestId,
      "unauthenticated",
      "A valid credential is required: Authorization: Bearer pcp_… (native), or " +
        `Sec-WebSocket-Protocol: ${STT_WS_PROTOCOL}, stt_… after POST /v1/stt/sessions (browsers). ` +
        "Long-lived client keys and query tokens are not accepted in the WebSocket handshake.",
    );
  }

  const resolved = await resolveSttCaller(ctx, request, auth);
  if (!resolved.ok) return resolved.response;

  const { client, account, plan: planRow } = resolved.caller;
  const acceptProtocol = resolved.acceptProtocol;
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
  // Fail-closed: never sign with an empty string (that would make the HMAC forgeable).
  const handoffSecret = requireHandoffSecret(ctx.env.CF_AIG_TOKEN);
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
