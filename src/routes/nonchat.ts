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
  buildDeepgramSttBindingParams,
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
  isDeepgramBatchStt,
  prefersAsyncImage,
  providerStateFailed,
} from "../nonchat-upstream";
import { resolveVideoDuration } from "../video-duration";
import { periodBounds } from "../period";
import { entitlesTier, planFromRow, type Plan } from "../plans";
import { checkRateLimit, inferenceBucket } from "../rate-limit";
import type { AsyncJobRow, UsageEvent } from "../store";
import {
  MEDIA_MAX_BYTES,
  mediaPublicUrl,
  mediaSigningSecret,
  mintDownloadToken,
  mintUploadToken,
  newMusicObjectKey,
  newVideoObjectKey,
} from "../media";
import { waitForMediaObject } from "./media";
import { jobToWire, wantsAsync } from "./jobs";
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
  // ALLOCATE WHENEVER THERE IS A PRICE, NOT ONLY WHEN THE BALANCE STILL READS "allow".
  //
  // recordUsage drives every money column from these two fields: allowance_spent advances by
  // fromAllowance and accounts.spent_micro_usd advances only when fromCredit > 0. Leaving them at
  // zero on a metered row therefore advances usage_periods.micro_usd by the full price while
  // neither pool moves -- served, and not charged.
  //
  // It cannot be recovered downstream either: the row is written metered with the correct
  // micro_usd, so reconcile computes a zero delta and reports in_agreement forever. Only the pool
  // columns are wrong and reconcile does not read them.
  //
  // Overshooting by one request when the balance has just been exhausted is the accepted bound
  // here, the same one chat.ts and the STT meter already take deliberately.
  if (priced.microUsd > 0) {
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

  // gpt-image-2 (and explicit Prefer: respond-async) → Workflow; sync mobile clients
  // time out around 90s while the provider often needs longer.
  if (wantsAsync(request, raw) || prefersAsyncImage(gate.model.id)) {
    return startAsyncLongRun(ctx, request, gate, {
      kind: "image",
      prompt,
      lyrics: undefined,
      imageUrl,
      voice: undefined,
      billableUnits: 1,
    });
  }

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
  // OpenAI-shaped: put bytes in b64_json and URLs in url, never a URL in b64_json.
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
  // Aura-2 requires voice/speaker; optional client override, else plane default "luna".
  const voice =
    requireString(raw, "voice") ?? requireString(raw, "speaker") ?? undefined;

  // Mobile / Prefer: respond-async → Workflow (same as music/video).
  if (wantsAsync(request, raw)) {
    const units =
      gate.unitPrice.unit === "k_characters"
        ? Math.max(1, Math.ceil(input.length / 1000))
        : 1;
    return startAsyncLongRun(ctx, request, gate, {
      kind: "speech",
      prompt: input,
      lyrics: undefined,
      imageUrl: undefined,
      voice,
      billableUnits: units,
    });
  }

  const params = buildTtsParams(gate.model.id, input, { voice });
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
  let mime = "audio/mpeg";
  const dataUrl = /^data:(audio\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(audio);
  if (dataUrl) {
    mime = dataUrl[1];
    audio = dataUrl[2];
  }

  // Deepgram Nova batch: ReadableStream body via AI binding only (prism same; gateway 5006).
  if (isDeepgramBatchStt(gate.model.id)) {
    return runDeepgramBatchStt(ctx, gate, audio, mime);
  }

  // Whisper family: classic models need uint8 array; large-v3-turbo needs base64 string.
  const params = buildSttParams(gate.model.id, audio);
  const up = await runUpstream(ctx, gate, params);
  if (!up.ok) return up.response;
  const fail = providerStateFailed(up.body);
  if (fail) {
    await recordUnmetered(ctx, gate, "provider_failed", 200);
    return errorResponse(ctx.requestId, "upstream_error", fail);
  }
  // Empty string is valid (silent clip); only a missing provider field is an error.
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

/**
 * Deepgram batch STT via `env.AI.run` with stream body. No gateway log id (binding bypass).
 */
async function runDeepgramBatchStt(
  ctx: Ctx,
  gate: NonChatGateOk,
  audioBase64: string,
  mime: string,
): Promise<Response> {
  if (!ctx.env.AI) {
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "Deepgram STT requires the Worker AI binding ([ai] binding = \"AI\").",
    );
  }
  try {
    const params = buildDeepgramSttBindingParams(audioBase64, mime);
    const result = await (
      ctx.env.AI as unknown as { run: (m: string, p: unknown) => Promise<unknown> }
    ).run(gate.model.upstream, params);
    // Empty transcript (silence) is 200 + text:""; only a missing envelope is an error.
    const text = extractTranscript(result);
    if (text === null) {
      await recordUnmetered(ctx, gate, "no_transcript", 200);
      return errorResponse(ctx.requestId, "upstream_error", "STT returned no transcript.");
    }
    return meterAndRespond(ctx, gate, 1, { model: gate.model.id, text }, 200, null);
  } catch (err) {
    // Never return raw provider exception text (CodeQL js/stack-trace-exposure).
    // Log server-side only; clients branch on `code`, not message prose.
    const m = err instanceof Error ? err.message : String(err);
    console.error("stt upstream_error", { requestId: ctx.requestId, message: m.slice(0, 280) });
    await recordUnmetered(ctx, gate, "upstream_error", null);
    const clientMsg =
      m.includes("5006") || m.toLowerCase().includes("bad input")
        ? "STT provider rejected the audio format. Try Whisper Large v3 Turbo, or re-record a short clip."
        : "STT provider request failed.";
    return errorResponse(ctx.requestId, "upstream_error", clientMsg);
  }
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

  // Optional duration (seconds or "8s"); clamped per model (CF limits, see video-duration.ts).
  const durationSec = resolveVideoDuration(gate.model.id, raw.duration ?? raw.seconds).seconds;

  if (wantsAsync(request, raw)) {
    return startAsyncVideoJob(ctx, request, gate, prompt, imageUrl, durationSec);
  }

  const produced = await produceVideo(ctx, request, gate, prompt, imageUrl, durationSec);
  if (!produced.ok) return produced.response;
  return meterAndRespond(
    ctx,
    gate,
    1,
    {
      model: gate.model.id,
      video: produced.video,
      duration: durationSec,
      result: produced.upstreamBody,
    },
    200,
    produced.gatewayLogId,
  );
}

async function startAsyncVideoJob(
  ctx: Ctx,
  request: Request,
  gate: NonChatGateOk,
  prompt: string,
  imageUrl: string | undefined,
  durationSec: number,
): Promise<Response> {
  return startAsyncLongRun(ctx, request, gate, {
    kind: "video",
    prompt,
    lyrics: undefined,
    imageUrl,
    voice: undefined,
    billableUnits: 1,
    durationSec,
  });
}

/**
 * Run upstream video + Grok ZDR rehost wait. Returns asset URL or an error Response.
 */
async function produceVideo(
  ctx: Ctx,
  request: Request,
  gate: NonChatGateOk,
  prompt: string,
  imageUrl: string | undefined,
  durationSec?: number,
): Promise<
  | { ok: true; video: string; gatewayLogId: string | null; upstreamBody: unknown }
  | { ok: false; response: Response }
> {
  // Grok video on CF UB: managed xAI credentials are ZDR. Must supply output.upload_url
  // (xAI PUTs the mp4 to us). See src/media.ts.
  let uploadUrl: string | undefined;
  let downloadUrl: string | undefined;
  let objectKey: string | undefined;
  if (gate.model.id.startsWith("xai/grok-imagine-video")) {
    const secret = mediaSigningSecret(ctx.env);
    if (!ctx.env.MEDIA || !secret) {
      return {
        ok: false,
        response: errorResponse(
          ctx.requestId,
          "unavailable",
          "Grok video requires the MEDIA R2 binding and CF_AIG_TOKEN (ZDR-managed xAI needs output.upload_url). Use Veo or Seedance Fast until configured.",
        ),
      };
    }
    objectKey = newVideoObjectKey(gate.account.id, ctx.requestId);
    const origin = new URL(request.url).origin;
    const upTok = await mintUploadToken(secret, objectKey);
    const downTok = await mintDownloadToken(secret, objectKey);
    uploadUrl = mediaPublicUrl(origin, `/v1/media/ingress/${upTok.token}`);
    downloadUrl = mediaPublicUrl(origin, `/v1/media/${downTok.token}`);
  }

  const params = buildVideoParams(gate.model.id, prompt, imageUrl, {
    uploadUrl,
    durationSec,
  });
  const up = await runUpstream(ctx, gate, params);
  if (!up.ok) return { ok: false, response: up.response };
  const fail = providerStateFailed(up.body);
  if (fail) {
    await recordUnmetered(ctx, gate, "provider_failed", 200);
    return { ok: false, response: errorResponse(ctx.requestId, "upstream_error", fail) };
  }
  let asset = extractVideoAsset(up.body);
  // ZDR: wait for xAI PUT into our R2 before handing the client a URL (AVPlayer 404 otherwise).
  if (downloadUrl && objectKey && ctx.env.MEDIA) {
    const ready = await waitForMediaObject(ctx.env.MEDIA, objectKey, 45_000, 1_000);
    if (ready) {
      asset = downloadUrl;
    } else if (!asset) {
      // Prefer our signed URL even if head is slow; client can retry GET.
      asset = downloadUrl;
    } else {
      // Prefer playable rehost over provider URL when object landed late mid-wait.
      const late = await ctx.env.MEDIA.head(objectKey);
      if (late) asset = downloadUrl;
    }
  }
  if (!asset && downloadUrl) asset = downloadUrl;
  if (!asset) {
    await recordUnmetered(ctx, gate, "no_video_payload", 200);
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "upstream_error",
        "Video generation returned no video payload.",
      ),
    };
  }
  return { ok: true, video: asset, gatewayLogId: up.gatewayLogId, upstreamBody: up.body };
}

export async function handleMusicGenerations(ctx: Ctx, request: Request): Promise<Response> {
  try {
    return await handleMusicGenerationsInner(ctx, request);
  } catch (err) {
    // Catch OOM / JSON / unexpected throws after a long MiniMax wait so the client gets a
    // structured error + request id instead of a bare CF "Internal Server Error".
    console.error("music handler crash", {
      requestId: ctx.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(
      ctx.requestId,
      "internal",
      `Music handler failed after upstream: ${err instanceof Error ? err.message : String(err)}`.slice(
        0,
        280,
      ),
    );
  }
}

async function handleMusicGenerationsInner(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await gateNonChat(ctx, request, "music");
  if (!gate.ok) return gate.response;
  const raw = ((ctx as Ctx & { _nonchatBody?: unknown })._nonchatBody ?? {}) as Record<string, unknown>;
  const prompt = requireString(raw, "prompt");
  if (!prompt) {
    return errorResponse(ctx.requestId, "invalid_request", '"prompt" is required.');
  }
  const lyrics = requireString(raw, "lyrics") ?? undefined;
  const isInstrumental =
    typeof raw.is_instrumental === "boolean" ? raw.is_instrumental : undefined;
  const lyricsOptimizer =
    typeof raw.lyrics_optimizer === "boolean" ? raw.lyrics_optimizer : undefined;

  if (wantsAsync(request, raw)) {
    return startAsyncMusicJob(ctx, request, gate, prompt, lyrics, isInstrumental, lyricsOptimizer);
  }

  const produced = await produceMusic(ctx, request, gate, prompt, lyrics, isInstrumental, lyricsOptimizer);
  if (!produced.ok) return produced.response;
  return meterAndRespond(
    ctx,
    gate,
    1,
    { model: gate.model.id, audio: produced.audio, rehosted: produced.rehosted },
    200,
    produced.gatewayLogId,
  );
}

async function startAsyncMusicJob(
  ctx: Ctx,
  request: Request,
  gate: NonChatGateOk,
  prompt: string,
  lyrics: string | undefined,
  _isInstrumental: boolean | undefined,
  _lyricsOptimizer: boolean | undefined,
): Promise<Response> {
  // Instrumental/lyrics_optimizer defaults are applied again inside the workflow via buildMusicParams.
  return startAsyncLongRun(ctx, request, gate, {
    kind: "music",
    prompt,
    lyrics,
    imageUrl: undefined,
    voice: undefined,
    billableUnits: 1,
  });
}

/**
 * Create D1 job row + Cloudflare Workflow instance (NOT waitUntil).
 * Multi-minute AI.run must use Workflows -- waitUntil dies ~30s after the 202.
 * Covers video, music, speech, and slow image (gpt-image-2).
 */
async function startAsyncLongRun(
  ctx: Ctx,
  request: Request,
  gate: NonChatGateOk,
  args: {
    kind: "video" | "music" | "speech" | "image";
    prompt: string;
    lyrics: string | undefined;
    imageUrl: string | undefined;
    voice: string | undefined;
    billableUnits: number;
    /** Video only: clamped duration seconds. */
    durationSec?: number;
  },
): Promise<Response> {
  if (!ctx.env.LONGRUN) {
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "Long-run Workflow binding is not configured on this deployment. " +
        "Add [[workflows]] LONGRUN / PlaneLongRunWorkflow (see wrangler.example.toml).",
    );
  }

  const now = ctx.now.toISOString();
  const jobId = newId("job");
  const row: AsyncJobRow = {
    id: jobId,
    account_id: gate.account.id,
    client_id: gate.client.id,
    kind: args.kind,
    model_id: gate.model.id,
    status: "running",
    result_json: null,
    error_code: null,
    error_detail: null,
    request_id: ctx.requestId,
    created_at: now,
    updated_at: now,
  };
  await ctx.store.createAsyncJob(row);

  // Stage data: images to MEDIA so the Workflow event stays small (1 MiB cap).
  let imageUrl = args.imageUrl;
  let imageObjectKey: string | undefined;
  if (
    (args.kind === "video" || args.kind === "image") &&
    imageUrl &&
    imageUrl.startsWith("data:") &&
    ctx.env.MEDIA
  ) {
    const staged = await stageDataImage(ctx, gate.account.id, jobId, imageUrl);
    if (staged) {
      imageObjectKey = staged;
      imageUrl = undefined;
    }
  }

  const origin = new URL(request.url).origin;
  try {
    await ctx.env.LONGRUN.create({
      id: jobId,
      params: {
        jobId,
        kind: args.kind,
        modelId: gate.model.id,
        upstreamModel: gate.model.upstream,
        prompt: args.prompt,
        lyrics: args.lyrics,
        voice: args.voice,
        imageUrl,
        imageObjectKey,
        accountId: gate.account.id,
        clientId: gate.client.id,
        planId: gate.account.plan_id,
        requestId: ctx.requestId,
        unitMicroUsd: gate.unitPrice.microUsdPerUnit,
        unit: gate.unitPrice.unit,
        billableUnits: args.billableUnits,
        monthlyIncludedMicroUsd: gate.plan.monthlyIncludedMicroUsd,
        origin,
        startedAtIso: now,
        durationSec: args.durationSec,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.store.updateAsyncJob({
      id: jobId,
      status: "failed",
      error_code: "unavailable",
      error_detail: `Workflow create failed: ${msg}`.slice(0, 280),
      updated_at: new Date().toISOString(),
    });
    return errorResponse(
      ctx.requestId,
      "unavailable",
      `Failed to start long-run workflow: ${msg}`.slice(0, 280),
    );
  }

  console.log("async longrun workflow started", {
    jobId,
    kind: args.kind,
    model: gate.model.id,
    requestId: ctx.requestId,
  });
  return jsonResponse(ctx.requestId, jobToWire(row), { status: 202 });
}

/** Put a data: image into MEDIA; return object key. */
async function stageDataImage(
  ctx: Ctx,
  accountId: string,
  jobId: string,
  dataUrl: string,
): Promise<string | null> {
  if (!ctx.env.MEDIA) return null;
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  const contentType = m[1] || "image/jpeg";
  const b64 = m[2];
  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_MAX_BYTES) return null;
  const key = `video/${accountId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)}/${jobId}-ref`;
  await ctx.env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType },
  });
  return key;
}

async function produceMusic(
  ctx: Ctx,
  request: Request,
  gate: NonChatGateOk,
  prompt: string,
  lyrics: string | undefined,
  isInstrumental: boolean | undefined,
  lyricsOptimizer: boolean | undefined,
): Promise<
  | { ok: true; audio: string; rehosted: boolean; gatewayLogId: string | null }
  | { ok: false; response: Response }
> {
  const params = buildMusicParams(prompt, lyrics, { isInstrumental, lyricsOptimizer });
  const up = await runUpstream(ctx, gate, params);
  if (!up.ok) return { ok: false, response: up.response };
  const fail = providerStateFailed(up.body);
  if (fail) {
    await recordUnmetered(ctx, gate, "provider_failed", 200);
    return { ok: false, response: errorResponse(ctx.requestId, "upstream_error", fail) };
  }
  let asset = extractMusicAsset(up.body);
  if (!asset) {
    await recordUnmetered(ctx, gate, "no_music_payload", 200);
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "upstream_error",
        "Music generation returned no audio payload.",
      ),
    };
  }
  let rehosted = false;
  if (looksLikeHttpUrl(asset)) {
    const hosted = await rehostMusicAudio(ctx, request, gate.account.id, asset);
    if (hosted) {
      asset = hosted;
      rehosted = true;
    }
  }
  return { ok: true, audio: asset, rehosted, gatewayLogId: up.gatewayLogId };
}

function looksLikeHttpUrl(s: string): boolean {
  return s.startsWith("https://") || s.startsWith("http://");
}

/**
 * Fetch provider audio and store under music/… in R2; return signed GET URL.
 * Returns null if MEDIA/signing missing or fetch fails (caller keeps original URL).
 */
async function rehostMusicAudio(
  ctx: Ctx,
  request: Request,
  accountId: string,
  sourceUrl: string,
): Promise<string | null> {
  const secret = mediaSigningSecret(ctx.env);
  if (!ctx.env.MEDIA || !secret) return null;
  try {
    const res = await fetch(sourceUrl, {
      method: "GET",
      headers: { accept: "audio/*,application/octet-stream,*/*" },
      redirect: "follow",
    });
    if (!res.ok) {
      console.error("music rehost fetch failed", {
        requestId: ctx.requestId,
        status: res.status,
      });
      return null;
    }
    // Prefer streaming into R2 when possible (lower peak memory after a long MiniMax wait).
    const contentType = res.headers.get("content-type") ?? "audio/mpeg";
    const objectKey = newMusicObjectKey(accountId, ctx.requestId);
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MEDIA_MAX_BYTES) {
      console.error("music rehost too large", { requestId: ctx.requestId, len });
      return null;
    }
    if (res.body) {
      await ctx.env.MEDIA.put(objectKey, res.body, {
        httpMetadata: { contentType: contentType.split(";")[0]?.trim() || "audio/mpeg" },
      });
    } else {
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > MEDIA_MAX_BYTES) return null;
      await ctx.env.MEDIA.put(objectKey, buf, {
        httpMetadata: { contentType: contentType.split(";")[0]?.trim() || "audio/mpeg" },
      });
    }
    const downTok = await mintDownloadToken(secret, objectKey);
    const origin = new URL(request.url).origin;
    return mediaPublicUrl(origin, `/v1/media/${downTok.token}`);
  } catch (err) {
    console.error("music rehost error", {
      requestId: ctx.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// silence unused import if tree-shaken oddly
void MAX_BODY_BYTES;
void resolvePrice;
