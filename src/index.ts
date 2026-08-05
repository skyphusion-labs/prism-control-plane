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

import { restRunner } from "./upstream";
import { errorResponse, newRequestId } from "./http";
import { d1Store } from "./store-d1";
import { CfApi } from "./cf-api";
import {
  CF_ACCOUNT_TOKEN_QUOTA,
  CfUserTokenProvider,
  SharedTokenSource,
  type UpstreamCredentialSource,
} from "./token-minter";
import { kekRing } from "./token-crypto";
import {
  credentialMode,
  gatewayConfig,
  userTokenBudget,
  userTokenKekConfig,
  type Env,
} from "./env";
import type { ControlPlaneStore } from "./store";
import {
  handleCreateAccount,
  handleCreateEnrollment,
  handleGrantCredit,
  handleRevokeClient,
  handleRevokeUserToken,
  handleSetModelPrice,
} from "./routes/admin";
import { handleMe, handleModels, handleUsage } from "./routes/account";
import { handleChatCompletions } from "./routes/chat";
import { handleEnroll } from "./routes/clients";
import { handleDeepHealth, handleHealth, SERVICE_NAME } from "./routes/health";
import type { Ctx } from "./routes/shared";

export { SERVICE_NAME };

const REVOKE_CLIENT_PATH = /^\/admin\/clients\/([A-Za-z0-9_-]{1,64})\/revoke$/;
const CREDIT_PATH = /^\/admin\/accounts\/([A-Za-z0-9_-]{1,64})\/credits$/;
const REVOKE_TOKEN_PATH = /^\/admin\/accounts\/([A-Za-z0-9_-]{1,64})\/upstream-token\/revoke$/;

/**
 * The upstream credential source for this deployment, or null when it cannot issue one at all.
 *
 * NULL IS A CLOSED INFERENCE DOOR, never a fallback to the other mode. Falling back would be the worst
 * possible behaviour in both directions: silently sharing one credential when the operator asked for
 * per-user isolation, or silently minting against a finite account quota when they asked for shared. A
 * half-configured deploy refuses to spend and says which switch is missing.
 *
 * PER-USER MODE NEEDS THREE THINGS and has no degraded mode. Without the minting token there is nothing to
 * mint with; without a KEK there is nowhere safe to keep what was minted, and a spendable Cloudflare token
 * in plaintext D1 is not a fallback but a breach waiting for a database dump; without a budget there is
 * nothing stopping it from eating the account's shared token quota.
 */
export function upstreamCredentialSource(
  env: Env,
  store: ControlPlaneStore,
  now: () => number,
): UpstreamCredentialSource | null {
  const gateway = gatewayConfig(env);
  if (!gateway) return null;

  if (credentialMode(env) === "shared") {
    const token = (env.CF_AIG_TOKEN ?? "").trim();
    return token ? new SharedTokenSource(token) : null;
  }

  const minting = (env.PCP_CF_API_TOKEN ?? "").trim();
  const kek = userTokenKekConfig(env);
  const budget = userTokenBudget(env, CF_ACCOUNT_TOKEN_QUOTA);
  if (!minting || !kek || budget === null) return null;
  const cf = new CfApi({ accountId: gateway.accountId, token: minting });
  return new CfUserTokenProvider(cf, store, kekRing(kek.primary, kek.next, kek.slot), now, budget);
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
  if (method === "POST" && path === "/admin/model-prices") {
    return await handleSetModelPrice(ctx, request);
  }
  const revokeClient = method === "POST" ? REVOKE_CLIENT_PATH.exec(path) : null;
  if (revokeClient) return await handleRevokeClient(ctx, request, revokeClient[1]);
  const credit = method === "POST" ? CREDIT_PATH.exec(path) : null;
  if (credit) return await handleGrantCredit(ctx, request, credit[1]);
  const revokeToken = method === "POST" ? REVOKE_TOKEN_PATH.exec(path) : null;
  if (revokeToken) return await handleRevokeUserToken(ctx, request, revokeToken[1]);

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
      // BOTH NULLS ARE DECIDED HERE, at wiring time rather than mid-request. A plane that discovers it has
      // no gateway or no minting credential in the middle of a request has already decided to spend. The
      // inference route turns either null into 503; every other route works normally, so a half-configured
      // deploy closes the door that costs money without taking the read surface down with it.
      runner: restRunner(env),
      credentials: upstreamCredentialSource(env, store, () => Math.floor(now.getTime() / 1000)),
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
