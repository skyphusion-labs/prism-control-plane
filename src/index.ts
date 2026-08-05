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

import { aiBindingRunner } from "./inference";
import { errorResponse, newRequestId } from "./http";
import { d1Store } from "./store-d1";
import type { Env } from "./env";
import {
  handleCreateAccount,
  handleCreateEnrollment,
  handleRevokeClient,
} from "./routes/admin";
import { handleMe, handleModels, handleUsage } from "./routes/account";
import { handleChatCompletions } from "./routes/chat";
import { handleEnroll } from "./routes/clients";
import { handleDeepHealth, handleHealth, SERVICE_NAME } from "./routes/health";
import type { Ctx } from "./routes/shared";

export { SERVICE_NAME };

const REVOKE_PATH = /^\/admin\/clients\/([A-Za-z0-9_-]{1,64})\/revoke$/;

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

  if (method === "GET" && path === "/health") return handleHealth(ctx);
  if (method === "GET" && path === "/health/deep") return await handleDeepHealth(ctx);

  if (method === "POST" && path === "/v1/clients") return await handleEnroll(ctx, request);
  if (method === "GET" && path === "/v1/me") return await handleMe(ctx, request);
  if (method === "GET" && path === "/v1/models") return await handleModels(ctx, request);
  if (method === "GET" && path === "/v1/usage") return await handleUsage(ctx, request);
  if (method === "POST" && path === "/v1/chat/completions") {
    return await handleChatCompletions(ctx, request);
  }

  if (method === "POST" && path === "/admin/accounts") return await handleCreateAccount(ctx, request);
  if (method === "POST" && path === "/admin/enrollments") {
    return await handleCreateEnrollment(ctx, request);
  }
  const revoke = method === "POST" ? REVOKE_PATH.exec(path) : null;
  if (revoke) return await handleRevokeClient(ctx, request, revoke[1]);

  return errorResponse(ctx.requestId, "not_found", `No route for ${method} ${path}.`);
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const requestId = newRequestId();
    const ctx: Ctx = {
      env,
      store: d1Store(env.DB),
      // NULL WHEN NO GATEWAY IS CONFIGURED, decided here at wiring time rather than mid-request. The
      // inference route turns null into 503; every other route works normally, so a missing gateway closes
      // the door that costs money without taking the read surface down with it.
      runner: aiBindingRunner(env),
      requestId,
      // ONE clock per request. Threaded rather than read at each use so the period key, the completion's
      // `created`, and an enrollment's expiry cannot land either side of a period boundary within a single
      // request, and so tests can pin time without mocking the global Date.
      now: new Date(),
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
