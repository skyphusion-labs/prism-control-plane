// GET /v1/me, GET /v1/models, GET /v1/usage. Read-only, no spend.

import { modelsForTiers, publicModel } from "../catalog";
import { errorResponse, jsonResponse } from "../http";
import { periodBounds } from "../period";
import { planFromRow, publicPlan, type Plan } from "../plans";
import { remainingMicroUsd } from "../quota";
import type { Caller } from "../auth";
import type { ControlPlaneStore } from "../store";
import { requireCaller, type Ctx } from "./shared";

/**
 * Resolve the caller's plan, or the 503 that says we could not.
 *
 * A malformed plan row is NOT patched with defaults. Every field on a plan prices or bounds something,
 * so inventing one at runtime would be this code choosing policy. Refusing is the fail-closed answer and
 * it is loud.
 */
function resolvePlan(requestId: string, caller: Caller): { ok: true; plan: Plan } | { ok: false; response: Response } {
  const parsed = planFromRow(caller.plan);
  if (!parsed.ok) {
    console.error("plan is unusable", { requestId, reason: parsed.reason });
    return {
      ok: false,
      response: errorResponse(
        requestId,
        "unavailable",
        "This account's plan is not usable, so the request was refused rather than served on a guessed entitlement.",
      ),
    };
  }
  return { ok: true, plan: parsed.plan };
}

/** The usage projection. Shared by /v1/me and /v1/usage so the two cannot drift. */
export async function usageBody(
  store: ControlPlaneStore,
  accountId: string,
  plan: Plan,
  now: Date,
): Promise<Record<string, unknown>> {
  const bounds = periodBounds(now);
  const period = await store.getPeriod(accountId, bounds.key);
  // An ABSENT period row means no usage yet, which is genuinely zero: the row is created by the first
  // recorded request. That is the one place in this codebase where absent may be read as zero, and it
  // is safe because the row's existence is entirely under our control.
  const used = period?.micro_usd ?? 0;
  return {
    period: bounds.key,
    period_start: bounds.start,
    period_end: bounds.end,
    included_micro_usd: plan.includedMicroUsd,
    used_micro_usd: used,
    remaining_micro_usd: remainingMicroUsd({
      usedMicroUsd: used,
      includedMicroUsd: plan.includedMicroUsd,
    }),
    requests: period?.requests ?? 0,
    unmetered_requests: period?.unmetered_requests ?? 0,
  };
}

export async function handleMe(ctx: Ctx, request: Request): Promise<Response> {
  const authed = await requireCaller(ctx, request);
  if (!authed.ok) return authed.response;
  const planResult = resolvePlan(ctx.requestId, authed.caller);
  if (!planResult.ok) return planResult.response;

  const { client, account } = authed.caller;
  return jsonResponse(ctx.requestId, {
    client: {
      id: client.id,
      label: client.label,
      platform: client.platform,
      created_at: client.created_at,
    },
    account: {
      id: account.id,
      plan_id: account.plan_id,
      status: account.suspended_at ? "suspended" : "active",
    },
    plan: publicPlan(planResult.plan),
    usage: await usageBody(ctx.store, account.id, planResult.plan, ctx.now),
  });
}

/**
 * The entitled model list.
 *
 * FILTERED, not annotated. A model the plan does not allow is absent from the response, so an app's
 * picker cannot offer an option that will come back 403. Listing everything with a `usable: false` flag
 * would push that judgement into every client, and one of them would get it wrong.
 */
export async function handleModels(ctx: Ctx, request: Request): Promise<Response> {
  const authed = await requireCaller(ctx, request);
  if (!authed.ok) return authed.response;
  const planResult = resolvePlan(ctx.requestId, authed.caller);
  if (!planResult.ok) return planResult.response;

  return jsonResponse(ctx.requestId, {
    object: "list",
    data: modelsForTiers(planResult.plan.allowedTiers).map(publicModel),
  });
}

export async function handleUsage(ctx: Ctx, request: Request): Promise<Response> {
  const authed = await requireCaller(ctx, request);
  if (!authed.ok) return authed.response;
  const planResult = resolvePlan(ctx.requestId, authed.caller);
  if (!planResult.ok) return planResult.response;

  return jsonResponse(
    ctx.requestId,
    await usageBody(ctx.store, authed.caller.account.id, planResult.plan, ctx.now),
  );
}
