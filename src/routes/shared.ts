// Primitives every route shares: the injected dependency bundle, and the ONE mapping from an auth
// failure to a wire response.

import { errorResponse } from "../http";
import type { Env } from "../env";
import type { InferenceRunner } from "../inference";
import type { Caller, ResolveFailure } from "../auth";
import { resolveClient } from "../auth";
import type { ControlPlaneStore } from "../store";
import type { UpstreamCredentialSource } from "../token-minter";

/**
 * Everything a handler needs, injected.
 *
 * `runner` and `credentials` are nullable on purpose, and they are TWO separate nulls because they are two
 * separate misconfigurations:
 *
 *   runner null        no account id or no gateway slug. There is nowhere to send inference.
 *   credentials null   nothing to authenticate upstream with: in shared mode a missing CF_AIG_TOKEN, in
 *                      per-user mode a missing minting token, KEK, or budget.
 *
 * Either closes the inference door with a 503 while leaving the read surface (health, models, usage)
 * working, so a half-configured deploy is diagnosable instead of dark. Reporting them separately in
 * /health/deep is what turns "503" into "which secret is missing".
 *
 * The routes never learn WHICH credential mode answered, and must not branch on it. That is what makes the
 * mode a config decision rather than a second code path with its own gates to get wrong.
 *
 * `waitUntil` is passed rather than reached for, so a test can assert that the ledger write was
 * scheduled without running inside workerd.
 */
export interface Ctx {
  env: Env;
  store: ControlPlaneStore;
  runner: InferenceRunner | null;
  credentials: UpstreamCredentialSource | null;
  requestId: string;
  now: Date;
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Auth failure to response, in one place.
 *
 * Every distinction here exists because a client must act differently on it, and the wording is part of
 * the contract's promise that `client_revoked` is TERMINAL. A single generic 401 would leave a device
 * retrying a dead key forever.
 */
export function authFailureResponse(
  requestId: string,
  failure: ResolveFailure,
  detail?: string,
): Response {
  switch (failure) {
    case "unauthenticated":
      return errorResponse(
        requestId,
        "unauthenticated",
        "A valid client key is required in the Authorization header.",
      );
    case "revoked":
      return errorResponse(
        requestId,
        "client_revoked",
        "This client key has been revoked. Delete the stored key and enroll again; retrying will not help.",
      );
    case "suspended":
      return errorResponse(requestId, "forbidden", "This account is suspended.");
    case "misconfigured":
      // 503, NOT 401. The credential is fine; our data is not. Telling the caller they are
      // unauthenticated would send them chasing a key that is already correct.
      console.error("control-plane misconfiguration", { requestId, detail });
      return errorResponse(
        requestId,
        "unavailable",
        "This client resolves to an account or plan that is not configured. The request was refused rather than served unmetered.",
      );
  }
}

export type AuthedResult = { ok: true; caller: Caller } | { ok: false; response: Response };

/** Resolve the caller or produce the refusal. Every /v1 route starts here. */
export async function requireCaller(ctx: Ctx, request: Request): Promise<AuthedResult> {
  const result = await resolveClient(ctx.store, request);
  if (!result.ok) {
    return { ok: false, response: authFailureResponse(ctx.requestId, result.failure, result.detail) };
  }
  // Best-effort, and deliberately not awaited into the critical path: a last-seen stamp is telemetry,
  // and a failed telemetry write must never fail a paid request.
  ctx.waitUntil(ctx.store.touchClient(result.caller.client.id).catch(() => undefined));
  return { ok: true, caller: result.caller };
}

/** Client IP for the enrollment limiter. "unknown" collapses absent-header callers into one bucket,
 * which throttles them together rather than exempting them. */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
