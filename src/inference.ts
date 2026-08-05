// The upstream call: the one place AI Gateway / Workers AI is actually reached.
//
// Behind an interface so the whole request path can be tested without a network and without workerd.
// Production wires aiBindingRunner(); tests replace the whole runner. There is no third code path.

import { gatewayConfig, upstreamTimeoutMs, type Env } from "./env";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface InferenceRequest {
  /** The UPSTREAM model id from the catalog entry, never the client's raw string. */
  upstreamModel: string;
  messages: ChatTurn[];
  maxTokens: number;
  temperature?: number;
  topP?: number;
  /** Attached to the gateway log entry when logging is on, for later cost attribution. */
  metadata: Record<string, string>;
}

export type InferenceResult =
  | { outcome: "ok"; body: unknown; gatewayLogId: string | null }
  /** The upstream answered, but with a failure. `status` is its status where one is knowable. */
  | { outcome: "upstream_error"; status: number | null; detail: string }
  /** We stopped waiting. See the honest note in runWithTimeout: this does NOT cancel the model. */
  | { outcome: "timeout"; waitedMs: number };

export interface InferenceRunner {
  run(request: InferenceRequest): Promise<InferenceResult>;
}

/**
 * Narrow local view of the AI binding.
 *
 * The generated `Ai` type keys `run()` on a literal union of model names, which cannot express a model
 * id chosen at runtime from our catalog. prism casts the same way (src/ai-binding.ts) for the same
 * reason. The cast is narrow and local: exactly the two members used, right here, so it does not become
 * an `any` that spreads.
 */
interface AiRunner {
  run(
    model: string,
    params: unknown,
    opts?: {
      gateway: { id: string; metadata?: Record<string, string>; collectLog?: boolean };
    },
  ): Promise<unknown>;
  aiGatewayLogId?: string;
}

/**
 * Race the upstream against a timer.
 *
 * THIS ABANDONS THE WAIT; IT DOES NOT CANCEL THE MODEL. The AI binding takes no abort signal, so a
 * timed-out request may still complete upstream and may still be billed to us. That is exactly why the
 * caller records a timeout as an UNMETERED ledger row rather than as nothing: the request is spend we
 * cannot price, and an unmetered row is how this plane says so out loud instead of losing it.
 *
 * The timer is cleared on both paths so a resolved race does not keep the invocation alive waiting for
 * a pending timeout to fire.
 */
async function runWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
  });
  try {
    return await Promise.race([work.then((value) => ({ ok: true as const, value })), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The live runner, or null when no gateway is configured.
 *
 * NULL IS THE FAIL-CLOSED SIGNAL and it is returned at CONSTRUCTION rather than discovered at first
 * use. A plane that finds out mid-request that it has no gateway has already decided to spend. The
 * caller turns null into 503 unavailable.
 */
export function aiBindingRunner(env: Env): InferenceRunner | null {
  const gateway = gatewayConfig(env);
  if (!gateway) return null;
  const timeoutMs = upstreamTimeoutMs(env);
  const ai = env.AI as unknown as AiRunner;

  return {
    async run(request) {
      const params = {
        messages: request.messages,
        max_tokens: request.maxTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.topP === undefined ? {} : { top_p: request.topP }),
      };
      let raced: { ok: true; value: unknown } | { ok: false };
      try {
        raced = await runWithTimeout(
          ai.run(request.upstreamModel, params, {
            gateway: {
              id: gateway.id,
              metadata: request.metadata,
              // Explicit on every call rather than relying on the gateway's dashboard default. The
              // dashboard is not in this repo, so a default set there is a fact no reviewer of this
              // code can see; sending it per request makes the privacy posture reviewable in git.
              collectLog: gateway.collectLog,
            },
          }),
          timeoutMs,
        );
      } catch (err) {
        // The binding throws on provider failures (including a capacity 429 or an out-of-credit
        // refusal). The message is the upstream's own and is the only diagnosable thing here, so it is
        // preserved and truncated rather than replaced with a generic string.
        return {
          outcome: "upstream_error",
          status: null,
          detail: String(err instanceof Error ? err.message : err).slice(0, 400),
        };
      }
      if (!raced.ok) return { outcome: "timeout", waitedMs: timeoutMs };
      return { outcome: "ok", body: raced.value, gatewayLogId: ai.aiGatewayLogId ?? null };
    },
  };
}

/**
 * Pull the assistant text out of whatever shape came back.
 *
 * THERE ARE GENUINELY TWO SHAPES, verified against Cloudflare's own model pages on 2026-08-04:
 * `@cf/meta/llama-3.2-3b-instruct` answers `{ response: string, usage }` (the Workers AI shape), while
 * `@cf/zai-org/glm-4.7-flash` and `@cf/google/gemma-4-26b-a4b-it` answer the OpenAI shape
 * (`{ choices: [{ message: { content } }], usage }`).
 *
 * Both are handled by inspecting what arrived rather than by a per-model flag in the catalog. A pinned
 * flag would be a recorded fact about someone else's serving path, and those go stale silently; a
 * reader that looks at the response cannot.
 *
 * Returns null when neither shape yields text, which the caller reports as an upstream error rather
 * than as an empty completion. Handing a client a successful-looking response with no content would
 * make a provider failure look like a model that chose to say nothing.
 */
export function extractText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const asRecord = body as Record<string, unknown>;

  if (typeof asRecord.response === "string") return asRecord.response;

  const choices = asRecord.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | null;
    const content = first?.message?.content;
    if (typeof content === "string") return content;
    if (typeof first?.text === "string") return first.text;
  }
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
