// POST /v1/chat/completions -- the metered inference door. The vertical slice this plane exists for.
//
// THE ORDER OF THE GATES IS LOAD-BEARING, cheapest and most-certain first:
//
//   1. body size        refuse before parsing (do not do the work you are trying to bound)
//   2. shape            refuse before authenticating (a malformed body needs no D1 read)
//   3. identity         who is this
//   4. plan             what are they entitled to, or refuse if we cannot tell
//   5. rate limit       before touching the catalog or the money counters
//   6. model + tier     is this model real, is it a chat model, and may they have it
//   7. price            is there a rate at all -- a model we cannot price is not spendable
//   8. wiring           gateway and minting credential, or fail closed
//   9. balance          is there prepaid credit left
//  10. credential       get or mint this user's own upstream token
//  11. spend            call the model
//  12. meter            price it, record it, THEN answer
//
// Nothing that costs money happens before step 11. For a buffered response step 12 is AWAITED: this plane
// does not hand back a completion it has not tried to record. For a stream it cannot be, because the token
// counts arrive after the headers -- see the streaming section for what replaces it.

import { errorResponse, jsonResponse } from "../http";
import { findModel } from "../catalog";
import { parseChatRequest } from "../chat-request";
import { extractFinishReason, extractText } from "../inference";
import { meterResponse, meterUsageObject, resolvePrice } from "../meter";
import { periodBounds } from "../period";
import { effectiveMaxTokens, entitlesTier, planFromRow } from "../plans";
import { allocateCharge, decideBalance, remainingAllowanceMicroUsd, remainingMicroUsd } from "../balance";
import { checkRateLimit, inferenceBucket } from "../rate-limit";
import { newId } from "../crypto";
import { readJsonBody } from "../http";
import { meteredRelay } from "../stream";
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

  // 6. The allowlist. An id outside the catalog is a 404 (it does not exist here at all); an id inside the
  // catalog that the plan does not reach is a 403. Different facts, different client actions: the first
  // means the picker is wrong, the second means the plan is.
  const model = findModel(req.model);
  if (!model) {
    return errorResponse(
      ctx.requestId,
      "model_not_found",
      `Model "${req.model}" is not in this deployment's catalog. Refresh GET /v1/models.`,
    );
  }
  // The catalog carries every model prism offers, across seven modalities. This door serves chat. An
  // image or video model reaching here is a real client mistake and deserves its own answer rather than a
  // confusing shape error from a model that was never going to return a completion.
  if (model.modality !== "chat") {
    const doorHint =
      model.modality === "image"
        ? "POST /v1/images/generations"
        : model.modality === "tts"
          ? "POST /v1/audio/speech"
          : model.modality === "stt"
            ? "POST /v1/audio/transcriptions"
            : model.modality === "video"
              ? "POST /v1/videos/generations"
              : model.modality === "music"
                ? "POST /v1/music/generations"
                : model.modality === "voice"
                  ? "GET/WS /v1/stt/stream (Deepgram Flux live mic)"
                  : "no door for this modality";
    return errorResponse(
      ctx.requestId,
      "model_unsupported",
      `Model "${model.id}" is a ${model.modality} model. Use ${doorHint}, not /v1/chat/completions.`,
      { modality: model.modality },
    );
  }
  if (!entitlesTier(plan, model.tier)) {
    return errorResponse(
      ctx.requestId,
      "model_not_entitled",
      `Plan "${plan.id}" does not include ${model.tier}-tier models. Refresh GET /v1/models.`,
    );
  }
  if (req.stream && !model.streaming) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      `Model "${model.id}" does not stream. Send stream:false, or see GET /v1/models.`,
    );
  }

  // LLaVA (and the chat-door `image` data-URL field) retired 2026-08-05. Vision goes through
  // multimodal chat models on the normal messages path, not a side image field.
  if (req.imageBytes?.byteLength) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      `Model "${model.id}" does not accept an image field. LLaVA has been removed; use a vision-capable chat model.`,
    );
  }

  // 7. THE PRICE GATE. Cloudflare publishes no per-token rate for third-party Unified Billing models, so a
  // large part of the catalog arrives unpriced. Serving one would be host-billed spend with no meter behind
  // it, which is the single failure this plane exists to prevent. An operator sets a rate in `model_prices`
  // and the model becomes spendable with no deploy. GET /v1/models publishes `spendable` so a correct
  // client never reaches this refusal.
  const priceOverride = await ctx.store.getModelPrice(model.id);
  const price = resolvePrice(model, priceOverride);
  if (!price) {
    return errorResponse(
      ctx.requestId,
      "model_unpriced",
      `Model "${model.id}" has no per-token rate on this deployment, so it cannot be metered and is ` +
        "refused. An operator must set one before it can be spent against.",
      { billing: model.billing },
    );
  }

  // 8. Fail closed on missing wiring. Two distinct conditions, logged distinctly: without a gateway there is
  // nowhere to send the call, and without a credential source there is nothing to send it with. Either one
  // served anyway would be inference this plane cannot attribute or stop.
  if (!ctx.runner) {
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "No AI Gateway is configured on this deployment, so inference is closed. Requests are refused rather than routed off-gateway.",
    );
  }
  if (!ctx.credentials) {
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "This deployment has no upstream credential configured, so inference is closed rather than attempted unauthenticated.",
    );
  }

  // 9. The dual-pool spend gate: monthly allowance first, then prepaid credit. See balance.ts for the
  // one-request overshoot bound, and why `indeterminate` answers 503 rather than 402.
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
      `This account has no remaining monthly allowance or prepaid credit ` +
        `(${balance.spentMicroUsd} of ${balance.creditMicroUsd} micro-USD credit spent; allowance exhausted). ` +
        "There is no overage on this plane: wait for the next period or top up credit.",
      {
        credit_micro_usd: balance.creditMicroUsd,
        spent_micro_usd: balance.spentMicroUsd,
        monthly_included_micro_usd: plan.monthlyIncludedMicroUsd,
        allowance_remaining_micro_usd: 0,
      },
    );
  }
  if (balance.outcome === "indeterminate") {
    console.error("balance is indeterminate", {
      requestId: ctx.requestId,
      accountId: account.id,
      reason: balance.reason,
    });
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "This account's credit position could not be established, so the request was refused rather than spent against an unknown balance.",
    );
  }

  // 10. The shared account credential. Product is one CF_AIG_TOKEN for every Prism account (500-token
  // ceiling rules out minting per account). The value never leaves this Worker; handing it to a device
  // would delete the meter. Attribution is cf-aig-metadata + the ledger, not the credential identity.
  const credential = await ctx.credentials.forAccount(account.id);
  if (credential.outcome === "unavailable") {
    // Operator information only (missing secret, retired mode still set). Not for the phone.
    console.error("no upstream credential for account", {
      requestId: ctx.requestId,
      accountId: account.id,
      mode: ctx.credentials.mode,
      reason: credential.reason,
    });
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "An upstream credential for this request could not be obtained, so it was refused rather than run unmetered.",
    );
  }

  const maxTokens = effectiveMaxTokens(req.maxTokens, plan.maxOutputTokens, model.maxOutputTokens);
  const baseEvent = {
    account_id: account.id,
    client_id: client.id,
    model_id: model.id,
    period_key: bounds.key,
    request_id: ctx.requestId,
  };

  /** Build a ledger row, splitting a metered charge across allowance then credit. */
  async function buildEvent(
    partial: Omit<
      UsageEvent,
      | "account_id"
      | "client_id"
      | "model_id"
      | "period_key"
      | "request_id"
      | "from_allowance_micro_usd"
      | "from_credit_micro_usd"
    > & { micro_usd: number; metered: boolean },
  ): Promise<UsageEvent> {
    if (!partial.metered || partial.micro_usd <= 0) {
      return {
        ...baseEvent,
        ...partial,
        from_allowance_micro_usd: 0,
        from_credit_micro_usd: 0,
      };
    }
    // Fresh period read at record time so concurrent requests each see the latest allowance burn.
    // Overshoot by more than one is still possible under race; same accepted bound as prepaid.
    const periodNow = await ctx.store.getPeriod(account.id, bounds.key);
    const split = allocateCharge(partial.micro_usd, {
      monthlyIncludedMicroUsd: plan.monthlyIncludedMicroUsd,
      allowanceSpentMicroUsd: periodNow?.allowance_spent_micro_usd ?? 0,
    });
    return {
      ...baseEvent,
      ...partial,
      from_allowance_micro_usd: split.fromAllowanceMicroUsd,
      from_credit_micro_usd: split.fromCreditMicroUsd,
    };
  }

  // 11. Spend.
  const result = await ctx.runner.run({
    upstreamModel: model.upstream,
    // Fable / Grok 4.5 / Gemini: env.AI.run with the public catalog id (binding injects UB).
    ...(model.binding ? { bindingModel: model.id } : {}),
    ...(model.api === "responses" ? { api: "responses" as const } : {}),
    // Selects the gateway endpoint: Workers AI models take the provider-native path, third-party
    // Unified Billing models take the OpenAI-compatible one. See src/upstream.ts.
    billing: model.billing,
    messages: req.messages,
    maxTokens,
    temperature: req.temperature,
    topP: req.topP,
    stream: req.stream === true,
    imageBytes: req.imageBytes,
    auth: { tokenId: credential.credential.tokenId, value: credential.credential.value },
    // Attribution for the gateway log. IDS ONLY: an account id, a client id and a Cloudflare token id are
    // opaque handles, not personal data, and nothing here can carry content.
    //
    // Shared CF_AIG_TOKEN for every account; gateway logs do not break spend down by which token presented
    // it. `cf-aig-metadata` is what User Insights and the log API use for per-account attribution (and what
    // reconcile joins on via request_id).
    //
    // EXACTLY FIVE ENTRIES, WHICH IS THE CAP. Cloudflare keeps the first five and silently drops the rest, so
    // a sixth field added here would not fail, it would quietly delete whichever one sorted last. Anything
    // new has to replace something.
    // https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
    metadata: {
      account_id: account.id,
      client_id: client.id,
      plan_id: plan.id,
      request_id: ctx.requestId,
      cf_token_id: credential.credential.tokenId,
    },
  });

  if (result.outcome === "timeout") {
    // AN UNMETERED ROW, NOT NOTHING. The fetch was aborted, but the upstream may have generated tokens
    // before the abort landed and may still bill us for them. Writing the gap down is the only way it is
    // ever visible; dropping it would make an abandoned request indistinguishable from one that never
    // happened.
    await recordQuietly(
      ctx,
      await buildEvent({
        id: newId("use"),
        input_tokens: null,
        output_tokens: null,
        micro_usd: 0,
        metered: false,
        unmetered_reason: `upstream did not answer within ${result.waitedMs}ms; tokens may have been generated and billed to us before the abort landed`,
        upstream_status: null,
        gateway_log_id: null,
      }),
    );
    return errorResponse(
      ctx.requestId,
      "upstream_timeout",
      `The model did not answer within ${result.waitedMs}ms.`,
    );
  }

  if (result.outcome === "upstream_error") {
    // NO LEDGER ROW HERE, and the asymmetry with the timeout above is deliberate. An upstream error is the
    // provider telling us it did not serve the request (capacity, refusal, bad gateway config), so there is
    // normally nothing to price. Writing an unmetered row for every provider 429 would flood
    // `unmetered_requests` with noise and destroy the one signal that column exists to carry.
    //
    // The residual gap, stated rather than hidden: a provider that fails AFTER generating tokens would be
    // billed to us and recorded nowhere here. That case is visible in Cloudflare's own billing, and
    // reconciling our ledger against it is the follow-on that closes it.
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

  // Money position on every served response so a client can render balance without a second call.
  // Allowance and credit are separate headers so a monthly reset cannot be confused with a cash top-up.
  const moneyHeaders = (args: {
    spentAfter: number;
    allowanceRemaining: number;
  }): Record<string, string> => ({
    "prism-period": bounds.key,
    "prism-credit-micro-usd": String(account.credit_micro_usd),
    "prism-spent-micro-usd": String(args.spentAfter),
    "prism-credit-remaining-micro-usd": String(
      remainingMicroUsd({ creditMicroUsd: account.credit_micro_usd, spentMicroUsd: args.spentAfter }),
    ),
    "prism-monthly-included-micro-usd": String(plan.monthlyIncludedMicroUsd),
    "prism-allowance-remaining-micro-usd": String(args.allowanceRemaining),
  });

  const allowanceRemainingBefore = remainingAllowanceMicroUsd({
    monthlyIncludedMicroUsd: plan.monthlyIncludedMicroUsd,
    allowanceSpentMicroUsd: periodBefore?.allowance_spent_micro_usd ?? 0,
  });

  if (result.outcome === "stream") {
    // ---- STREAMING ----
    //
    // A streamed request CANNOT carry its price in a header: the token counts arrive in the last SSE frame,
    // after these headers have already gone to the client. So the money facts on a stream are pre-flight
    // only, `prism-metered` is deliberately absent rather than guessed, and the ledger row is written when
    // the stream settles.
    //
    // The relay does not touch the bytes -- an OpenAI-compatible SDK sees Cloudflare's own frames, including
    // the trailing usage frame it asked for. If the usage never arrives the request lands in the ledger
    // UNMETERED with a reason, which is the honest outcome and not a zero charge.
    const stream = meteredRelay(result.stream, (settlement) => {
      const metered =
        settlement.usage === null ? null : meterUsageObject(settlement.usage, price);
      // waitUntil, because the response has already been streamed by the time this runs. This is the one
      // place in the plane where the ledger write is NOT awaited before answering, and it is not a choice:
      // the price does not exist until the last byte. The write is still awaited by the runtime, and a
      // failure is logged at error level by recordQuietly.
      ctx.waitUntil(
        (async () => {
          const event = await buildEvent(
            metered && metered.outcome === "metered"
              ? {
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
                  id: newId("use"),
                  input_tokens: null,
                  output_tokens: null,
                  micro_usd: 0,
                  metered: false,
                  unmetered_reason: streamUnmeteredReason(settlement, metered?.reason),
                  upstream_status: 200,
                  gateway_log_id: result.gatewayLogId,
                },
          );
          await recordQuietly(ctx, event);
        })(),
      );
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "prism-api-version": "1",
        "prism-request-id": ctx.requestId,
        "prism-model": model.id,
        "prism-max-tokens-applied": String(maxTokens),
        "prism-stream": "true",
        ...moneyHeaders({
          spentAfter: account.spent_micro_usd,
          allowanceRemaining: allowanceRemainingBefore,
        }),
      },
    });
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

  // 12. Meter, then record, THEN answer.
  const metered = meterResponse(result.body, price);
  const event = await buildEvent(
    metered.outcome === "metered"
      ? {
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
          id: newId("use"),
          input_tokens: null,
          output_tokens: null,
          micro_usd: 0,
          metered: false,
          unmetered_reason: metered.reason,
          upstream_status: 200,
          gateway_log_id: result.gatewayLogId,
        },
  );

  // AWAITED, not deferred to waitUntil. A metering plane must not answer with a charge it has not tried to
  // record; a deferred write that fails leaves usage the account was never billed for and nothing anywhere
  // says so. The cost is one D1 write of latency on the response.
  const recorded = await recordQuietly(ctx, event);

  const spentAfter =
    account.spent_micro_usd + (recorded ? event.from_credit_micro_usd : 0);
  const allowanceRemainingAfter = Math.max(
    0,
    allowanceRemainingBefore - (recorded ? event.from_allowance_micro_usd : 0),
  );
  const headers: Record<string, string> = {
    "prism-model": model.id,
    "prism-max-tokens-applied": String(maxTokens),
    "prism-usage-micro-usd": String(metered.outcome === "metered" ? metered.microUsd : 0),
    "prism-metered": metered.outcome === "metered" ? "true" : "false",
    // Whether the ledger write landed. False means the completion below was served and NOT charged; it is
    // surfaced rather than swallowed so a client-side or operator-side reader can see the gap.
    "prism-usage-recorded": recorded ? "true" : "false",
    ...moneyHeaders({ spentAfter, allowanceRemaining: allowanceRemainingAfter }),
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
          // The upstream's own reason where it gave one. Never invented: "stop" asserted over a truncated
          // answer would tell a client the model finished when it was cut off.
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
 * Why a streamed request could not be priced, in the words an operator needs.
 *
 * THREE DIFFERENT CAUSES, kept apart because they demand different actions: a client that hung up (nothing
 * to do), a provider that ignored `stream_options.include_usage` (a per-model finding worth chasing), and a
 * usage object that arrived but did not price (a shape or rate problem on our side).
 */
function streamUnmeteredReason(
  settlement: { usage: unknown; sawFrames: boolean; aborted: boolean },
  meterReason: string | undefined,
): string {
  if (meterReason) return `streamed usage arrived but could not be priced: ${meterReason}`;
  if (settlement.aborted) {
    return "the stream ended early (client disconnect or upstream error) before a usage frame arrived; tokens generated up to that point are billed to us and cannot be priced here";
  }
  if (!settlement.sawFrames) {
    return "the streamed response carried no recognizable SSE data frames, so no usage could be read";
  }
  return "the streamed response ended without a usage frame despite stream_options.include_usage being requested";
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
