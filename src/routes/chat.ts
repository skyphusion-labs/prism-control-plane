// POST /v1/chat/completions -- the metered inference door. The vertical slice this plane exists for.
//
// THE ORDER OF THE GATES IS LOAD-BEARING, cheapest and most-certain first:
//
//   1. body size        refuse before parsing (do not do the work you are trying to bound)
//   2. shape            refuse before authenticating (a malformed body needs no D1 read)
//   3. identity         who is this
//   4. plan             what are they entitled to, or refuse if we cannot tell
//   5. rate limit       before touching the catalog or the quota counter
//   6. model + tier     is this model real, and may they have it
//   7. gateway wired    fail closed if we cannot route through the meter
//   8. allowance        do they have budget left
//   9. spend            call the model
//  10. meter            price it, record it, THEN answer
//
// Nothing that costs money happens before step 9, and step 10 is awaited: this plane does not hand back
// a completion it has not tried to record.

import { errorResponse, jsonResponse } from "../http";
import { findModel } from "../catalog";
import { parseChatRequest } from "../chat-request";
import { extractFinishReason, extractText } from "../inference";
import { meterResponse } from "../meter";
import { periodBounds } from "../period";
import { effectiveMaxTokens, entitlesTier, planFromRow } from "../plans";
import { decideAllowance, remainingMicroUsd } from "../quota";
import { checkRateLimit, inferenceBucket } from "../rate-limit";
import { newId } from "../crypto";
import { readJsonBody } from "../http";
import type { UsageEvent } from "../store";
import { requireCaller, type Ctx } from "./shared";

export async function handleChatCompletions(ctx: Ctx, request: Request): Promise<Response> {
  // 1 + 2. Body first: a malformed or oversized request is refused without a single D1 read, so junk
  // traffic against this door costs no queries.
  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(ctx.requestId, body.code, body.message);
  const parsed = parseChatRequest(body.value);
  if (!parsed.ok) return errorResponse(ctx.requestId, "invalid_request", parsed.message);
  const req = parsed.value;

  // 3. Identity.
  const authed = await requireCaller(ctx, request);
  if (!authed.ok) return authed.response;
  const { client, account } = authed.caller;

  // 4. Entitlements.
  const planResult = planFromRow(authed.caller.plan);
  if (!planResult.ok) {
    console.error("plan is unusable", { requestId: ctx.requestId, reason: planResult.reason });
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "This account's plan is not usable, so the request was refused rather than served on a guessed entitlement.",
    );
  }
  const plan = planResult.plan;

  // 5. Rate limit, per ACCOUNT (see rate-limit.ts: per-client would let an account multiply its
  // throughput by enrolling more devices).
  const rate = await checkRateLimit(ctx.store, inferenceBucket(account.id), plan.requestsPerMinute);
  if (!rate.allowed) {
    return errorResponse(
      ctx.requestId,
      "rate_limited",
      `This account is limited to ${plan.requestsPerMinute} requests per minute.`,
      {},
      { "retry-after": String(rate.retryAfterSeconds) },
    );
  }

  // 6. The allowlist. An id outside the catalog is a 404 (it does not exist here at all); an id inside
  // the catalog that the plan does not reach is a 403. Different facts, different client actions: the
  // first means the picker is wrong, the second means the plan is.
  const model = findModel(req.model);
  if (!model) {
    return errorResponse(
      ctx.requestId,
      "model_not_found",
      `Model "${req.model}" is not in this deployment's catalog. Refresh GET /v1/models.`,
    );
  }
  if (!entitlesTier(plan, model.tier)) {
    return errorResponse(
      ctx.requestId,
      "model_not_entitled",
      `Plan "${plan.id}" does not include ${model.tier}-tier models. Refresh GET /v1/models.`,
    );
  }

  // Declared in the contract, not shipped. A 501 naming the reason beats silently ignoring `stream` and
  // returning one big non-streaming blob, which would look like a broken client to whoever debugs it.
  if (req.stream) {
    return errorResponse(
      ctx.requestId,
      "not_implemented",
      "Streaming is declared in contract v1 but is not implemented yet. Send stream:false.",
    );
  }

  // 7. Fail closed on an unconfigured gateway. A metering plane whose traffic bypasses the gateway has
  // discarded the attribution it exists for, so it declines rather than calling the model directly.
  if (!ctx.runner) {
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "No AI Gateway is configured on this deployment, so inference is closed. Requests are refused rather than routed off-gateway.",
    );
  }

  // 8. The allowance gate. See quota.ts for why this can be exceeded by exactly one request, and why
  // `indeterminate` answers 503 rather than 402.
  const bounds = periodBounds(ctx.now);
  const periodRow = await ctx.store.getPeriod(account.id, bounds.key);
  const usedBefore = periodRow?.micro_usd ?? 0;
  const allowance = decideAllowance({
    usedMicroUsd: usedBefore,
    includedMicroUsd: plan.includedMicroUsd,
  });
  if (allowance.outcome === "exhausted") {
    return errorResponse(
      ctx.requestId,
      "quota_exhausted",
      `The included allowance for ${bounds.key} is spent (${allowance.usedMicroUsd} of ${allowance.includedMicroUsd} micro-USD).`,
      { period: bounds.key, resets_at: bounds.end },
    );
  }
  if (allowance.outcome === "indeterminate") {
    console.error("allowance is indeterminate", {
      requestId: ctx.requestId,
      accountId: account.id,
      reason: allowance.reason,
    });
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "This account's usage position could not be established, so the request was refused rather than spent against an unknown balance.",
    );
  }

  const maxTokens = effectiveMaxTokens(req.maxTokens, plan.maxOutputTokens, model.maxOutputTokens);

  // 9. Spend.
  const result = await ctx.runner.run({
    upstreamModel: model.upstream,
    messages: req.messages,
    maxTokens,
    temperature: req.temperature,
    topP: req.topP,
    // Attribution for the gateway log, WHEN logging is on. Ids only: an account id and a client id are
    // opaque handles, not personal data, and nothing here can carry prompt content.
    metadata: {
      account_id: account.id,
      client_id: client.id,
      plan_id: plan.id,
      request_id: ctx.requestId,
    },
  });

  const baseEvent = {
    account_id: account.id,
    client_id: client.id,
    model_id: model.id,
    period_key: bounds.key,
    request_id: ctx.requestId,
  };

  if (result.outcome === "timeout") {
    // AN UNMETERED ROW, NOT NOTHING. The wait was abandoned but the model was never cancelled (the AI
    // binding takes no abort signal), so this is very likely spend we cannot price. Writing the gap down
    // is the only way it is ever visible; dropping it would make an abandoned request indistinguishable
    // from a request that never happened.
    await recordQuietly(ctx, {
      ...baseEvent,
      id: newId("use"),
      input_tokens: null,
      output_tokens: null,
      micro_usd: 0,
      metered: false,
      unmetered_reason: `upstream did not answer within ${result.waitedMs}ms; the model may have run and may still be billed to us`,
      upstream_status: null,
      gateway_log_id: null,
    });
    return errorResponse(
      ctx.requestId,
      "upstream_timeout",
      `The model did not answer within ${result.waitedMs}ms.`,
    );
  }

  if (result.outcome === "upstream_error") {
    // NO LEDGER ROW HERE, and the asymmetry with the timeout above is deliberate. An upstream error is
    // the provider telling us it did not serve the request (capacity, refusal, bad gateway config), so
    // there is normally nothing to price. Writing an unmetered row for every provider 429 would flood
    // `unmetered_requests` with noise and destroy the one signal that column exists to carry.
    //
    // The residual gap, stated rather than hidden: a provider that fails AFTER generating tokens would
    // be billed to us and recorded nowhere here. That case is visible in Cloudflare's own gateway
    // billing, and reconciling our ledger against gateway logs is the follow-on that closes it.
    console.error("upstream error", {
      requestId: ctx.requestId,
      model: model.id,
      status: result.status,
      detail: result.detail,
    });
    return errorResponse(
      ctx.requestId,
      "upstream_error",
      "The model or gateway failed to serve this request.",
      result.status === null ? {} : { upstream_status: result.status },
    );
  }

  const text = extractText(result.body);
  if (text === null) {
    // A successful-looking response with no extractable content is an upstream failure, not an empty
    // completion. Returning "" would make a provider problem look like a model that chose to say nothing.
    console.error("upstream returned no extractable text", {
      requestId: ctx.requestId,
      model: model.id,
    });
    return errorResponse(
      ctx.requestId,
      "upstream_error",
      "The model returned a response this plane could not read as text.",
    );
  }

  // 10. Meter, then record, THEN answer.
  const metered = meterResponse(result.body, model.price);
  const event: UsageEvent =
    metered.outcome === "metered"
      ? {
          ...baseEvent,
          id: newId("use"),
          input_tokens: metered.usage.inputTokens,
          output_tokens: metered.usage.outputTokens,
          micro_usd: metered.microUsd,
          metered: true,
          unmetered_reason: null,
          upstream_status: 200,
          gateway_log_id: result.gatewayLogId,
        }
      : {
          ...baseEvent,
          id: newId("use"),
          input_tokens: null,
          output_tokens: null,
          micro_usd: 0,
          metered: false,
          unmetered_reason: metered.reason,
          upstream_status: 200,
          gateway_log_id: result.gatewayLogId,
        };

  // AWAITED, not deferred to waitUntil. A metering plane must not answer with a charge it has not tried
  // to record; a deferred write that fails leaves usage the account was never billed for and nothing
  // anywhere says so. The cost is one D1 write of latency on the response.
  const recorded = await recordQuietly(ctx, event);

  const usedAfter = usedBefore + (metered.outcome === "metered" && recorded ? metered.microUsd : 0);
  const headers: Record<string, string> = {
    "prism-model": model.id,
    "prism-max-tokens-applied": String(maxTokens),
    "prism-usage-micro-usd": String(metered.outcome === "metered" ? metered.microUsd : 0),
    "prism-metered": metered.outcome === "metered" ? "true" : "false",
    // Whether the ledger write landed. False means the completion below was served and NOT charged; it
    // is surfaced rather than swallowed so a client-side or operator-side reader can see the gap.
    "prism-usage-recorded": recorded ? "true" : "false",
    "prism-quota-period": bounds.key,
    "prism-quota-used-micro-usd": String(usedAfter),
    "prism-quota-included-micro-usd": String(plan.includedMicroUsd),
    "prism-quota-remaining-micro-usd": String(
      remainingMicroUsd({ usedMicroUsd: usedAfter, includedMicroUsd: plan.includedMicroUsd }),
    ),
  };

  return jsonResponse(
    ctx.requestId,
    {
      // OpenAI-shaped so an OpenAI-compatible SDK consumes it unchanged. Metering facts stay in headers
      // precisely to keep this body free of our own extensions.
      id: `chatcmpl_${ctx.requestId.replace(/^req_/, "")}`,
      object: "chat.completion",
      created: Math.floor(ctx.now.getTime() / 1000),
      model: model.id,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          // The upstream's own reason where it gave one. Never invented: "stop" asserted over a
          // truncated answer would tell a client the model finished when it was cut off.
          finish_reason: extractFinishReason(result.body),
        },
      ],
      ...(metered.outcome === "metered"
        ? {
            usage: {
              prompt_tokens: metered.usage.inputTokens,
              completion_tokens: metered.usage.outputTokens,
              total_tokens: metered.usage.inputTokens + metered.usage.outputTokens,
            },
          }
        : {}),
    },
    { headers },
  );
}

/**
 * Write a ledger row, reporting success rather than throwing.
 *
 * The completion has already been paid for by the time this runs, so a failed write must not turn into a
 * 500 that discards an answer the account was charged for upstream. It IS logged at error level and
 * reported in `prism-usage-recorded`, so the gap is loud on both sides.
 */
async function recordQuietly(ctx: Ctx, event: UsageEvent): Promise<boolean> {
  try {
    await ctx.store.recordUsage(event);
    return true;
  } catch (err) {
    console.error("usage ledger write failed", {
      requestId: ctx.requestId,
      accountId: event.account_id,
      microUsd: event.micro_usd,
      error: String(err instanceof Error ? err.message : err),
    });
    return false;
  }
}
