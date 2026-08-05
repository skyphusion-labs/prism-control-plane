// The upstream contract: what a call to the model looks like, and what can come back.
//
// Types and pure readers only. The one implementation that touches the network lives in upstream.ts,
// behind the `InferenceRunner` interface, so the entire request path -- gates, metering, ledger, SSE
// teeing -- is testable in Node with no network and no workerd. Tests replace the whole runner. There is
// no third code path and no "if (test)" anywhere in the chain.

import type { Billing } from "./catalog";

/** One turn. Content is a plain string; image bytes for vision models ride on InferenceRequest.image. */
export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The credential the call is made WITH. Per user, never the plane's own minting token. */
export interface UpstreamAuth {
  /** Cloudflare token id. Logged for attribution; safe. */
  tokenId: string;
  /** Token value. Used in one header and never logged. */
  value: string;
}

export interface InferenceRequest {
  /** The UPSTREAM model id from the catalog entry, never the client's raw string. */
  upstreamModel: string;
  /**
   * When set, the runner uses `env.AI.run(bindingModel, …)` (Workers AI binding + gateway)
   * instead of the HTTP `/compat` path. Catalog public `id` for models that need Unified
   * Billing credential injection the legacy gateway allowlist does not provide.
   */
  bindingModel?: string;
  /**
   * OpenAI wire surface for HTTP dispatch. `responses` uses `/openai/v1/responses` instead of
   * `/compat/chat/completions` (gpt-5.5-pro).
   */
  api?: "chat" | "responses";
  /**
   * Which billing surface this model sits on, carried FROM THE CATALOG rather than re-derived.
   *
   * It selects the gateway endpoint in upstream.ts. Sniffing an `@cf/` prefix at the call site would
   * work today and would be a second, silently diverging copy of a fact the catalog already states.
   */
  billing: Billing;
  messages: ChatTurn[];
  maxTokens: number;
  temperature?: number;
  topP?: number;
  /** True to ask for SSE. The runner also asks for trailing usage; see upstream.ts. */
  stream: boolean;
  auth: UpstreamAuth;
  /** Attached to the gateway log entry, when logging is on. Opaque ids only, never content. */
  metadata: Record<string, string>;
  /**
   * Raw image bytes for single-shot vision models (LLaVA). Not logged. When set, the runner uses the
   * native Workers AI image-to-text body rather than chat/completions.
   */
  imageBytes?: Uint8Array;
}

export type InferenceResult =
  | { outcome: "ok"; body: unknown; gatewayLogId: string | null }
  /**
   * An SSE body, not yet read.
   *
   * The caller owns the stream and MUST consume it: the metering for a streamed request lives in its
   * trailing usage frame, so a stream nobody reads is spend nobody priced.
   */
  | { outcome: "stream"; stream: ReadableStream<Uint8Array>; gatewayLogId: string | null }
  /** The upstream answered, with a failure. `status` is its status where one is knowable. */
  | { outcome: "upstream_error"; status: number | null; detail: string }
  /** We stopped waiting. See upstream.ts for what this does and does not cancel. */
  | { outcome: "timeout"; waitedMs: number };

export interface InferenceRunner {
  run(request: InferenceRequest): Promise<InferenceResult>;
}

/**
 * Pull the assistant text out of whatever shape came back.
 *
 * THERE ARE GENUINELY TWO SHAPES. The gateway's `chat/completions` endpoints answer the OpenAI shape
 * (`{ choices: [{ message: { content } }], usage }`), but some Workers AI models still answer their
 * native `{ response, usage }` when reached through the same door. Both are handled by inspecting what
 * arrived rather than by a per-model flag in the catalog: a pinned flag is a recorded fact about someone
 * else's serving path, and those go stale silently. A reader that looks at the response cannot.
 *
 * Returns null when neither shape yields text, which the caller reports as an upstream error rather than
 * as an empty completion. A successful-looking response with no content would make a provider failure
 * look like a model that chose to say nothing.
 */
export function extractText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const asRecord = body as Record<string, unknown>;

  if (typeof asRecord.response === "string") return asRecord.response;
  // LLaVA / image-to-text: `{ description }` or `{ result: { description } }`.
  if (typeof asRecord.description === "string") return asRecord.description;

  const choices = asRecord.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as {
      message?: {
        content?: unknown;
        reasoning_content?: unknown;
        reasoning?: unknown;
      };
      text?: unknown;
    } | null;
    const content = first?.message?.content;
    if (typeof content === "string" && content.length > 0) return content;
    // Content array parts (some Workers AI / OpenAI-compatible variants).
    if (Array.isArray(content)) {
      const joined = content
        .filter((b): b is { type?: string; text?: string } => !!b && typeof b === "object")
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("");
      if (joined) return joined;
    }
    if (typeof first?.text === "string" && first.text.length > 0) return first.text;
    // Reasoning-only bodies (gpt-oss / qwen3 / glm with content:null and finish length).
    // Prefer real content; fall back so the plane does not 502 "unreadable" on a 200.
    const reasoning =
      first?.message?.reasoning_content ?? first?.message?.reasoning;
    if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
    // Explicit empty string content is a real empty completion, not unreadable.
    if (content === "") return "";
  }

  // Anthropic Messages API (env.AI.run binding for Fable etc.): only type:"text" blocks.
  // Thinking / tool blocks are ignored (same discipline as prism extractOutput).
  const content = asRecord.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type?: string; text?: string } => !!b && typeof b === "object")
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    if (text) return text;
  }

  // OpenAI Responses API: output[] with type message / output_text blocks.
  const output = asRecord.output;
  if (Array.isArray(output)) {
    const text = output
      .flatMap((block) => {
        const b = block as { type?: string; content?: Array<{ type?: string; text?: string }> };
        if (b?.type === "message" || Array.isArray(b?.content)) {
          return (b.content ?? [])
            .filter((c) => c?.type === "output_text" || c?.type === "text")
            .map((c) => c.text ?? "");
        }
        return [];
      })
      .join("");
    if (text) return text;
  }

  // Gemini-native: candidates[0].content.parts[].text
  const candidates = asRecord.candidates;
  if (Array.isArray(candidates) && candidates[0] && typeof candidates[0] === "object") {
    const parts = (candidates[0] as { content?: { parts?: Array<{ text?: string }> } }).content
      ?.parts;
    if (Array.isArray(parts)) {
      const text = parts.map((p) => p.text ?? "").join("");
      if (text) return text;
    }
  }

  // Some model families come back wrapped in `{ result: ... }`. One level of unwrapping, not a recursive
  // search: a deep hunt for any string field called `response` would eventually find something that is
  // not a completion and hand it to a user as one.
  const result = asRecord.result;
  if (result !== undefined && result !== null) return extractText(result);
  return null;
}

/** The upstream's own finish reason when it gave one, else null. Never invented. */
export function extractFinishReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const reason = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return typeof reason === "string" ? reason : null;
}
