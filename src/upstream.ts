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

import type { Billing } from "./catalog";
import { LLAVA_MODEL_ID } from "./chat-request";
import { gatewayConfig, upstreamTimeoutMs, type Env } from "./env";
import type { InferenceRequest, InferenceResult, InferenceRunner } from "./inference";

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
 * Grok / OpenAI-shaped bindings take Chat Completions (messages + max_completion_tokens).
 * Model id is the first argument to run(), not a body field.
 */
export function bindingChatBody(request: InferenceRequest): Record<string, unknown> {
  const modelId = request.bindingModel ?? request.upstreamModel;
  if (modelId.startsWith("anthropic/")) {
    const systemParts: string[] = [];
    const messages: Array<{ role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> }> =
      [];
    for (const m of request.messages) {
      if (m.role === "system") {
        if (m.content.trim()) systemParts.push(m.content);
        continue;
      }
      if (m.role !== "user" && m.role !== "assistant") continue;
      messages.push({
        role: m.role,
        content: [{ type: "text", text: m.content }],
      });
    }
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
    messages: request.messages,
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

  type RunFn = (
    model: string,
    params: unknown,
    opts?: { gateway?: { id: string } },
  ) => Promise<unknown>;

  try {
    const result = await Promise.race([
      (ai as unknown as { run: RunFn }).run(bindingModel, bindingChatBody(request), {
        gateway: { id: deps.gatewayId },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
          deps.timeoutMs,
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
      return { outcome: "stream", stream: result as ReadableStream<Uint8Array>, gatewayLogId: logId };
    }

    return { outcome: "ok", body: result, gatewayLogId: logId };
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
    messages: request.messages,
    [tokenField]: request.maxTokens,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
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

/**
 * LLaVA native image-to-text body.
 *
 * Measured 2026-08-05: chat/completions rejects this model (requires `image`); the native Workers AI
 * shape is `{ image: number[] (raw bytes), prompt, max_tokens }` and returns `{ description }`.
 */
export function llavaBody(request: InferenceRequest): Record<string, unknown> {
  if (!request.imageBytes || request.imageBytes.byteLength === 0) {
    throw new Error("LLaVA requires imageBytes");
  }
  const prompt =
    [...request.messages].reverse().find((m) => m.role === "user")?.content?.trim() ||
    "Describe this image.";
  return {
    image: Array.from(request.imageBytes),
    prompt,
    max_tokens: request.maxTokens,
  };
}

/**
 * URL for the LLaVA native path.
 *
 * REST `ai/run` with `cf-aig-gateway-id` (not the gateway host). Measured 2026-08-05: the gateway host
 * `workers-ai/@cf/llava...` answers 401 with our token; REST with Authorization + gateway id answers 200
 * and still writes a row on `prism-proxy` (cost/tokens/neurons all 0 for this beta model).
 */
export function llavaUrl(deps: GatewayRunnerDeps): string {
  return `${CF_API_HOST}/client/v4/accounts/${deps.accountId}/ai/run/${LLAVA_MODEL_ID}`;
}

export function llavaHeaders(request: InferenceRequest, deps: GatewayRunnerDeps): Record<string, string> {
  return {
    authorization: `Bearer ${request.auth.value}`,
    "cf-aig-gateway-id": deps.gatewayId,
    "cf-aig-collect-log-payload": "false",
    "cf-aig-collect-log": deps.collectLog ? "true" : "false",
    "cf-aig-metadata": JSON.stringify(request.metadata),
    "content-type": "application/json",
    accept: "application/json",
  };
}

/** The runner over explicit deps, so tests can drive it with a fake fetch. */
export function runnerFor(deps: GatewayRunnerDeps): InferenceRunner {
  const doFetch = deps.fetchImpl ?? fetch;

  return {
    async run(request: InferenceRequest): Promise<InferenceResult> {
      // Binding-first for catalog models that cannot use keyless /compat (Fable, Grok 4.5).
      if (request.bindingModel) {
        return runViaBinding(deps, request);
      }

      const isLlava = request.upstreamModel === LLAVA_MODEL_ID;
      if (isLlava && !request.imageBytes?.byteLength) {
        return {
          outcome: "upstream_error",
          status: null,
          detail: "LLaVA requires an image; the request reached the runner without imageBytes",
        };
      }
      if (isLlava && request.stream) {
        return {
          outcome: "upstream_error",
          status: null,
          detail: "LLaVA does not stream",
        };
      }

      const url = isLlava ? llavaUrl(deps) : upstreamUrl(deps, request.billing);
      const headers = isLlava ? llavaHeaders(request, deps) : upstreamHeaders(request, deps);
      const body = isLlava ? llavaBody(request) : upstreamBody(request);

      // A REAL ABORT, unlike the AI binding's un-cancellable promise: fetch takes a signal, so a
      // timed-out request is actually torn down. It is still possible for the upstream to have generated
      // tokens before the abort landed and to bill us for them, which is why a timeout is recorded as an
      // UNMETERED ledger row rather than as nothing.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
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
        if (aborted) return { outcome: "timeout", waitedMs: deps.timeoutMs };
        return {
          outcome: "upstream_error",
          status: null,
          detail: String(err instanceof Error ? err.message : err).slice(0, 400),
        };
      }

      const gatewayLogId = res.headers.get("cf-aig-log-id");

      if (!res.ok) {
        clearTimeout(timer);
        // The upstream's own body is the only diagnosable thing here, so it is preserved and truncated
        // rather than replaced with a generic string. It is logged operator-side; the client gets a code.
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 400);
        } catch {
          detail = "(upstream error body unreadable)";
        }
        return { outcome: "upstream_error", status: res.status, detail };
      }

      // THE TRANSIT RECEIPT, CHECKED RATHER THAN ASSUMED. A 200 from this host with logging on and no
      // `cf-aig-log-id` means the gateway served the request without recording it, which is how the
      // reconciliation feed silently empties out. The request is NOT failed over it -- the completion is
      // already generated and already billed to us, so refusing it would throw away money and deny the
      // caller a response we paid for -- but it is stated at error level so a monitor can see the gap
      // instead of the plane discovering it a month later in a reconciliation report that found nothing.
      // LLaVA's REST path often omits the header even when a log row is written; do not error-spam it.
      if (deps.collectLog && !gatewayLogId && !isLlava) {
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
        // THE TIMER IS CLEARED HERE, at first byte, not at last. A stream that has started is a stream the
        // client is being served; aborting it mid-answer because the total exceeded a request budget would
        // destroy a completion we have already paid for. The read side has its own idle protection in the
        // platform's stream handling.
        clearTimeout(timer);
        return { outcome: "stream", stream: res.body, gatewayLogId };
      }

      try {
        const body = await res.json();
        // REST ai/run wraps the model output in { success, result }. Unwrap so extractText sees
        // `{ description }` the same way a bare workers-ai body would.
        const unwrapped =
          isLlava && body && typeof body === "object" && "result" in (body as object)
            ? (body as { result: unknown }).result
            : body;
        return { outcome: "ok", body: unwrapped, gatewayLogId };
      } catch (err) {
        return {
          outcome: "upstream_error",
          status: res.status,
          detail: `unparseable upstream body: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
