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
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 200) };
      }
    }
    if (!res.ok) {
      const detail =
        typeof body === "object" && body && "errors" in body
          ? JSON.stringify((body as { errors: unknown }).errors).slice(0, 400)
          : text.slice(0, 400);
      return { outcome: "upstream_error", status: res.status, detail: detail || `HTTP ${res.status}` };
    }
    // CF wraps many results as { success, result }
    const unwrapped =
      typeof body === "object" && body !== null && "result" in body
        ? (body as { result: unknown }).result
        : body;
    return { outcome: "ok", body: unwrapped, gatewayLogId: logId, contentType };
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
    return { outcome: "ok", body: result, gatewayLogId: logId, contentType: null };
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

/** Cap user text fields before they hit a provider body. */
const MAX_PROMPT_CHARS = 8_000;
const MAX_AUDIO_B64_CHARS = 4 * 1024 * 1024; // ~3 MiB binary after decode, under body cap

function clipPrompt(prompt: string): string {
  return prompt.length <= MAX_PROMPT_CHARS ? prompt : prompt.slice(0, MAX_PROMPT_CHARS);
}

/** Build default image-gen params (Workers AI + proxied providers). Primitives only. */
export function buildImageParams(modelId: string, prompt: string): Record<string, unknown> {
  prompt = clipPrompt(prompt);
  if (modelId.startsWith("@cf/black-forest-labs/flux-1-schnell")) {
    return { prompt, width: 512, height: 512, steps: 4 };
  }
  if (modelId.startsWith("@cf/black-forest-labs/flux-2")) {
    // Multipart is required for FLUX.2; JSON is rejected. Callers that need FLUX.2
    // should use the AI binding path; REST JSON is best-effort for flux-1 only.
    return { prompt, width: 1024, height: 1024 };
  }
  if (modelId === "@cf/stabilityai/stable-diffusion-xl-base-1.0") {
    return { prompt, width: 1024, height: 1024, num_steps: 20 };
  }
  if (modelId.startsWith("@cf/")) {
    return { prompt, width: 1024, height: 1024, steps: 25 };
  }
  // Unified Billing providers (mirror prism proxied-image-params)
  if (modelId.startsWith("google/")) return { prompt, output_format: "png" };
  if (modelId.startsWith("openai/")) return { prompt, quality: "high", size: "1024x1024" };
  if (modelId.startsWith("xai/")) return { prompt, response_format: "b64_json" };
  if (modelId.startsWith("recraft/") || modelId.startsWith("bytedance/")) return { prompt };
  return { prompt };
}

export function buildTtsParams(modelId: string, text: string): Record<string, unknown> {
  text = clipPrompt(text);
  if (modelId.includes("melotts")) return { prompt: text, lang: "en" };
  // Deepgram aura
  return { text };
}

export function buildSttParams(audioBase64: string): Record<string, unknown> {
  // Only a base64 string; never forward nested objects from the client body.
  const audio =
    audioBase64.length <= MAX_AUDIO_B64_CHARS
      ? audioBase64
      : audioBase64.slice(0, MAX_AUDIO_B64_CHARS);
  return { audio };
}

export function buildVideoParams(modelId: string, prompt: string, imageUrl?: string): Record<string, unknown> {
  prompt = clipPrompt(prompt);
  // imageUrl: only accept data: or https: strings of bounded length (no nested objects).
  let image: string | undefined;
  if (typeof imageUrl === "string" && imageUrl.length > 0 && imageUrl.length <= MAX_AUDIO_B64_CHARS) {
    if (imageUrl.startsWith("data:") || imageUrl.startsWith("https://")) {
      image = imageUrl;
    }
  }
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
    // xAI Grok video i2v: CF 1.5 docs use image: { url }. Duration integer.
    if (modelId.startsWith("xai/grok-imagine-video")) {
      return {
        prompt,
        duration: 5,
        image: { url: image },
      };
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
    // CF 7003 with full field sets observed on this plane (2026-08-05). Use the
    // minimal documented shape: integer duration only. aspect_ratio/resolution
    // optional in schema; omitting them avoids combo validation failures.
    // Image (i2v) uses { url } object per CF docs for 1.5-preview.
    const body: Record<string, unknown> = { prompt, duration: 5 };
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

export function buildMusicParams(prompt: string, lyrics?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: clipPrompt(prompt) };
  if (typeof lyrics === "string" && lyrics.trim()) {
    body.lyrics = clipPrompt(lyrics);
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
  if (typeof r.result === "object" && r.result !== null) {
    return extractTranscript(r.result);
  }
  return typeof r.response === "string" && r.response.length > 0 ? r.response : null;
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
