// The one place Cloudflare's AI REST API is actually called.
//
// WHY THE REST API AND NOT THE `env.AI` BINDING. The binding hard-codes one identity, the Worker's. The REST
// API (`POST /accounts/{id}/ai/v1/chat/completions`, GA 2026-05-21) authenticates with a Cloudflare API TOKEN
// in the `Authorization` header, which makes the credential a per-request ARGUMENT -- and that is what lets
// this plane run either a shared account credential or a per-user minted one without a second code path. One
// endpoint covers both halves of the catalog: `@cf/` models bill at Workers AI rates, `author/model` third
// parties bill through Unified Billing.
//
// HEADERS, AND WHY EACH ONE IS THERE:
//   authorization               the credential for this request, whichever mode produced it.
//   cf-aig-authorization        the same value again. An AI Gateway with authentication ON requires it, and a
//                               gateway with authentication OFF ignores it. Sending both means the plane does
//                               not break the day someone correctly turns gateway auth on.
//   cf-aig-gateway-id           route through OUR gateway rather than the account default. REQUIRED for
//                               `@cf/` models, per Cloudflare's REST API docs.
//   cf-aig-collect-log-payload  ALWAYS "false". See below.
//   cf-aig-collect-log          whether the metadata row exists at all. Configurable.
//   cf-aig-metadata             opaque ids for attribution. Never content.
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

import { gatewayConfig, upstreamTimeoutMs, type Env } from "./env";
import type { InferenceRequest, InferenceResult, InferenceRunner } from "./inference";

const CF_API = "https://api.cloudflare.com/client/v4";

export interface RestRunnerDeps {
  accountId: string;
  gatewayId: string;
  timeoutMs: number;
  collectLog: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Build the request body.
 *
 * `stream_options: { include_usage: true }` is the load-bearing line for streamed metering. Without it an
 * OpenAI-compatible stream ends with `[DONE]` and no token counts, and every streamed request would land
 * in the ledger unmetered. Asking for the trailing usage frame is what makes streaming chargeable at all.
 */
export function upstreamBody(request: InferenceRequest): Record<string, unknown> {
  return {
    model: request.upstreamModel,
    messages: request.messages,
    max_tokens: request.maxTokens,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

/** The headers for one call. Split out so a test can assert the privacy posture without a network. */
export function upstreamHeaders(request: InferenceRequest, deps: RestRunnerDeps): Record<string, string> {
  return {
    authorization: `Bearer ${request.auth.value}`,
    "cf-aig-authorization": `Bearer ${request.auth.value}`,
    "cf-aig-gateway-id": deps.gatewayId,
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
export function restRunner(env: Env): InferenceRunner | null {
  const gateway = gatewayConfig(env);
  if (!gateway) return null;
  return runnerFor({
    accountId: gateway.accountId,
    gatewayId: gateway.id,
    timeoutMs: upstreamTimeoutMs(env),
    collectLog: gateway.collectLog,
  });
}

/** The runner over explicit deps, so tests can drive it with a fake fetch. */
export function runnerFor(deps: RestRunnerDeps): InferenceRunner {
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${CF_API}/accounts/${deps.accountId}/ai/v1/chat/completions`;

  return {
    async run(request: InferenceRequest): Promise<InferenceResult> {
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
          headers: upstreamHeaders(request, deps),
          body: JSON.stringify(upstreamBody(request)),
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
        return { outcome: "ok", body, gatewayLogId };
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
