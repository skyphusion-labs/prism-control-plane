// The one place a model is actually called.
//
// THE URL IS THE GATEWAY. Every call goes to
// `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/...`, never to the AI REST API on
// `api.cloudflare.com` that the previous version of this file used. Issue #15. What that move buys, in
// descending order of how much it is worth:
//
//   1. A PER-REQUEST TRANSIT RECEIPT. `cf-aig-log-id` comes back on EVERY served response from this
//      host, streamed or not (measured 2026-08-05; the note in prism's README that the gateway does not
//      surface it on SSE is stale for this endpoint). The REST path returns no `cf-aig-*` response
//      headers at all, so "did this request go through our gateway" could only be inferred there. A
//      plane that has quietly stopped going through its gateway otherwise looks exactly like one that
//      has not, and the check below is what makes the gap visible.
//   2. `usage_events.gateway_log_id` BECOMES POPULATABLE. This is a DEBUGGING JOIN, not a
//      reconciliation prerequisite, and conflating the two is how #15 first got misread.
//      `src/reconcile.ts` joins a gateway row to a ledger row on `cf-aig-metadata.request_id`, and the
//      REST path emitted those rows with metadata and `cost` intact. Reconciliation worked before this
//      change and works after it. What the log id adds is a direct row-level handle when a single
//      request needs chasing.
//   3. THE CREDENTIAL CAN NARROW. This endpoint needs `AI Gateway Run`; the REST endpoint also wanted
//      `Workers AI Read` (see `CF_AIG_TOKEN` in src/env.ts). One fewer permission on a spendable token.
//   4. ON `/compat`, THE PLAIN `authorization` HEADER IS THE PROVIDER KEY SLOT, so keeping the
//      Cloudflare token out of it is a constraint OF this path rather than a flaw of the old one. See
//      the credential note below.
//
// WHAT THIS CHANGE IS NOT: A SECURITY FIX. The REST path was authenticated. Cloudflare's Authenticated
// Gateway doc is explicit that the credential slot differs by surface -- the REST API on
// `api.cloudflare.com` reads the standard `Authorization` header, and only the provider-native
// endpoints on `gateway.ai.cloudflare.com` read `cf-aig-authorization`. The old code sent a valid token
// in `Authorization` as well, so `prism-proxy` (`authentication: true`) was authenticating it the whole
// time. The 2026-08-05 probe that appeared to show a bypass varied `cf-aig-authorization` while leaving
// a valid `Authorization` in place, which is the wrong slot: a 200 there is the DOCUMENTED outcome of a
// correctly authenticated request, not an unenforced gate. The control probe confirms it -- REST with a
// bad or absent `Authorization` is refused 401 (code 10000), and the gateway host with no
// `cf-aig-authorization` is refused 401 (`AiGatewayError` 2009), so both surfaces authenticate and
// neither is anonymously reachable. Do not re-file #15 as a security issue.
// https://developers.cloudflare.com/ai-gateway/configuration/authentication/
//
// THE TRADE, STATED RATHER THAN OMITTED. Cloudflare recommends the REST API for NEW integrations and
// describes the `gateway.ai.cloudflare.com` endpoints as continuing to work, so this file deliberately
// sits on the softer-deprecated surface, and it does so to buy the receipt in (1). That is also where
// every sibling on this estate already is: common-thread, prism's third-party dispatch, and the
// vivijure tenant modules all address the gateway host with `cf-aig-authorization`. Revisit if
// Cloudflare either starts returning `cf-aig-*` receipts on the REST path or announces a sunset here.
//
// WHY THE GATEWAY HTTP PATH AND NOT THE `env.AI` BINDING. The binding hard-codes one identity, the
// Worker's, and is pre-authenticated within the account. An HTTP call takes its credential as a
// per-request ARGUMENT, which is what lets this plane run either a shared account credential or a
// per-user minted one without a second code path.
//
// TWO ENDPOINTS, ONE PER BILLING SURFACE, chosen from the catalog's `billing` field rather than by
// sniffing the model id:
//   workers-ai      -> /workers-ai/v1/chat/completions   the provider-native Workers AI endpoint,
//                                                        called with the raw `@cf/...` id.
//   unified-billing -> /compat/chat/completions          the OpenAI-shaped door that accepts a
//                                                        `provider/model` id and bills through
//                                                        Unified Billing.
// Both take the body this file already builds, so the split is a URL, not a second request shape.
//
// THE CREDENTIAL GOES IN `cf-aig-authorization` AND NOWHERE ELSE. On `/compat` the plain `authorization`
// header is the PROVIDER key slot: a value there is forwarded upstream as BYOK and flips the request off
// Unified Billing. Putting our Cloudflare API token in it would mean handing a Cloudflare credential to
// Anthropic or OpenAI to be rejected, which is a credential disclosure with no upside. Keyless is also
// measurably sufficient on both endpoints (verified 2026-08-05 with no `authorization` header at all),
// and it is the same posture prism's own provider dispatch has used since v0.93.0.
//
// THE TWO LOG SWITCHES ARE NOT THE SAME SWITCH, and conflating them costs either privacy or observability:
//
//   cf-aig-collect-log-payload: false   drops the prompt and completion BODIES, keeping token counts, model,
//                                       provider, status, cost and duration. HARD-WIRED FALSE HERE, with no
//                                       env override, because "we do not retain prompts" is an invariant of
//                                       this plane and an invariant that can be switched off in config is a
//                                       default. This is the line that must not move.
//   cf-aig-collect-log: false           drops the entire row, metadata included.
//
// So payloads never persist, and the cost metadata is kept by default -- which is what makes Cloudflare's own
// per-request cost figure available to reconcile against our ledger. A metering plane that cannot check its
// own arithmetic against the biller's is trusting itself for no reason.
// https://developers.cloudflare.com/ai-gateway/observability/logging/

import { openAIStreamFromDeferredCompletion } from "./anthropic-sse-to-openai";
import { findModel, type Billing } from "./catalog";
import { gatewayConfig, upstreamTimeoutMs, type Env } from "./env";
import { extractText, type InferenceRequest, type InferenceResult, type InferenceRunner } from "./inference";
import { extractUsage } from "./meter";

/** The AI Gateway host. A constant so the anti-bypass test has one literal to pin. */
export const GATEWAY_HOST = "https://gateway.ai.cloudflare.com";
/** Cloudflare REST AI host. LLaVA's native image-to-text path is only authenticated here (measured). */
export const CF_API_HOST = "https://api.cloudflare.com";

export interface GatewayRunnerDeps {
  accountId: string;
  gatewayId: string;
  timeoutMs: number;
  collectLog: boolean;
  fetchImpl?: typeof fetch;
  /**
   * Workers AI binding. Required for catalog `binding: true` chat models (Fable, Grok 4.5).
   * Absent: those models return upstream_error rather than falling back to broken /compat.
   */
  ai?: Ai;
}

/**
 * The endpoint suffix for a billing surface.
 *
 * A total switch on the union rather than a default branch: adding a third billing surface to the
 * catalog then fails the typecheck here, which is the right place to be asked which door it uses.
 */
export function endpointFor(billing: Billing): string {
  switch (billing) {
    case "workers-ai":
      return "workers-ai/v1/chat/completions";
    case "unified-billing":
      return "compat/chat/completions";
  }
}

/**
 * The full URL for one call.
 *
 * Exported so a test can assert the host and the per-surface path without a network. The gateway id is
 * encoded because it is deployer-supplied config, and a slug with a slash in it would otherwise rewrite
 * the endpoint path.
 */
export function upstreamUrl(deps: GatewayRunnerDeps, billing: Billing): string {
  return `${GATEWAY_HOST}/v1/${deps.accountId}/${encodeURIComponent(deps.gatewayId)}/${endpointFor(billing)}`;
}

/**
 * Which output-token field the upstream body must use.
 *
 * Measured 2026-08-05 (issue #10): the OpenAI 5.6 family and o4-mini on Unified Billing reject
 * `max_tokens` and require `max_completion_tokens`. xAI Grok chat models take the same field (prism's
 * own provider dispatch has used it since Grok 4). Anthropic and Workers AI still want `max_tokens`.
 *
 * Detection is by id PREFIX rather than a per-entry catalog flag so a new openai/* or xai/* model
 * inherits the right field without a second edit. Wrong field is a 400 from the provider that this
 * plane would surface as `upstream_error` with no usable completion.
 */
export function outputTokenField(upstreamModel: string): "max_tokens" | "max_completion_tokens" {
  // Compat Grok ids are `grok/*` (provider slug); public catalog ids remain `xai/*` for binding.
  if (
    upstreamModel.startsWith("openai/") ||
    upstreamModel.startsWith("xai/") ||
    upstreamModel.startsWith("grok/")
  ) {
    return "max_completion_tokens";
  }
  return "max_tokens";
}

/**
 * Body for env.AI.run on binding-dispatch chat models.
 *
 * Anthropic binding expects Messages API shape (system top-level, content blocks).
 * Gemini binding expects native `contents` / `systemInstruction` / `generationConfig`
 * (NOT OpenAI messages -- that yields gateway 502 "model or gateway failed").
 * Grok / OpenAI-shaped bindings take Chat Completions (messages + max_completion_tokens).
 * Model id is the first argument to run(), not a body field.
 */
export function bindingChatBody(request: InferenceRequest): Record<string, unknown> {
  const modelId = request.bindingModel ?? request.upstreamModel;
  // Multi-agent (and any binding model with api:responses) needs Responses shape, not messages.
  if (request.api === "responses" || isMultiAgentModel(modelId)) {
    return responsesBody({
      ...request,
      upstreamModel: modelId.replace(/^xai\//, "grok/"),
    });
  }
  // Gemini-native (mirror prism providers/google.ts). Roles: assistant→model; system hoisted.
  if (modelId.startsWith("google/gemini") || modelId.startsWith("google-ai-studio/")) {
    return geminiBindingBody(request);
  }
  if (modelId.startsWith("anthropic/")) {
    const systemParts: string[] = [];
    type ABlock =
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
    const messages: Array<{ role: "user" | "assistant"; content: ABlock[] }> = [];
    for (const m of request.messages) {
      if (m.role === "system") {
        if (m.content.trim()) systemParts.push(m.content);
        continue;
      }
      if (m.role !== "user" && m.role !== "assistant") continue;
      const blocks: ABlock[] = [];
      for (const url of m.images ?? []) {
        const img = anthropicImageBlock(url);
        if (img) blocks.push(img);
      }
      if (m.content.trim() || blocks.length === 0) {
        blocks.push({ type: "text", text: m.content || " " });
      }
      // Anthropic requires strict user/assistant alternation and a user-first list.
      // Clients (prism-ios) drop failed assistant shells, which leaves consecutive user
      // turns → provider 400 → "model or gateway failed". Merge same-role neighbors.
      const prev = messages[messages.length - 1];
      if (prev && prev.role === m.role) {
        // Merge text into the last text block when possible; append images/blocks otherwise.
        for (const b of blocks) {
          if (b.type === "text") {
            const lastText = [...prev.content].reverse().find((x) => x.type === "text");
            if (lastText && lastText.type === "text") {
              lastText.text = lastText.text ? `${lastText.text}\n\n${b.text}` : b.text;
              continue;
            }
          }
          prev.content.push(b);
        }
        continue;
      }
      messages.push({ role: m.role, content: blocks });
    }
    // Leading assistant is invalid; drop (orphan from a filtered prior user).
    while (messages.length > 0 && messages[0].role === "assistant") messages.shift();
    // Empty after filter: leave as-is; runner will fail closed upstream.
    const body: Record<string, unknown> = {
      max_tokens: request.maxTokens,
      messages,
    };
    if (systemParts.length) body.system = systemParts.join("\n\n");
    if (request.stream) body.stream = true;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    return body;
  }

  // OpenAI-compatible (Grok via binding uses public xai/* id + max_completion_tokens).
  const body: Record<string, unknown> = {
    messages: request.messages.map(toOpenAIMessage),
    max_completion_tokens: request.maxTokens,
  };
  if (request.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  return body;
}

/**
 * Gemini-native body for env.AI.run("google/gemini-*", …).
 * Verified shape (prism + CF model pages): contents[].parts[].text, systemInstruction, generationConfig.
 * Do not send OpenAI messages / max_completion_tokens -- binding rejects them as bad input / 502.
 */
export function geminiBindingBody(request: InferenceRequest): Record<string, unknown> {
  const systemParts: string[] = [];
  const contents: Array<{ role: string; parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> }> = [];
  for (const m of request.messages) {
    if (m.role === "system") {
      if (m.content.trim()) systemParts.push(m.content);
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    const role = m.role === "assistant" ? "model" : "user";
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    for (const url of m.images ?? []) {
      const inline = geminiInlineImage(url);
      if (inline) parts.push(inline);
    }
    if (m.content.trim() || parts.length === 0) {
      parts.push({ text: m.content || " " });
    }
    // Gemini also wants alternation; merge consecutive same-role turns.
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) {
      for (const p of parts) {
        if ("text" in p) {
          const lastText = [...prev.parts].reverse().find((x) => "text" in x) as
            | { text: string }
            | undefined;
          if (lastText) {
            lastText.text = lastText.text ? `${lastText.text}\n\n${p.text}` : p.text;
            continue;
          }
        }
        prev.parts.push(p);
      }
      continue;
    }
    contents.push({ role, parts });
  }
  // Leading model turns are invalid; drop.
  while (contents.length > 0 && contents[0].role === "model") contents.shift();

  // Gemini 3.x spends a large share of the output budget on thought tokens. Clients that
  // send max_tokens: 16–32 (matrix smoke, short probes) get finishReason=MAX_TOKENS with
  // empty answer text and look like plane 502s. Floor the binding budget so short requests
  // still produce a visible reply; meter still uses returned usageMetadata.
  // Pro needs a higher floor than Flash (measured: 256 still MAX_TOKENS empty on 3.1-pro).
  const modelId = request.bindingModel ?? request.upstreamModel;
  const GEMINI_MIN_OUTPUT_TOKENS = /gemini-.*-pro|gemini-3\.1-pro/i.test(modelId) ? 1024 : 256;
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: Math.max(request.maxTokens, GEMINI_MIN_OUTPUT_TOKENS),
  };
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.topP !== undefined) generationConfig.topP = request.topP;

  const body: Record<string, unknown> = {
    contents,
    generationConfig,
  };
  if (systemParts.length) {
    body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  }
  // stream:true on Gemini returns Gemini SSE, not OpenAI; non-stream is buffered into SSE
  // by runViaBinding (same posture as Anthropic). Never set stream on the binding body.
  return body;
}

function geminiInlineImage(
  url: string,
): { inlineData: { mimeType: string; data: string } } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!m) return null;
  return {
    inlineData: {
      mimeType: m[1].toLowerCase(),
      data: m[2].replace(/\s+/g, ""),
    },
  };
}

function toOpenAIMessage(m: {
  role: string;
  content: string;
  images?: string[];
}): Record<string, unknown> {
  if (!m.images?.length) return { role: m.role, content: m.content };
  const parts: Array<Record<string, unknown>> = [];
  for (const url of m.images) {
    parts.push({ type: "image_url", image_url: { url } });
  }
  parts.push({ type: "text", text: m.content || " " });
  return { role: m.role, content: parts };
}

/** Anthropic Messages image block from data: or https URL (https passed as URL source if possible). */
function anthropicImageBlock(
  url: string,
): { type: "image"; source: { type: "base64"; media_type: string; data: string } } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!m) {
    // https: Anthropic accepts url source on some gateways; prefer base64 from client.
    return null;
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: m[1].toLowerCase(),
      data: m[2].replace(/\s+/g, ""),
    },
  };
}

/**
 * Binding chat is only for catalog entries flagged `binding: true`.
 * The public `id` is the allowlist key (what env.AI.run expects); never a client string.
 */
export function isAllowedBindingChatModel(bindingModel: string): boolean {
  const entry = findModel(bindingModel);
  return !!entry && entry.modality === "chat" && entry.binding === true && entry.id === bindingModel;
}

async function runViaBinding(
  deps: GatewayRunnerDeps,
  request: InferenceRequest,
): Promise<InferenceResult> {
  const ai = deps.ai;
  const bindingModel = request.bindingModel;
  if (!ai || !bindingModel) {
    return {
      outcome: "upstream_error",
      status: null,
      detail:
        "This model requires the Worker AI binding (catalog binding: true). " +
        "Add [ai] binding = \"AI\" to wrangler config.",
    };
  }

  // Defense in depth: chat.ts only sets bindingModel from the catalog, but the runner
  // refuses any other string so a future caller cannot point env.AI.run at an arbitrary id.
  if (!isAllowedBindingChatModel(bindingModel)) {
    return {
      outcome: "upstream_error",
      status: null,
      detail: `Model is not allowlisted for AI binding dispatch: ${bindingModel.slice(0, 80)}`,
    };
  }

  type RunFn = (
    model: string,
    params: unknown,
    opts?: { gateway?: { id: string } },
  ) => Promise<unknown>;

  // INTENTIONAL: not HTTP + cf-aig-authorization. Cloudflare injects Unified Billing only via
  // env.AI.run for these ids (legacy /compat allowlist is frozen). gateway: { id } still routes
  // the call through AI_GATEWAY_ID for logs/reconcile. Money authority remains the D1 ledger after
  // the call (same posture as non-chat UB binding). See docs/security-false-positives.md.
  //
  // Anthropic binding + client stream:true: DO NOT use native Messages SSE. Non-stream AI.run
  // is the path that reliably returns text. Return an SSE Response **immediately** (open chunk
  // + keepalives), run non-stream inside the stream, then emit text. Awaiting AI.run before
  // Response left mobile clients with no first-byte for the whole think window → Empty stream.
  // Native-provider streams (Anthropic Messages SSE, Gemini SSE) are not OpenAI chat SSE.
  // Buffer non-stream AI.run, then emit OpenAI-shaped SSE (same path as Fable).
  const bufferedNativeStream =
    request.stream === true &&
    (bindingModel.startsWith("anthropic/") ||
      bindingModel.startsWith("google/gemini") ||
      bindingModel.startsWith("google-ai-studio/"));
  // Fable thinking regularly exceeds the 60s chat default; cap at plane max (180s).
  // Gemini Pro can also think for a long window.
  const timeoutMs =
    bindingModel.startsWith("anthropic/") || bindingModel.startsWith("google/")
      ? Math.max(deps.timeoutMs, 180_000)
      : deps.timeoutMs;

  if (bufferedNativeStream) {
    const nonStreamReq: InferenceRequest = { ...request, stream: false };
    const stream = openAIStreamFromDeferredCompletion({
      model: bindingModel,
      keepaliveMs: 10_000,
      run: async () => {
        const result = await Promise.race([
          (ai as unknown as { run: RunFn }).run(bindingModel, bindingChatBody(nonStreamReq), {
            gateway: { id: deps.gatewayId },
          }),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
              timeoutMs,
            );
          }),
        ]);
        const text = extractText(result);
        if (text === null) {
          throw new Error(
            `${bindingModel.startsWith("google/") ? "Gemini" : "Anthropic"} binding returned no extractable text`,
          );
        }
        const usage = extractUsage(result);
        return {
          text,
          promptTokens: usage?.inputTokens ?? null,
          completionTokens: usage?.outputTokens ?? null,
        };
      },
    });
    // logId only known after run; stream settlement may be unmetered until reconcile.
    return { outcome: "stream", stream, gatewayLogId: null };
  }

  try {
    const result = await Promise.race([
      (ai as unknown as { run: RunFn }).run(bindingModel, bindingChatBody(request), {
        gateway: { id: deps.gatewayId },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
          timeoutMs,
        );
      }),
    ]);

    const logId =
      (ai as unknown as { aiGatewayLogId?: string }).aiGatewayLogId ?? null;

    if (request.stream) {
      if (!(result instanceof ReadableStream)) {
        return {
          outcome: "upstream_error",
          status: null,
          detail: `binding stream expected ReadableStream, got ${typeof result}`,
        };
      }
      // Non-Anthropic binding streams (Grok etc.): already OpenAI-shaped; relay as-is.
      return {
        outcome: "stream",
        stream: result as ReadableStream<Uint8Array>,
        gatewayLogId: logId,
      };
    }

    return { outcome: "ok", body: result, gatewayLogId: logId };
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    if (aborted) return { outcome: "timeout", waitedMs: timeoutMs };
    // Do not echo raw provider/body dumps to the client path; keep a short operator-safe string.
    return {
      outcome: "upstream_error",
      status: null,
      detail: String(err instanceof Error ? err.message : err).slice(0, 200),
    };
  }
}

/**
 * Build the request body.
 *
 * `stream_options: { include_usage: true }` is the load-bearing line for streamed metering. Without it an
 * OpenAI-compatible stream ends with `[DONE]` and no token counts, and every streamed request would land
 * in the ledger unmetered. Asking for the trailing usage frame is what makes streaming chargeable at all.
 */
export function upstreamBody(request: InferenceRequest): Record<string, unknown> {
  const tokenField = outputTokenField(request.upstreamModel);
  return {
    model: request.upstreamModel,
    messages: request.messages.map(toOpenAIMessage),
    [tokenField]: request.maxTokens,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

/**
 * Responses API body for models that reject chat/completions:
 * - openai/gpt-5.5-pro → OpenAI Responses
 * - xai multi-agent → xAI Responses (not chat; measured "Multi Agent requests are not allowed")
 *
 * Model id is unprefixed for the provider-native path (measured: "gpt-5.5-pro",
 * "grok-4.20-multi-agent-0309"). Multi-agent does not support max_tokens (xAI docs).
 */
export function responsesBody(request: InferenceRequest): Record<string, unknown> {
  let instructions: string | undefined;
  const input: Array<{ role: string; content: string }> = [];
  for (const m of request.messages) {
    if (m.role === "system") {
      if (m.content.trim()) {
        instructions = instructions ? `${instructions}\n\n${m.content}` : m.content;
      }
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    input.push({ role: m.role, content: m.content });
  }
  const multiAgent = isMultiAgentModel(request.upstreamModel);
  const model = request.upstreamModel
    .replace(/^openai\//, "")
    .replace(/^grok\//, "")
    .replace(/^xai\//, "");
  const body: Record<string, unknown> = {
    model,
    input,
  };
  // Multi-agent: max_tokens / max_output_tokens not supported (xAI multi-agent docs).
  if (!multiAgent) body.max_output_tokens = request.maxTokens;
  if (instructions) body.instructions = instructions;
  if (request.stream) body.stream = true;
  // Default to a light multi-agent effort when not streaming a long research job.
  if (multiAgent) body.reasoning = { effort: "low" };
  return body;
}

export function isMultiAgentModel(modelId: string): boolean {
  return modelId.includes("multi-agent");
}

/**
 * Responses URL on the AI Gateway host.
 * OpenAI Responses: /openai/v1/responses
 * xAI multi-agent:  /grok/v1/responses (chat completions always 400)
 */
export function responsesUrl(deps: GatewayRunnerDeps, request?: InferenceRequest): string {
  const base = `${GATEWAY_HOST}/v1/${deps.accountId}/${encodeURIComponent(deps.gatewayId)}`;
  if (request && isMultiAgentModel(request.upstreamModel)) {
    return `${base}/grok/v1/responses`;
  }
  return `${base}/openai/v1/responses`;
}

const VISION_AGREE_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

function isModelAgreementError(status: number, detail: string): boolean {
  if (status !== 403) return false;
  const d = detail.toLowerCase();
  return d.includes("model agreement") || d.includes("submit the prompt 'agree'") || d.includes('submit the prompt "agree"');
}

/** The headers for one call. Split out so a test can assert the privacy posture without a network. */
export function upstreamHeaders(
  request: InferenceRequest,
  deps: GatewayRunnerDeps,
): Record<string, string> {
  return {
    // The gateway's own credential, and the only place the token appears. See the header for why there
    // is deliberately no plain `authorization` here.
    "cf-aig-authorization": `Bearer ${request.auth.value}`,
    // Not derived from any env var, deliberately. See the header: this one is an invariant.
    "cf-aig-collect-log-payload": "false",
    "cf-aig-collect-log": deps.collectLog ? "true" : "false",
    "cf-aig-metadata": JSON.stringify(request.metadata),
    "content-type": "application/json",
    accept: request.stream ? "text/event-stream" : "application/json",
  };
}

/**
 * The live runner, or null when the deployment is not wired to spend.
 *
 * NULL IS THE FAIL-CLOSED SIGNAL, returned at CONSTRUCTION rather than discovered at first use. A plane
 * that finds out mid-request that it has no gateway has already decided to spend. The caller turns null
 * into a 503.
 */
export function gatewayRunner(env: Env): InferenceRunner | null {
  const gateway = gatewayConfig(env);
  if (!gateway) return null;
  return runnerFor({
    accountId: gateway.accountId,
    gatewayId: gateway.id,
    timeoutMs: upstreamTimeoutMs(env),
    collectLog: gateway.collectLog,
    ai: env.AI,
  });
}

/** The runner over explicit deps, so tests can drive it with a fake fetch. */
export function runnerFor(deps: GatewayRunnerDeps): InferenceRunner {
  const doFetch = deps.fetchImpl ?? fetch;

  async function fetchOnce(
    request: InferenceRequest,
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<InferenceResult> {
    const timeoutMs = deps.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      if (aborted) return { outcome: "timeout", waitedMs: timeoutMs };
      return {
        outcome: "upstream_error",
        status: null,
        detail: String(err instanceof Error ? err.message : err).slice(0, 400),
      };
    }

    const gatewayLogId = res.headers.get("cf-aig-log-id");
    if (!res.ok) {
      clearTimeout(timer);
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 400);
      } catch {
        detail = "(upstream error body unreadable)";
      }
      return { outcome: "upstream_error", status: res.status, detail };
    }

    if (deps.collectLog && !gatewayLogId) {
      console.error("ai gateway served a request with no cf-aig-log-id", {
        gatewayId: deps.gatewayId,
        url,
        model: request.upstreamModel,
        requestId: request.metadata.request_id ?? null,
        status: res.status,
      });
    }

    if (request.stream) {
      if (!res.body) {
        clearTimeout(timer);
        return { outcome: "upstream_error", status: res.status, detail: "streamed response had no body" };
      }
      clearTimeout(timer);
      return { outcome: "stream", stream: res.body, gatewayLogId };
    }

    try {
      const parsed = await res.json();
      return { outcome: "ok", body: parsed, gatewayLogId };
    } catch (err) {
      return {
        outcome: "upstream_error",
        status: res.status,
        detail: `unparseable upstream body: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async run(request: InferenceRequest): Promise<InferenceResult> {
      // Binding-first for catalog models that cannot use keyless /compat (Fable, Grok 4.5, Gemini).
      if (request.bindingModel) {
        return runViaBinding(deps, request);
      }

      const useResponses = request.api === "responses";
      const url = useResponses
        ? responsesUrl(deps, request)
        : upstreamUrl(deps, request.billing);
      const headers = upstreamHeaders(request, deps);
      const body = useResponses ? responsesBody(request) : upstreamBody(request);

      let result = await fetchOnce(request, url, headers, body);

      // Workers AI Meta vision: one-time Community License accept on the CF account.
      // Docs require REST ai/run with body `{ "prompt": "agree" }` (not chat messages).
      // Measured: messages-shaped "agree" still 403; prompt-shaped accept then retries work.
      if (
        result.outcome === "upstream_error" &&
        result.status !== null &&
        isModelAgreementError(result.status, result.detail) &&
        (request.upstreamModel === VISION_AGREE_MODEL ||
          request.upstreamModel.includes("llama-3.2-11b-vision"))
      ) {
        const agreeUrl = `${CF_API_HOST}/client/v4/accounts/${deps.accountId}/ai/run/${VISION_AGREE_MODEL}`;
        try {
          await doFetch(agreeUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${request.auth.value}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ prompt: "agree" }),
          });
        } catch {
          // Fall through to retry anyway; accept may have partially applied.
        }
        result = await fetchOnce(request, url, headers, body);
      }

      return result;
    },
  };
}
