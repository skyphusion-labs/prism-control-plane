// The one place a model is actually called.
//
// THE URL IS THE GATEWAY, AND THAT IS THE WHOLE POINT OF THIS FILE'S SHAPE. Every call goes to
// `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/...`, so "did this request go through
// our gateway" is answered by the hostname rather than by a header the far end is free to ignore. That
// distinction is not theoretical; it is issue #15. The previous version of this file called the AI REST
// API on `api.cloudflare.com` and named the gateway in a `cf-aig-gateway-id` header, exactly as
// Cloudflare documents. Measured on this account 2026-08-05, that path does route and does log, but it
// returns NO `cf-aig-*` response headers at all and it IGNORES `cf-aig-authorization`: a deliberately
// invalid gateway credential still answered 200 and still served a completion. So on the REST path
// there is no receipt proving transit and no gateway-side authentication, and a plane that has quietly
// stopped going through its gateway looks exactly like one that has not.
//
// On this path both of those hold structurally:
//   * `cf-aig-log-id` comes back on EVERY served response, streamed or not (measured; the note in
//     prism's README that the gateway does not surface it on SSE is stale for this endpoint).
//   * `prism-proxy` runs with `authentication: true`, so a request carrying a bad gateway credential
//     is refused 401 (`AiGatewayError` 2009) instead of being served. A bypass cannot succeed quietly.
//
// WHY THE GATEWAY HTTP PATH AND NOT THE `env.AI` BINDING. The binding hard-codes one identity, the
// Worker's. An HTTP call takes its credential as a per-request ARGUMENT, which is what lets this plane
// run either a shared account credential or a per-user minted one without a second code path.
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
import { gatewayConfig, upstreamTimeoutMs, type Env } from "./env";
import type { InferenceRequest, InferenceResult, InferenceRunner } from "./inference";

/** The AI Gateway host. A constant so the anti-bypass test has one literal to pin. */
export const GATEWAY_HOST = "https://gateway.ai.cloudflare.com";

export interface GatewayRunnerDeps {
  accountId: string;
  gatewayId: string;
  timeoutMs: number;
  collectLog: boolean;
  fetchImpl?: typeof fetch;
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
  });
}

/** The runner over explicit deps, so tests can drive it with a fake fetch. */
export function runnerFor(deps: GatewayRunnerDeps): InferenceRunner {
  const doFetch = deps.fetchImpl ?? fetch;

  return {
    async run(request: InferenceRequest): Promise<InferenceResult> {
      const url = upstreamUrl(deps, request.billing);
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

      // THE TRANSIT RECEIPT, CHECKED RATHER THAN ASSUMED. A 200 from this host with logging on and no
      // `cf-aig-log-id` means the gateway served the request without recording it, which is how the
      // reconciliation feed silently empties out. The request is NOT failed over it -- the completion is
      // already generated and already billed to us, so refusing it would throw away money and deny the
      // caller a response we paid for -- but it is stated at error level so a monitor can see the gap
      // instead of the plane discovering it a month later in a reconciliation report that found nothing.
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
