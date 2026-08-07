// Non-chat upstream runner: image / tts / stt / video / music via REST ai/run or optional AI binding.
//
// PATH CHOICE (measured 2026-08-05):
//   @cf/* models  -> REST `POST /accounts/{id}/ai/run/{model}` + Authorization + cf-aig-gateway-id
//                    (same authenticated path LLaVA uses; gateway host workers-ai/* 401s our token).
//   provider/*    -> env.AI binding with gateway id (Unified Billing). REST has no route for these
//                    ids; without the binding the door answers 503 unavailable, not 501.
//
// No prompt/completion bodies are logged (cf-aig-collect-log-payload: false).

import { findModel, type Billing, type Modality } from "./catalog";
import { CF_API_HOST, GATEWAY_HOST } from "./upstream";
import type { UpstreamAuth } from "./inference";

export interface NonChatRunRequest {
  upstreamModel: string;
  billing: Billing;
  modality: Modality;
  /** Native body for the model (prompt, audio, etc.). Never logged. */
  params: Record<string, unknown>;
  auth: UpstreamAuth;
  metadata: Record<string, string>;
}

export type NonChatRunResult =
  | { outcome: "ok"; body: unknown; gatewayLogId: string | null; contentType: string | null }
  | { outcome: "upstream_error"; status: number | null; detail: string }
  | { outcome: "timeout"; waitedMs: number }
  | { outcome: "unavailable"; detail: string };

export interface NonChatRunnerDeps {
  accountId: string;
  gatewayId: string;
  timeoutMs: number;
  collectLog: boolean;
  /** Optional Workers AI binding for Unified Billing non-@cf models. */
  ai?: Ai;
  fetchImpl?: typeof fetch;
}

export interface NonChatRunner {
  run(request: NonChatRunRequest): Promise<NonChatRunResult>;
}

function isCfModel(id: string): boolean {
  return id.startsWith("@cf/");
}

/**
 * Workers AI model path segment. Rejects path traversal and characters that would
 * rewrite the REST URL. Callers must already have resolved the id from the catalog;
 * this is defense-in-depth, not a substitute for the allowlist.
 */
export function safeCfRunPath(modelId: string): string | null {
  if (!isCfModel(modelId)) return null;
  // @cf/vendor/name or @cf/vendor/name/variant -- no ".." , no empty segments, no query/fragment.
  if (
    modelId.includes("..") ||
    modelId.includes("//") ||
    modelId.includes("\\") ||
    modelId.includes("?") ||
    modelId.includes("#") ||
    modelId.includes("%") ||
    !/^@cf\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(modelId)
  ) {
    return null;
  }
  // Encode each path segment; keep '/' separators. '@' stays unencoded in the first segment
  // only via encodeURIComponent which encodes @ as %40 -- CF accepts %40cf/ form.
  return modelId
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * Only catalog-known ids may leave this plane. `upstreamModel` must equal some entry's
 * `upstream` (and normally its `id`). Regex path safety is not a substitute for the allowlist.
 */
export function assertCatalogUpstream(upstreamModel: string): boolean {
  const entry = findModel(upstreamModel);
  if (!entry) return false;
  return entry.upstream === upstreamModel || entry.id === upstreamModel;
}

export function nonChatRunnerFor(deps: NonChatRunnerDeps): NonChatRunner {
  const doFetch = deps.fetchImpl ?? fetch;

  return {
    async run(request: NonChatRunRequest): Promise<NonChatRunResult> {
      if (!assertCatalogUpstream(request.upstreamModel)) {
        return {
          outcome: "upstream_error",
          status: null,
          detail: `Model id is not in the catalog allowlist: ${request.upstreamModel.slice(0, 80)}`,
        };
      }
      // Prefer catalog upstream field if id was used.
      const entry = findModel(request.upstreamModel)!;
      const normalized: NonChatRunRequest = {
        ...request,
        upstreamModel: entry.upstream,
        billing: entry.billing,
        modality: entry.modality,
      };

      if (isCfModel(normalized.upstreamModel)) {
        return runViaRest(doFetch, deps, normalized);
      }
      if (!deps.ai) {
        return {
          outcome: "unavailable",
          detail:
            "Unified Billing non-chat models require the Worker AI binding. " +
            "Add [ai] binding = \"AI\" to wrangler config, or use a Workers AI (@cf/) model.",
        };
      }
      return runViaBinding(deps, normalized);
    },
  };
}

async function runViaRest(
  doFetch: typeof fetch,
  deps: NonChatRunnerDeps,
  request: NonChatRunRequest,
): Promise<NonChatRunResult> {
  const pathModel = safeCfRunPath(request.upstreamModel);
  if (!pathModel) {
    return {
      outcome: "upstream_error",
      status: null,
      detail: `Refusing REST run for model id that is not a safe Workers AI path: ${request.upstreamModel.slice(0, 80)}`,
    };
  }
  const url = `${CF_API_HOST}/client/v4/accounts/${deps.accountId}/ai/run/${pathModel}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${request.auth.value}`,
    "cf-aig-gateway-id": deps.gatewayId,
    "cf-aig-collect-log-payload": "false",
    "cf-aig-collect-log": deps.collectLog ? "true" : "false",
    "cf-aig-metadata": JSON.stringify(request.metadata),
    "content-type": "application/json",
    accept: "application/json",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request.params),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const logId = res.headers.get("cf-aig-log-id");
    const contentType = res.headers.get("content-type");
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 400);
      try {
        const j = JSON.parse(text) as { errors?: unknown };
        if (j.errors) detail = JSON.stringify(j.errors).slice(0, 400);
      } catch {
        /* keep text */
      }
      return { outcome: "upstream_error", status: res.status, detail: detail || `HTTP ${res.status}` };
    }
    // Aura-2 / some TTS models return raw audio/mpeg (not JSON). Gateway logs show
    // response_content_type: audio/mpeg; parsing as text then extractAudioBase64 → "no audio".
    if (contentTypeLooksBinaryAudio(contentType)) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) {
        return {
          outcome: "upstream_error",
          status: res.status,
          detail: "TTS returned empty audio body",
        };
      }
      return {
        outcome: "ok",
        body: { audio: bytesToBase64(new Uint8Array(buf)) },
        gatewayLogId: logId,
        contentType,
      };
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 200) };
      }
    }
    // CF wraps many results as { success, result }
    const unwrapped =
      typeof body === "object" && body !== null && "result" in body
        ? (body as { result: unknown }).result
        : body;
    // Binding-shaped result may still be binary-in-JSON or a nested audio field.
    const normalized = await normalizeNonChatBody(unwrapped);
    return { outcome: "ok", body: normalized, gatewayLogId: logId, contentType };
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    if (aborted) return { outcome: "timeout", waitedMs: deps.timeoutMs };
    return {
      outcome: "upstream_error",
      status: null,
      detail: String(err instanceof Error ? err.message : err).slice(0, 400),
    };
  }
}

async function runViaBinding(
  deps: NonChatRunnerDeps,
  request: NonChatRunRequest,
): Promise<NonChatRunResult> {
  const ai = deps.ai!;
  try {
    // Workers AI binding: gateway option routes through prism-proxy for logs.
    type RunFn = (
      model: string,
      params: unknown,
      opts?: { gateway?: { id: string }; returnRawResponse?: boolean },
    ) => Promise<unknown>;
    const result = await Promise.race([
      (ai as unknown as { run: RunFn }).run(request.upstreamModel, request.params, {
        gateway: { id: deps.gatewayId },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), deps.timeoutMs);
      }),
    ]);
    const logId =
      (ai as unknown as { aiGatewayLogId?: string }).aiGatewayLogId ?? null;
    const body = await normalizeNonChatBody(result);
    return { outcome: "ok", body, gatewayLogId: logId, contentType: null };
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    if (aborted) return { outcome: "timeout", waitedMs: deps.timeoutMs };
    return {
      outcome: "upstream_error",
      status: null,
      detail: String(err instanceof Error ? err.message : err).slice(0, 400),
    };
  }
}

function contentTypeLooksBinaryAudio(contentType: string | null): boolean {
  if (!contentType) return false;
  const c = contentType.toLowerCase();
  return (
    c.includes("audio/") ||
    c.includes("application/octet-stream") ||
    c.includes("application/mpeg")
  );
}

/** Convert binary TTS (stream / buffer) into `{ audio: base64 }` for extractAudioBase64. */
async function normalizeNonChatBody(body: unknown): Promise<unknown> {
  if (body == null) return body;
  if (body instanceof ArrayBuffer) {
    return { audio: bytesToBase64(new Uint8Array(body)) };
  }
  if (body instanceof Uint8Array) {
    return { audio: bytesToBase64(body) };
  }
  // Workers AI Aura binding returns ReadableStream of MPEG bytes.
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    const buf = await streamToUint8Array(body as ReadableStream<Uint8Array>);
    if (buf.byteLength === 0) return body;
    return { audio: bytesToBase64(buf) };
  }
  return body;
}

function bytesToBase64(u8: Uint8Array): string {
  // Chunk to avoid call-stack limits on large mp3s.
  const chunk = 0x8000;
  let s = "";
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

async function streamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Cap user text fields before they hit a provider body. */
const MAX_PROMPT_CHARS = 8_000;
const MAX_AUDIO_B64_CHARS = 4 * 1024 * 1024; // ~3 MiB binary after decode, under body cap

function clipPrompt(prompt: string): string {
  return prompt.length <= MAX_PROMPT_CHARS ? prompt : prompt.slice(0, MAX_PROMPT_CHARS);
}

/**
 * Flux 2 input_image_* fields want raw base64 (or binary via multipart).
 * Accept data: URLs from clients and strip the prefix; leave https URLs as-is
 * (some CF paths reject remote fetch -- client should prefer data: for Flux).
 */
function stripDataUrlToBase64(image: string): string {
  const m = /^data:[^;]+;base64,(.+)$/i.exec(image);
  return m ? m[1] : image;
}

/**
 * Build image-gen params (Workers AI + proxied providers). Primitives only.
 *
 * `imageUrl` is an optional reference (https or data:) for i2i / edit paths.
 * Field name varies by provider (image, images[], image_input[]).
 */
export function buildImageParams(
  modelId: string,
  prompt: string,
  imageUrl?: string,
): Record<string, unknown> {
  prompt = clipPrompt(prompt);
  let image: string | undefined;
  if (typeof imageUrl === "string" && imageUrl.length > 0 && imageUrl.length <= MAX_AUDIO_B64_CHARS) {
    if (imageUrl.startsWith("data:") || imageUrl.startsWith("https://") || imageUrl.startsWith("http://")) {
      image = imageUrl;
    }
  }

  if (modelId.startsWith("@cf/black-forest-labs/flux-1-schnell")) {
    // Pure t2i on Workers AI; no image-input schema. Ignore ref if client sent one.
    return { prompt, width: 512, height: 512, steps: 4 };
  }
  if (modelId.startsWith("@cf/black-forest-labs/flux-2")) {
    // Multi-reference family: CF schema is input_image_0..3 (binary / base64).
    // Full multi-ref wants multipart (prism playground path); single ref via JSON is best-effort.
    const body: Record<string, unknown> = { prompt, width: 1024, height: 1024 };
    if (image) body.input_image_0 = stripDataUrlToBase64(image);
    return body;
  }
  if (modelId === "@cf/stabilityai/stable-diffusion-xl-base-1.0") {
    // Pure t2i; no image-input on this binding.
    return { prompt, width: 1024, height: 1024, num_steps: 20 };
  }
  if (modelId.startsWith("@cf/")) {
    // Leonardo / Dreamshaper / etc.: pure t2i on Workers AI.
    return { prompt, width: 1024, height: 1024, steps: 25 };
  }
  // Unified Billing providers (mirror prism proxied-image-params + CF image_input shapes)
  if (modelId.startsWith("google/")) {
    const body: Record<string, unknown> = { prompt, output_format: "png" };
    // nano-banana family: image_input[] for reference images
    if (image) body.image_input = [image];
    return body;
  }
  if (modelId.startsWith("openai/")) {
    // CF proxy schema: { prompt, images, quality, size, style }
    const body: Record<string, unknown> = { prompt, quality: "high", size: "1024x1024" };
    if (image) body.images = [image];
    return body;
  }
  if (modelId.startsWith("xai/")) {
    // Grok Imagine: optional image object for edit / i2i
    const body: Record<string, unknown> = { prompt, response_format: "b64_json" };
    if (image) body.image = { url: image };
    return body;
  }
  if (modelId.startsWith("recraft/") || modelId.startsWith("bytedance/")) {
    const body: Record<string, unknown> = { prompt };
    if (image) body.image = image;
    return body;
  }
  const body: Record<string, unknown> = { prompt };
  if (image) body.image = image;
  return body;
}

/**
 * TTS body for Workers AI / Deepgram Aura and MeloTTS.
 *
 * Aura-2 rejects requests without a voice (runtime: "Must provide a voice parameter").
 * CF docs name the field `speaker` (default luna); Deepgram native often uses `voice`.
 * Send both with the same value so either schema path is happy.
 */
export function buildTtsParams(
  modelId: string,
  text: string,
  opts?: { voice?: string },
): Record<string, unknown> {
  text = clipPrompt(text);
  if (modelId.includes("melotts")) {
    return { prompt: text, lang: "en" };
  }
  // Deepgram aura-1 / aura-2
  const speaker =
    typeof opts?.voice === "string" && opts.voice.trim()
      ? opts.voice.trim().toLowerCase()
      : "luna";
  return {
    text,
    speaker,
    voice: speaker,
    encoding: "mp3",
  };
}

/**
 * Build Workers AI STT params. Schema differs by model (verified 2026-08-06 CF schemas):
 * - `@cf/openai/whisper` / `whisper-tiny-en`: `{ audio: number[] }` uint8 0-255 (file bytes)
 * - `@cf/openai/whisper-large-v3-turbo`: `{ audio: base64 string }`
 * - `@cf/deepgram/*`: not JSON over REST; use {@link buildDeepgramSttBindingParams} + AI binding
 *
 * Sending base64 to classic whisper yields AIError 5006:
 * "Type mismatch of '/audio', 'array' not in 'string'".
 */
export function buildSttParams(modelId: string, audioBase64: string): Record<string, unknown> {
  const audio =
    audioBase64.length <= MAX_AUDIO_B64_CHARS
      ? audioBase64
      : audioBase64.slice(0, MAX_AUDIO_B64_CHARS);

  if (isClassicWhisperUint8Model(modelId)) {
    const bytes = base64ToBytes(audio);
    // Cap array size so we do not OOM the Worker JSON-encoding multi-MB clips.
    // 3 MiB raw is already above the plane body cap after base64 expansion.
    return { audio: Array.from(bytes) };
  }

  // large-v3-turbo (+ any future base64-string Whisper variants)
  return { audio };
}

/** Classic whisper models whose schema requires `audio: number[]` (uint8), not base64. */
export function isClassicWhisperUint8Model(modelId: string): boolean {
  return (
    modelId === "@cf/openai/whisper" ||
    modelId === "@cf/openai/whisper-tiny-en" ||
    modelId.endsWith("/whisper") ||
    modelId.endsWith("/whisper-tiny-en")
  );
}

export function isDeepgramBatchStt(modelId: string): boolean {
  return modelId.startsWith("@cf/deepgram/") && !modelId.includes("flux");
}

/**
 * Deepgram Nova (batch) over the AI binding: `{ audio: { body: ReadableStream, contentType } }`.
 * Gateway does not accept ReadableStreams (5006); call `env.AI.run` directly (prism same).
 */
export function buildDeepgramSttBindingParams(
  audioBase64: string,
  mime: string,
): { audio: { body: ReadableStream<Uint8Array>; contentType: string } } {
  const audio =
    audioBase64.length <= MAX_AUDIO_B64_CHARS
      ? audioBase64
      : audioBase64.slice(0, MAX_AUDIO_B64_CHARS);
  const bytes = base64ToBytes(audio);
  const contentType = mime && mime.startsWith("audio/") ? mime : "audio/mpeg";
  return {
    audio: {
      body: new Response(bytes).body as ReadableStream<Uint8Array>,
      contentType,
    },
  };
}

export function base64ToBytes(b64: string): Uint8Array {
  // Strip whitespace that sometimes sneaks in from client encoding.
  const clean = b64.replace(/\s/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface BuildVideoParamsOpts {
  /**
   * Absolute URL xAI PUTs the finished mp4 to. Required on CF Unified Billing for Grok video:
   * managed xAI credentials are a ZDR team and refuse without output.upload_url.
   */
  uploadUrl?: string;
}

export function buildVideoParams(
  modelId: string,
  prompt: string,
  imageUrl?: string,
  opts?: BuildVideoParamsOpts,
): Record<string, unknown> {
  prompt = clipPrompt(prompt);
  // imageUrl: only accept data: or https: strings of bounded length (no nested objects).
  let image: string | undefined;
  if (typeof imageUrl === "string" && imageUrl.length > 0 && imageUrl.length <= MAX_AUDIO_B64_CHARS) {
    if (imageUrl.startsWith("data:") || imageUrl.startsWith("https://")) {
      image = imageUrl;
    }
  }
  const uploadUrl =
    typeof opts?.uploadUrl === "string" &&
    opts.uploadUrl.length > 0 &&
    opts.uploadUrl.length <= 2048 &&
    (opts.uploadUrl.startsWith("https://") || opts.uploadUrl.startsWith("http://"))
      ? opts.uploadUrl
      : undefined;

  if (image) {
    // Per-model i2v shapes (mirror prism longrun-params; additionalProperties is false upstream).
    if (modelId.startsWith("bytedance/seedance")) {
      return {
        image,
        prompt,
        aspect_ratio: "16:9",
        duration: 5,
        resolution: "720p",
        fps: 24,
        camera_fixed: false,
        watermark: false,
        generate_audio: false,
      };
    }
    if (modelId.startsWith("minimax/hailuo")) {
      return {
        first_frame_image: image,
        prompt,
        duration: 6,
        resolution: "768P",
        fast_pretreatment: false,
        prompt_optimizer: true,
      };
    }
    if (modelId.startsWith("runwayml/")) {
      return {
        image_input: image,
        prompt,
        duration: 5,
        ratio: "1280:720",
        content_moderation: { public_figure_threshold: "low" },
      };
    }
    if (
      modelId === "alibaba/hh1-i2v" ||
      modelId === "alibaba/hh1.1-i2v" ||
      modelId === "alibaba/wan-2.7-i2v"
    ) {
      const params: Record<string, unknown> = { image, resolution: "720P", duration: 5 };
      if (prompt) params.prompt = prompt;
      return params;
    }
    // xAI Grok video i2v: image as { url } object (CF docs); duration integer.
    // ZDR-managed credentials also require output.upload_url.
    if (modelId.startsWith("xai/grok-imagine-video")) {
      const body: Record<string, unknown> = {
        prompt,
        duration: 5,
        aspect_ratio: "16:9",
        resolution: "720p",
        image: { url: image },
      };
      if (uploadUrl) body.output = { upload_url: uploadUrl };
      return body;
    }
    return { image, prompt };
  }

  // text-to-video: per-model. Wrong duration type or extra fields => CF 7003 User Input Error
  // (schemas are additionalProperties:false on most UB video models).
  //
  // MiniMax Hailuo is **i2v only** (first_frame_image required on CF). Callers must pass image;
  // the video handler should reject prompt-only Hailuo before we get here.
  if (modelId.startsWith("minimax/hailuo")) {
    return {
      prompt,
      duration: 6,
      resolution: "768P",
      prompt_optimizer: true,
      // Missing first_frame_image => upstream 7003; prefer invalid_request in the handler.
      first_frame_image: "",
    };
  }
  if (modelId.startsWith("xai/grok-imagine-video")) {
    // CF docs env.AI.run example + ZDR output.upload_url (required on UB-managed xAI keys).
    // Avoid _operation — some gateway paths reject it with 7003. Integer duration 1-15.
    const body: Record<string, unknown> = {
      prompt,
      duration: 5,
      aspect_ratio: "16:9",
      resolution: "720p",
    };
    if (uploadUrl) body.output = { upload_url: uploadUrl };
    return body;
  }
  if (modelId.startsWith("bytedance/seedance")) {
    // CF seedance-2.0-mini schema: duration/resolution/aspect_ratio/fps/camera_fixed/watermark required
    return {
      prompt,
      aspect_ratio: "16:9",
      duration: 5,
      resolution: "720p",
      fps: 24,
      camera_fixed: false,
      watermark: false,
    };
  }
  if (modelId.startsWith("runwayml/")) {
    return {
      prompt,
      duration: 5,
      ratio: "1280:720",
      content_moderation: { public_figure_threshold: "low" },
    };
  }
  if (
    modelId === "alibaba/hh1-t2v" ||
    modelId === "alibaba/hh1.1-t2v" ||
    modelId.startsWith("alibaba/")
  ) {
    return {
      prompt,
      resolution: "720P",
      duration: 5,
    };
  }
  // Google Veo and other long-run UB: duration STRING + generate_audio (prism longrun default)
  return {
    prompt,
    duration: "8s",
    aspect_ratio: "16:9",
    resolution: "720p",
    generate_audio: true,
  };
}

/**
 * MiniMax Music 2.6 (CF Workers AI / Unified Billing) body.
 *
 * CF schema marks `is_instrumental` and `lyrics_optimizer` as required booleans.
 * Sending only `{ prompt }` returns provider **7003 User Input Error** (measured
 * 2026-08-06 on iOS More → Music). Defaults in CF docs are not applied when the
 * fields are omitted from the JSON body.
 *
 * Contract reference: https://developers.cloudflare.com/ai/models/minimax/music-2.6/
 * - instrumental: `is_instrumental: true`, `lyrics_optimizer: false`
 * - song + lyrics: `is_instrumental: false`, `lyrics`, `lyrics_optimizer: false`
 * - song, auto lyrics: `is_instrumental: false`, `lyrics_optimizer: true`
 */
export function buildMusicParams(
  prompt: string,
  lyrics?: string,
  opts?: { isInstrumental?: boolean; lyricsOptimizer?: boolean },
): Record<string, unknown> {
  const hasLyrics = typeof lyrics === "string" && lyrics.trim().length > 0;
  let isInstrumental: boolean;
  if (typeof opts?.isInstrumental === "boolean") {
    isInstrumental = opts.isInstrumental;
  } else if (hasLyrics) {
    isInstrumental = false;
  } else {
    // Mobile style-only prompts (no lyrics field) → instrumental by default.
    isInstrumental = true;
  }
  let lyricsOptimizer: boolean;
  if (typeof opts?.lyricsOptimizer === "boolean") {
    lyricsOptimizer = opts.lyricsOptimizer;
  } else if (hasLyrics || isInstrumental) {
    lyricsOptimizer = false;
  } else {
    // Vocal track without client lyrics: let the model write them.
    lyricsOptimizer = true;
  }
  const body: Record<string, unknown> = {
    prompt: clipPrompt(prompt),
    is_instrumental: isInstrumental,
    lyrics_optimizer: lyricsOptimizer,
    format: "mp3",
  };
  if (hasLyrics) {
    body.lyrics = clipPrompt(lyrics!.trim());
  }
  return body;
}

/**
 * Image asset from provider body. Many UB providers return an **https URL**, not base64.
 * Callers must not stuff URLs into `b64_json` (iOS clients base64-decode that field).
 */
export function extractImageAsset(body: unknown): { b64_json?: string; url?: string } | null {
  const raw = extractImageRaw(body);
  if (!raw) return null;
  if (raw.startsWith("https://") || raw.startsWith("http://")) {
    return { url: raw };
  }
  if (raw.startsWith("data:image/")) {
    return { b64_json: stripDataUrl(raw) };
  }
  // bare base64 (no data: prefix)
  return { b64_json: raw };
}

/** @deprecated Prefer extractImageAsset — this may return a URL string. */
export function extractImageBase64(body: unknown): string | null {
  return extractImageRaw(body);
}

function extractImageRaw(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (typeof r.image === "string" && r.image.length > 0) {
    return r.image;
  }
  if (typeof r.url === "string" && r.url.length > 0 && r.url.startsWith("http")) {
    return r.url;
  }
  if (Array.isArray(r.images) && typeof r.images[0] === "string") {
    return r.images[0];
  }
  // OpenAI-ish { data: [{ b64_json | url }] }
  if (Array.isArray(r.data) && r.data[0] && typeof r.data[0] === "object") {
    const d = r.data[0] as Record<string, unknown>;
    if (typeof d.b64_json === "string" && d.b64_json.length > 0) return d.b64_json;
    if (typeof d.url === "string" && d.url.length > 0) return d.url;
  }
  const result = r.result;
  if (typeof result === "object" && result !== null) {
    return extractImageRaw(result);
  }
  return null;
}

function stripDataUrl(s: string): string {
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(s);
  return m ? m[1] : s;
}

export function extractAudioBase64(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (typeof r.audio === "string") return r.audio;
  if (typeof r.result === "object" && r.result !== null) {
    const inner = r.result as Record<string, unknown>;
    if (typeof inner.audio === "string") return inner.audio;
  }
  return null;
}

export function extractTranscript(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (typeof r.text === "string" && r.text.length > 0) return r.text;
  if (typeof r.transcript === "string" && r.transcript.length > 0) return r.transcript;
  // Deepgram Nova native envelope
  const dg = extractDeepgramTranscript(body);
  if (dg) return dg;
  if (typeof r.result === "object" && r.result !== null) {
    return extractTranscript(r.result);
  }
  return typeof r.response === "string" && r.response.length > 0 ? r.response : null;
}

/** Deepgram results.channels[0].alternatives[0].transcript (and flat fallbacks). */
export function extractDeepgramTranscript(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as {
    results?: {
      channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
      alternatives?: Array<{ transcript?: string }>;
    };
    text?: string;
    transcript?: string;
  };
  const viaChannels = r.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof viaChannels === "string" && viaChannels.trim()) return viaChannels.trim();
  const viaAlternatives = r.results?.alternatives?.[0]?.transcript;
  if (typeof viaAlternatives === "string" && viaAlternatives.trim()) return viaAlternatives.trim();
  if (typeof r.transcript === "string" && r.transcript.trim()) return r.transcript.trim();
  if (typeof r.text === "string" && r.text.trim()) return r.text.trim();
  return null;
}

/**
 * Reject provider envelopes that look like failures before we meter.
 * Unified Billing long-run shapes use `state: "Completed" | "Failed" | ...`.
 */
export function providerStateFailed(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (typeof r.error === "string" && r.error.length > 0) return r.error.slice(0, 200);
  if (typeof r.state === "string" && r.state !== "Completed" && r.state !== "succeeded") {
    return `provider state "${r.state}"`;
  }
  if (typeof r.success === "boolean" && r.success === false) {
    return "provider success=false";
  }
  return null;
}

/**
 * Video URL or inline payload. Mirrors prism LongRunWorkflow:
 *   { state, result: { video: "https://..." } }
 */
export function extractVideoAsset(body: unknown): string | null {
  const fail = providerStateFailed(body);
  if (fail) return null;
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (typeof r.video === "string" && r.video.length > 0) return r.video;
  const result = r.result;
  if (typeof result === "object" && result !== null) {
    const inner = result as Record<string, unknown>;
    if (typeof inner.video === "string" && inner.video.length > 0) return inner.video;
    if (typeof inner.url === "string" && inner.url.length > 0) return inner.url;
  }
  if (typeof r.url === "string" && r.url.length > 0) return r.url;
  return null;
}

/**
 * Music/audio URL or base64. Mirrors prism:
 *   { state, result: { audio } } or flat { audio }
 */
export function extractMusicAsset(body: unknown): string | null {
  const fail = providerStateFailed(body);
  if (fail) return null;
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (typeof r.audio === "string" && r.audio.length > 0) return r.audio;
  const result = r.result;
  if (typeof result === "object" && result !== null) {
    const inner = result as Record<string, unknown>;
    if (typeof inner.audio === "string" && inner.audio.length > 0) return inner.audio;
    if (typeof inner.url === "string" && inner.url.length > 0) return inner.url;
  }
  if (typeof r.url === "string" && r.url.length > 0) return r.url;
  return null;
}

// Silence unused import warning for GATEWAY_HOST if not used
void GATEWAY_HOST;
