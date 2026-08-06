// Non-chat metered doors: image, tts, stt, video, music.
//
// Same gate order as chat.ts (body → identity → plan → rate → model → price → wiring →
// balance → credential → spend → meter). Token pricing is replaced by unit pricing.

import { allocateCharge, decideBalance, remainingAllowanceMicroUsd, remainingMicroUsd } from "../balance";
import {
  DOOR_MODALITIES,
  findModel,
  type CatalogEntry,
  type Modality,
  type UnitPrice,
} from "../catalog";
import { newId } from "../crypto";
import { errorResponse, jsonResponse, readJsonBody, MAX_BODY_BYTES } from "../http";
import { priceUnits, resolvePrice, resolveUnitPrice } from "../meter";
import {
  buildImageParams,
  buildMusicParams,
  buildSttParams,
  buildTtsParams,
  buildVideoParams,
  extractAudioBase64,
  extractImageAsset,
  extractMusicAsset,
  extractTranscript,
  extractVideoAsset,
  providerStateFailed,
} from "../nonchat-upstream";
import { periodBounds } from "../period";
import { entitlesTier, planFromRow, type Plan } from "../plans";
import { checkRateLimit, inferenceBucket } from "../rate-limit";
import type { UsageEvent } from "../store";
import {
  mediaPublicUrl,
  mediaSigningSecret,
  mintDownloadToken,
  mintUploadToken,
  newVideoObjectKey,
} from "../media";
import { requireCaller, type Ctx } from "./shared";

/** Audio / multimodal JSON. 4 MiB matches the LLaVA image decode cap (audit: lower than 6 MiB). */
const NONCHAT_MAX_BODY = 4 * 1024 * 1024;

interface NonChatGateOk {
  client: { id: string };
  account: { id: string; credit_micro_usd: number; spent_micro_usd: number; plan_id: string };
  plan: Plan;
  model: CatalogEntry;
  unitPrice: UnitPrice;
  auth: { tokenId: string; value: string };
}

function requireString(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function gateNonChat(
  ctx: Ctx,
  request: Request,
  modality: Modality,
): Promise<{ ok: true } & NonChatGateOk | { ok: false; response: Response }> {
  const body = await readJsonBody(request, NONCHAT_MAX_BODY);
  if (!body.ok) return { ok: false, response: errorResponse(ctx.requestId, body.code, body.message) };

  const authed = await requireCaller(ctx, request);
  if (!authed.ok) return { ok: false, response: authed.response };
  const { client, account } = authed.caller;

  const planRow = await ctx.store.getPlan(account.plan_id);
  if (!planRow) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "unavailable",
        "This account's plan is not usable, so the request was refused rather than served on a guessed entitlement.",
      ),
    };
  }
  const planResult = planFromRow(planRow);
  if (!planResult.ok) {
    return {
      ok: false,
      response: errorResponse(ctx.requestId, "unavailable", planResult.reason),
    };
  }
  const plan = planResult.plan;

  const rate = await checkRateLimit(ctx.store, inferenceBucket(account.id), plan.requestsPerMinute);
  if (!rate.allowed) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "rate_limited",
        `Plan allows ${plan.requestsPerMinute} requests per minute.`,
        {},
        { "retry-after": String(rate.retryAfterSeconds) },
      ),
    };
  }

  const raw = (body.value ?? {}) as Record<string, unknown>;
  const modelId = requireString(raw, "model");
  if (!modelId) {
    return {
      ok: false,
      response: errorResponse(ctx.requestId, "invalid_request", '"model" is required.'),
    };
  }

  const model = findModel(modelId);
  if (!model) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "model_not_found",
        `Model "${modelId}" is not in this deployment's catalog. Refresh GET /v1/models.`,
      ),
    };
  }
  if (model.modality !== modality) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "invalid_request",
        `Model "${model.id}" is modality ${model.modality}; this door is ${modality}.`,
        { modality: model.modality },
      ),
    };
  }
  if (!DOOR_MODALITIES.has(model.modality)) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "model_unsupported",
        `Model "${model.id}" (${model.modality}) has no HTTP door on this plane.`,
        { modality: model.modality },
      ),
    };
  }
  if (!entitlesTier(plan, model.tier)) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "model_not_entitled",
        `Plan "${plan.id}" does not include ${model.tier}-tier models. Refresh GET /v1/models.`,
      ),
    };
  }

  const priceRow = await ctx.store.getModelPrice(model.id);
  const unitPrice = resolveUnitPrice(model, priceRow);
  if (!unitPrice) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "model_unpriced",
        `Model "${model.id}" has no unit rate on this deployment, so it cannot be metered. ` +
          "An operator must set one (POST /admin/model-prices with unit_micro_usd) before it can be spent against.",
        { billing: model.billing, modality: model.modality },
      ),
    };
  }

  if (!ctx.nonChatRunner) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "unavailable",
        "No AI Gateway is configured on this deployment, so non-chat inference is closed.",
      ),
    };
  }
  if (!ctx.credentials) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "unavailable",
        "This deployment has no upstream credential configured, so inference is closed.",
      ),
    };
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
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "quota_exhausted",
        `This account has no remaining monthly allowance or prepaid credit ` +
          `(period ${bounds.key}). Top up credit to continue.`,
        { period: bounds.key, resets_at: bounds.end },
      ),
    };
  }
  if (balance.outcome === "indeterminate") {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "unavailable",
        "This account's balance cannot be read reliably; refusing rather than guessing.",
      ),
    };
  }

  // Pre-flight: at least one unit of the unit price must fit (zero rate always passes).
  const minCharge = unitPrice.microUsdPerUnit;
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
      return {
        ok: false,
        response: errorResponse(
          ctx.requestId,
          "quota_exhausted",
          `Remaining balance ${remaining} micro-USD is below this model's unit rate ` +
            `(${minCharge} micro-USD per ${unitPrice.unit}).`,
          { period: bounds.key },
        ),
      };
    }
  }

  const cred = await ctx.credentials.forAccount(account.id);
  if (cred.outcome !== "ok") {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "unavailable",
        "Could not obtain an upstream credential for this account.",
      ),
    };
  }

  // Re-attach raw body for the modality handlers (they re-parse fields).
  (ctx as Ctx & { _nonchatBody?: unknown })._nonchatBody = body.value;

  return {
    ok: true,
    client: { id: client.id },
    account: {
      id: account.id,
      credit_micro_usd: account.credit_micro_usd,
      spent_micro_usd: account.spent_micro_usd,
      plan_id: account.plan_id,
    },
    plan,
    model,
    unitPrice,
    auth: { tokenId: cred.credential.tokenId, value: cred.credential.value },
  };
}

async function meterAndRespond(
  ctx: Ctx,
  gate: NonChatGateOk,
  units: number,
  responseBody: unknown,
  upstreamStatus: number,
  gatewayLogId: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const priced = priceUnits(units, gate.unitPrice);
  const bounds = periodBounds(ctx.now);
  const periodBefore = await ctx.store.getPeriod(gate.account.id, bounds.key);
  const balance = decideBalance({
    creditMicroUsd: gate.account.credit_micro_usd,
    spentMicroUsd: gate.account.spent_micro_usd,
    monthlyIncludedMicroUsd: gate.plan.monthlyIncludedMicroUsd,
    allowanceSpentMicroUsd: periodBefore?.allowance_spent_micro_usd ?? 0,
  });

  let fromAllowance = 0;
  let fromCredit = 0;
  if (priced.microUsd > 0 && balance.outcome === "allow") {
    const split = allocateCharge(priced.microUsd, {
      monthlyIncludedMicroUsd: gate.plan.monthlyIncludedMicroUsd,
      allowanceSpentMicroUsd: periodBefore?.allowance_spent_micro_usd ?? 0,
    });
    fromAllowance = split.fromAllowanceMicroUsd;
    fromCredit = split.fromCreditMicroUsd;
  }

  const event: UsageEvent = {
    id: newId("use"),
    request_id: ctx.requestId,
    account_id: gate.account.id,
    client_id: gate.client.id,
    model_id: gate.model.id,
    period_key: bounds.key,
    input_tokens: null,
    output_tokens: null,
    micro_usd: priced.microUsd,
    from_allowance_micro_usd: fromAllowance,
    from_credit_micro_usd: fromCredit,
    metered: true,
    unmetered_reason: null,
    upstream_status: upstreamStatus,
    gateway_log_id: gatewayLogId,
  };

  let recorded = true;
  try {
    await ctx.store.recordUsage(event);
  } catch (err) {
    recorded = false;
    console.error("nonchat ledger write failed", {
      requestId: ctx.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const accountAfter = (await ctx.store.getAccount(gate.account.id)) ?? {
    credit_micro_usd: gate.account.credit_micro_usd,
    spent_micro_usd: gate.account.spent_micro_usd + fromCredit,
  };
  const periodAfter = await ctx.store.getPeriod(gate.account.id, bounds.key);

  return jsonResponse(ctx.requestId, responseBody, {
    headers: {
      "prism-model": gate.model.id,
      "prism-metered": "true",
      "prism-usage-micro-usd": String(priced.microUsd),
      "prism-usage-recorded": recorded ? "true" : "false",
      "prism-credit-micro-usd": String(accountAfter.credit_micro_usd),
      "prism-spent-micro-usd": String(accountAfter.spent_micro_usd),
      "prism-credit-remaining-micro-usd": String(
        remainingMicroUsd({
          creditMicroUsd: accountAfter.credit_micro_usd,
          spentMicroUsd: accountAfter.spent_micro_usd,
        }),
      ),
      "prism-allowance-remaining-micro-usd": String(
        remainingAllowanceMicroUsd({
          monthlyIncludedMicroUsd: gate.plan.monthlyIncludedMicroUsd,
          allowanceSpentMicroUsd: periodAfter?.allowance_spent_micro_usd ?? 0,
        }),
      ),
      "prism-period": bounds.key,
      "prism-units": String(priced.units),
      "prism-unit": gate.unitPrice.unit,
      ...extraHeaders,
    },
  });
}

async function runUpstream(
  ctx: Ctx,
  gate: NonChatGateOk,
  params: Record<string, unknown>,
): Promise<
  | { ok: true; body: unknown; gatewayLogId: string | null }
  | { ok: false; response: Response }
> {
  const result = await ctx.nonChatRunner!.run({
    upstreamModel: gate.model.upstream,
    billing: gate.model.billing,
    modality: gate.model.modality,
    params,
    auth: gate.auth,
    metadata: {
      account_id: gate.account.id,
      client_id: gate.client.id,
      plan_id: gate.account.plan_id,
      request_id: ctx.requestId,
      cf_token_id: gate.auth.tokenId,
    },
  });

  if (result.outcome === "timeout") {
    await recordUnmetered(ctx, gate, "timeout", null);
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "upstream_timeout",
        `The model did not answer within ${result.waitedMs}ms.`,
      ),
    };
  }
  if (result.outcome === "unavailable") {
    return {
      ok: false,
      response: errorResponse(ctx.requestId, "unavailable", result.detail),
    };
  }
  if (result.outcome === "upstream_error") {
    await recordUnmetered(ctx, gate, "upstream_error", result.status);
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "upstream_error",
        result.detail.slice(0, 300),
        { upstream_status: result.status },
      ),
    };
  }
  return { ok: true, body: result.body, gatewayLogId: result.gatewayLogId };
}

async function recordUnmetered(
  ctx: Ctx,
  gate: NonChatGateOk,
  reason: string,
  upstreamStatus: number | null,
): Promise<void> {
  const bounds = periodBounds(ctx.now);
  try {
    await ctx.store.recordUsage({
      id: newId("use"),
      request_id: ctx.requestId,
      account_id: gate.account.id,
      client_id: gate.client.id,
      model_id: gate.model.id,
      period_key: bounds.key,
      input_tokens: null,
      output_tokens: null,
      micro_usd: 0,
      from_allowance_micro_usd: 0,
      from_credit_micro_usd: 0,
      metered: false,
      unmetered_reason: reason,
      upstream_status: upstreamStatus,
      gateway_log_id: null,
    });
  } catch {
    /* best effort */
  }
}

// ---- public handlers ----

export async function handleImageGenerations(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await gateNonChat(ctx, request, "image");
  if (!gate.ok) return gate.response;
  const raw = ((ctx as Ctx & { _nonchatBody?: unknown })._nonchatBody ?? {}) as Record<string, unknown>;
  const prompt = requireString(raw, "prompt");
  if (!prompt) {
    return errorResponse(ctx.requestId, "invalid_request", '"prompt" is required.');
  }
  // Optional reference image for i2i / edit models (https or data:).
  const imageUrl =
    requireString(raw, "image") ?? requireString(raw, "image_url") ?? undefined;
  const params = buildImageParams(gate.model.id, prompt, imageUrl);
  const up = await runUpstream(ctx, gate, params);
  if (!up.ok) return up.response;
  const fail = providerStateFailed(up.body);
  if (fail) {
    await recordUnmetered(ctx, gate, "provider_failed", 200);
    return errorResponse(ctx.requestId, "upstream_error", fail);
  }
  const asset = extractImageAsset(up.body);
  if (!asset || (!asset.b64_json && !asset.url)) {
    await recordUnmetered(ctx, gate, "no_image_payload", 200);
    return errorResponse(
      ctx.requestId,
      "upstream_error",
      "Image generation returned no image payload.",
    );
  }
  // OpenAI-shaped: put bytes in b64_json and URLs in url — never a URL in b64_json.
  const item: { b64_json?: string; url?: string } = {};
  if (asset.b64_json) item.b64_json = asset.b64_json;
  if (asset.url) item.url = asset.url;
  return meterAndRespond(
    ctx,
    gate,
    1,
    {
      created: Math.floor(ctx.now.getTime() / 1000),
      data: [item],
      model: gate.model.id,
    },
    200,
    up.gatewayLogId,
  );
}

export async function handleAudioSpeech(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await gateNonChat(ctx, request, "tts");
  if (!gate.ok) return gate.response;
  const raw = ((ctx as Ctx & { _nonchatBody?: unknown })._nonchatBody ?? {}) as Record<string, unknown>;
  const input = requireString(raw, "input") ?? requireString(raw, "text");
  if (!input) {
    return errorResponse(ctx.requestId, "invalid_request", '"input" (or "text") is required.');
  }
  const params = buildTtsParams(gate.model.id, input);
  const up = await runUpstream(ctx, gate, params);
  if (!up.ok) return up.response;
  const fail = providerStateFailed(up.body);
  if (fail) {
    await recordUnmetered(ctx, gate, "provider_failed", 200);
    return errorResponse(ctx.requestId, "upstream_error", fail);
  }
  const audio = extractAudioBase64(up.body);
  if (!audio) {
    await recordUnmetered(ctx, gate, "no_audio_payload", 200);
    return errorResponse(ctx.requestId, "upstream_error", "TTS returned no audio payload.");
  }
  const units =
    gate.unitPrice.unit === "k_characters"
      ? Math.max(1, Math.ceil(input.length / 1000))
      : 1; // audio_minute: bill one minute floor when duration unknown
  return meterAndRespond(
    ctx,
    gate,
    units,
    { model: gate.model.id, audio_base64: audio, format: "mp3" },
    200,
    up.gatewayLogId,
  );
}

export async function handleAudioTranscriptions(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await gateNonChat(ctx, request, "stt");
  if (!gate.ok) return gate.response;
  const raw = ((ctx as Ctx & { _nonchatBody?: unknown })._nonchatBody ?? {}) as Record<string, unknown>;
  // Accept data URL or raw base64 in "audio" / "file"
  let audio = requireString(raw, "audio") ?? requireString(raw, "file");
  if (!audio) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      '"audio" is required (base64 or data:audio/...;base64,...).',
    );
  }
  const dataUrl = /^data:audio\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(audio);
  if (dataUrl) audio = dataUrl[1];
  const params = buildSttParams(audio);
  const up = await runUpstream(ctx, gate, params);
  if (!up.ok) return up.response;
  const fail = providerStateFailed(up.body);
  if (fail) {
    await recordUnmetered(ctx, gate, "provider_failed", 200);
    return errorResponse(ctx.requestId, "upstream_error", fail);
  }
  const text = extractTranscript(up.body);
  if (text === null) {
    await recordUnmetered(ctx, gate, "no_transcript", 200);
    return errorResponse(ctx.requestId, "upstream_error", "STT returned no transcript.");
  }
  // Bill one audio minute floor when duration is unknown.
  return meterAndRespond(
    ctx,
    gate,
    1,
    { model: gate.model.id, text },
    200,
    up.gatewayLogId,
  );
}

export async function handleVideoGenerations(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await gateNonChat(ctx, request, "video");
  if (!gate.ok) return gate.response;
  const raw = ((ctx as Ctx & { _nonchatBody?: unknown })._nonchatBody ?? {}) as Record<string, unknown>;
  const prompt = requireString(raw, "prompt") ?? "";
  const imageUrl = requireString(raw, "image") ?? requireString(raw, "image_url") ?? undefined;
  if (!prompt && !imageUrl) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      '"prompt" or "image" is required for video generation.',
    );
  }
  // MiniMax Hailuo is image-to-video only on CF (first_frame_image required).
  if (gate.model.id.startsWith("minimax/hailuo") && !imageUrl) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      `Model "${gate.model.id}" requires an image (i2v). Pass "image" as an https URL or data: URI, or pick a text-to-video model (e.g. bytedance/seedance-2.0-mini, xai/grok-imagine-video, google/veo-3.1-fast).`,
    );
  }

  // Grok video on CF UB: managed xAI credentials are ZDR. Must supply output.upload_url
  // (xAI PUTs the mp4 to us). See src/media.ts.
  let uploadUrl: string | undefined;
  let downloadUrl: string | undefined;
  let objectKey: string | undefined;
  if (gate.model.id.startsWith("xai/grok-imagine-video")) {
    const secret = mediaSigningSecret(ctx.env);
    if (!ctx.env.MEDIA || !secret) {
      return errorResponse(
        ctx.requestId,
        "unavailable",
        "Grok video requires the MEDIA R2 binding and CF_AIG_TOKEN (ZDR-managed xAI needs output.upload_url). Use Veo or Seedance Fast until configured.",
      );
    }
    objectKey = newVideoObjectKey(gate.account.id, ctx.requestId);
    const origin = new URL(request.url).origin;
    const upTok = await mintUploadToken(secret, objectKey);
    const downTok = await mintDownloadToken(secret, objectKey);
    uploadUrl = mediaPublicUrl(origin, `/v1/media/ingress/${upTok.token}`);
    downloadUrl = mediaPublicUrl(origin, `/v1/media/${downTok.token}`);
  }

  const params = buildVideoParams(gate.model.id, prompt, imageUrl, { uploadUrl });
  const up = await runUpstream(ctx, gate, params);
  if (!up.ok) return up.response;
  const fail = providerStateFailed(up.body);
  if (fail) {
    await recordUnmetered(ctx, gate, "provider_failed", 200);
    return errorResponse(ctx.requestId, "upstream_error", fail);
  }
  let asset = extractVideoAsset(up.body);
  // ZDR path: provider may return Completed with no hosted URL; bytes are in our R2 via ingress.
  if (!asset && downloadUrl && objectKey && ctx.env.MEDIA) {
    const head = await ctx.env.MEDIA.head(objectKey);
    if (head) asset = downloadUrl;
  }
  if (!asset && downloadUrl) {
    // Some providers ack before the PUT finishes; still hand back the signed URL and let the client retry GET.
    asset = downloadUrl;
  }
  if (!asset) {
    await recordUnmetered(ctx, gate, "no_video_payload", 200);
    return errorResponse(
      ctx.requestId,
      "upstream_error",
      "Video generation returned no video payload.",
    );
  }
  return meterAndRespond(
    ctx,
    gate,
    1,
    { model: gate.model.id, video: asset, result: up.body },
    200,
    up.gatewayLogId,
  );
}

export async function handleMusicGenerations(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await gateNonChat(ctx, request, "music");
  if (!gate.ok) return gate.response;
  const raw = ((ctx as Ctx & { _nonchatBody?: unknown })._nonchatBody ?? {}) as Record<string, unknown>;
  const prompt = requireString(raw, "prompt");
  if (!prompt) {
    return errorResponse(ctx.requestId, "invalid_request", '"prompt" is required.');
  }
  const lyrics = requireString(raw, "lyrics") ?? undefined;
  // Optional client overrides (plane defaults: instrumental when no lyrics).
  const isInstrumental =
    typeof raw.is_instrumental === "boolean" ? raw.is_instrumental : undefined;
  const lyricsOptimizer =
    typeof raw.lyrics_optimizer === "boolean" ? raw.lyrics_optimizer : undefined;
  const params = buildMusicParams(prompt, lyrics, { isInstrumental, lyricsOptimizer });
  const up = await runUpstream(ctx, gate, params);
  if (!up.ok) return up.response;
  const fail = providerStateFailed(up.body);
  if (fail) {
    await recordUnmetered(ctx, gate, "provider_failed", 200);
    return errorResponse(ctx.requestId, "upstream_error", fail);
  }
  const asset = extractMusicAsset(up.body);
  if (!asset) {
    await recordUnmetered(ctx, gate, "no_music_payload", 200);
    return errorResponse(
      ctx.requestId,
      "upstream_error",
      "Music generation returned no audio payload.",
    );
  }
  return meterAndRespond(
    ctx,
    gate,
    1,
    { model: gate.model.id, audio: asset, result: up.body },
    200,
    up.gatewayLogId,
  );
}

// silence unused import if tree-shaken oddly
void MAX_BODY_BYTES;
void resolvePrice;
