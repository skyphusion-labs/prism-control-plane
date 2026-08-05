// prism-control-plane: the Worker entry and the whole route table.
//
// Two exports, deliberately:
//
//   default { fetch }  the Worker. It does ONLY dependency wiring: build the store, build the runner,
//                      mint a request id, hand off. No policy lives here.
//   handleRequest      the router, taking its dependencies as an argument. This is what the tests drive,
//                      which is why the entire request path is testable in plain Node vitest with an
//                      in-memory store and a fake inference runner: no workerd, no Miniflare, no network.
//
// Splitting them is what keeps "does the gate refuse" a unit test rather than an integration exercise.

import { gatewayRunner } from "./upstream";
import { nonChatRunnerFor } from "./nonchat-upstream";
import { errorResponse, newRequestId } from "./http";
import { d1Store } from "./store-d1";
import { gatewayLogSource, type GatewayLogSource } from "./aig-logs";
import { SharedTokenSource, type UpstreamCredentialSource } from "./token-minter";
import { gatewayConfig, perUserModeRequested, upstreamTimeoutMs, type Env } from "./env";
import type { ControlPlaneStore } from "./store";
import {
  handleCreateAccount,
  handleCreateEnrollment,
  handleGrantCredit,
  handleRevokeClient,
  handleSetModelPrice,
  handleUpsertPlan,
} from "./routes/admin";
import { handleMe, handleModels, handleUsage } from "./routes/account";
import { handleReconcile } from "./routes/reconcile";
import { handleChatCompletions } from "./routes/chat";
import {
  handleAudioSpeech,
  handleAudioTranscriptions,
  handleImageGenerations,
  handleMusicGenerations,
  handleVideoGenerations,
} from "./routes/nonchat";
import { handleEnroll } from "./routes/clients";
import { handleDeepHealth, handleHealth, SERVICE_NAME } from "./routes/health";
import {
  handleCreateSttSession,
  handleSttStreamUpgrade,
  isSttStreamUpgrade,
} from "./routes/stt-stream";
import type { Ctx } from "./routes/shared";

export { SERVICE_NAME };
// Durable Object class must be exported from the Worker entry (wrangler class_name).
// Lazy re-export: tests import handleRequest without loading cloudflare:workers.
export { SttSession } from "./stt-session";

const REVOKE_CLIENT_PATH = /^\/admin\/clients\/([A-Za-z0-9_-]{1,64})\/revoke$/;
const CREDIT_PATH = /^\/admin\/accounts\/([A-Za-z0-9_-]{1,64})\/credits$/;

/**
 * The upstream credential source for this deployment, or null when it cannot issue one at all.
 *
 * PRODUCT IS ONE SHARED TOKEN. Cloudflare caps API tokens at 500 per account; minting one per Prism
 * account is not product and is not wired. NULL is a closed inference door: missing CF_AIG_TOKEN, or a
 * deploy that still asks for the retired per-user mode.
 */
export function upstreamCredentialSource(
  env: Env,
  _store: ControlPlaneStore,
  _now: () => number,
): UpstreamCredentialSource | null {
  if (!gatewayConfig(env)) return null;
  // Refuse rather than partially honor a leftover per-user config. Minting against the 500-token
  // ceiling was the design error; silently ignoring the flag would hide a misdeploy.
  if (perUserModeRequested(env)) return null;
  const token = (env.CF_AIG_TOKEN ?? "").trim();
  return token ? new SharedTokenSource(token) : null;
}

/**
 * The AI Gateway log feed, or null when this deployment cannot read its own bill.
 *
 * DELIBERATELY THE SAME TOKEN AS THE ONE THAT SPENDS, widened with AI Gateway Read rather than replaced by
 * a second credential. A separate read token would be a second secret to escrow, rotate and lose, buying
 * no isolation that matters: `CF_AIG_TOKEN` can already spend on this gateway, so adding the ability to
 * read the resulting cost rows does not widen the blast radius in any direction an attacker cares about.
 *
 * NULL IS A CLOSED RECONCILIATION DOOR, never a silent skip. Missing CF_AIG_TOKEN closes both spend and
 * reconcile together. A reconciliation job that quietly did nothing would look exactly like a healthy one
 * that found no drift.
 */
export function gatewayLogs(env: Env): GatewayLogSource | null {
  const gateway = gatewayConfig(env);
  const token = (env.CF_AIG_TOKEN ?? "").trim();
  if (!gateway || !token) return null;
  return gatewayLogSource({ accountId: gateway.accountId, gatewayId: gateway.id, token });
}

/**
 * The route table.
 *
 * METHOD IS MATCHED, not just path: a POST to a GET-only route answers 404 rather than falling through to
 * a handler that ignores the verb. There is no static-asset fallthrough and no catch-all proxy -- this
 * Worker serves exactly the surface in docs/openapi.yaml plus the operator routes, and anything else is a
 * 404. A metering plane with a passthrough is not a metering plane.
 */
export async function handleRequest(ctx: Ctx, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  // Live voice STT (Flux): WebSocket upgrade, not a POST body door.
  if (path === "/v1/stt/stream" && isSttStreamUpgrade(request, path)) {
    return await handleSttStreamUpgrade(ctx, request);
  }

  if (method === "GET" && path === "/health") return handleHealth(ctx);
  if (method === "GET" && path === "/health/deep") return await handleDeepHealth(ctx);

  // Browser path: mint short-lived stt_ ticket (never put pcp_ in Sec-WebSocket-Protocol).
  if (method === "POST" && path === "/v1/stt/sessions") {
    return await handleCreateSttSession(ctx, request);
  }

  if (method === "POST" && path === "/v1/clients") return await handleEnroll(ctx, request);
  if (method === "GET" && path === "/v1/me") return await handleMe(ctx, request);
  if (method === "GET" && path === "/v1/models") return await handleModels(ctx, request);
  if (method === "GET" && path === "/v1/usage") return await handleUsage(ctx, request);
  if (method === "POST" && path === "/v1/chat/completions") {
    return await handleChatCompletions(ctx, request);
  }
  if (method === "POST" && path === "/v1/images/generations") {
    return await handleImageGenerations(ctx, request);
  }
  if (method === "POST" && path === "/v1/audio/speech") {
    return await handleAudioSpeech(ctx, request);
  }
  if (method === "POST" && path === "/v1/audio/transcriptions") {
    return await handleAudioTranscriptions(ctx, request);
  }
  if (method === "POST" && path === "/v1/videos/generations") {
    return await handleVideoGenerations(ctx, request);
  }
  if (method === "POST" && path === "/v1/music/generations") {
    return await handleMusicGenerations(ctx, request);
  }

  if (method === "POST" && path === "/admin/accounts") return await handleCreateAccount(ctx, request);
  if (method === "POST" && path === "/admin/enrollments") {
    return await handleCreateEnrollment(ctx, request);
  }
  if (method === "POST" && path === "/admin/plans") return await handleUpsertPlan(ctx, request);
  if (method === "POST" && path === "/admin/model-prices") {
    return await handleSetModelPrice(ctx, request);
  }
  if (method === "POST" && path === "/admin/reconcile") return await handleReconcile(ctx, request);
  const revokeClient = method === "POST" ? REVOKE_CLIENT_PATH.exec(path) : null;
  if (revokeClient) return await handleRevokeClient(ctx, request, revokeClient[1]);
  const credit = method === "POST" ? CREDIT_PATH.exec(path) : null;
  if (credit) return await handleGrantCredit(ctx, request, credit[1]);

  return errorResponse(ctx.requestId, "not_found", `No route for ${method} ${path}.`);
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const requestId = newRequestId();
    const now = new Date();
    const store = d1Store(env.DB);
    const ctx: Ctx = {
      env,
      store,
      // ALL THREE NULLS ARE DECIDED HERE, at wiring time rather than mid-request. A plane that discovers it
      // has no gateway or no minting credential in the middle of a request has already decided to spend.
      // `runner` or `credentials` null turns the inference route into a 503; `logs` null turns
      // POST /admin/reconcile into one. Every other route works normally, so a half-configured deploy
      // closes the door that costs money without taking the read surface down with it.
      runner: gatewayRunner(env),
      nonChatRunner: (() => {
        const gw = gatewayConfig(env);
        if (!gw) return null;
        return nonChatRunnerFor({
          accountId: gw.accountId,
          gatewayId: gw.id,
          timeoutMs: upstreamTimeoutMs(env),
          collectLog: gw.collectLog,
          ai: env.AI,
        });
      })(),
      credentials: upstreamCredentialSource(env, store, () => Math.floor(now.getTime() / 1000)),
      logs: gatewayLogs(env),
      requestId,
      // ONE clock per request. Threaded rather than read at each use so the period key, the completion's
      // `created`, and an enrollment's expiry cannot land either side of a period boundary within a single
      // request, and so tests can pin time without mocking the global Date.
      now,
      waitUntil: (promise) => executionCtx.waitUntil(promise),
    };

    try {
      return await handleRequest(ctx, request);
    } catch (err) {
      // The last line of defence. An unhandled throw must not leak a stack to a client, and it must not
      // become an empty 500 with nothing to correlate against, so the request id goes to both the log and
      // the body.
      console.error("unhandled error", {
        requestId,
        error: String(err instanceof Error ? err.stack ?? err.message : err),
      });
      return errorResponse(requestId, "internal", "An unexpected error occurred.");
    }
  },
};
