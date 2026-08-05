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
  // @cf/vendor/name or @cf/vendor/name/variant — no ".." , no empty segments, no query/fragment.
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
  // only via encodeURIComponent which encodes @ as %40 — CF accepts %40cf/ form.
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
    // Minimal i2v shapes; full matrix lives in prism longrun-params.
    if (modelId.startsWith("bytedance/seedance")) {
      return { image, prompt, aspect_ratio: "16:9", duration: 5, resolution: "720p" };
    }
    if (modelId.startsWith("minimax/hailuo")) {
      return { first_frame_image: image, prompt, duration: 6, resolution: "768P" };
    }
    if (modelId.startsWith("runwayml/")) {
      return { image_input: image, prompt, duration: 5 };
    }
    return { image, prompt };
  }
  return {
    prompt,
    duration: "5s",
    aspect_ratio: "16:9",
    resolution: "720p",
  };
}

export function buildMusicParams(prompt: string, lyrics?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: clipPrompt(prompt) };
  if (typeof lyrics === "string" && lyrics.trim()) {
    body.lyrics = clipPrompt(lyrics);
  }
  return body;
}

/** Pull image base64 from various CF / provider shapes. */
export function extractImageBase64(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (typeof r.image === "string" && r.image.length > 0) {
    return stripDataUrl(r.image);
  }
  if (Array.isArray(r.images) && typeof r.images[0] === "string") {
    return stripDataUrl(r.images[0]);
  }
  const result = r.result;
  if (typeof result === "object" && result !== null) {
    return extractImageBase64(result);
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
  if (typeof r.text === "string") return r.text;
  if (typeof r.transcript === "string") return r.transcript;
  if (typeof r.result === "object" && r.result !== null) {
    return extractTranscript(r.result);
  }
  // whisper sometimes returns { text, word_count, ... } at top after unwrap
  if (typeof r.vtt === "string" && typeof r.text !== "string") {
    // some shapes
  }
  return typeof r.response === "string" ? r.response : null;
}

// Silence unused import warning for GATEWAY_HOST if not used
void GATEWAY_HOST;
