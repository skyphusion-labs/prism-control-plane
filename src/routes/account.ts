// GET /v1/me, GET /v1/models, GET /v1/usage. Read-only, no spend.

import { modelsForTiers, publicModel } from "../catalog";
import { errorResponse, jsonResponse } from "../http";
import { periodBounds } from "../period";
import { planFromRow, publicPlan, type Plan } from "../plans";
import { remainingAllowanceMicroUsd, remainingMicroUsd } from "../balance";
import { resolvePrice } from "../meter";
import type { Caller } from "../auth";
import type { AccountRow, ControlPlaneStore } from "../store";
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

/**
 * The usage projection. Shared by /v1/me and /v1/usage so the two cannot drift.
 *
 * TWO MONEY POOLS, different time shapes. Prepaid credit (credit, spent, remaining) is LIFETIME and
 * never expires. Monthly allowance is period-scoped: included for this UTC month, spent first, unused
 * expires at period roll and never becomes credit (issue #11).
 *
 * THE TRUE-UP FIELDS ARE PUBLISHED so the month adds up after reconciliation (issue #12).
 */
export async function usageBody(
  store: ControlPlaneStore,
  account: AccountRow,
  now: Date,
  plan: Plan,
): Promise<Record<string, unknown>> {
  const bounds = periodBounds(now);
  const period = await store.getPeriod(account.id, bounds.key);
  const allowanceSpent = period?.allowance_spent_micro_usd ?? 0;
  const allowanceRemaining = remainingAllowanceMicroUsd({
    monthlyIncludedMicroUsd: plan.monthlyIncludedMicroUsd,
    allowanceSpentMicroUsd: allowanceSpent,
  });
  const creditRemaining = remainingMicroUsd({
    creditMicroUsd: account.credit_micro_usd,
    spentMicroUsd: account.spent_micro_usd,
  });
  // An ABSENT period row means no usage yet, which is genuinely zero: the row is created by the first
  // recorded request. That is the one place in this codebase where absent may be read as zero, and it
  // is safe because the row's existence is entirely under our control.
  return {
    credit_micro_usd: account.credit_micro_usd,
    spent_micro_usd: account.spent_micro_usd,
    remaining_micro_usd: creditRemaining,
    monthly_included_micro_usd: plan.monthlyIncludedMicroUsd,
    allowance_spent_micro_usd: allowanceSpent,
    allowance_remaining_micro_usd: allowanceRemaining,
    // What the pre-flight gate actually checks: allowance left + credit left.
    spendable_remaining_micro_usd: allowanceRemaining + creditRemaining,
    // No overage exists on this plane. Published as a fact rather than left to be inferred from the
    // absence of an overage field, because "what happens when I run out" is the first question a client
    // implementer has and the answer is: 402, until the next period or a top-up.
    overage: false,
    period: bounds.key,
    period_start: bounds.start,
    period_end: bounds.end,
    period_micro_usd: period?.micro_usd ?? 0,
    period_requests: period?.requests ?? 0,
    period_unmetered_requests: period?.unmetered_requests ?? 0,
    period_adjust_spend_micro_usd: period?.adjust_spend_micro_usd ?? 0,
    period_adjust_credit_micro_usd: period?.adjust_credit_micro_usd ?? 0,
    period_reconciled_micro_usd:
      (period?.micro_usd ?? 0) +
      (period?.adjust_spend_micro_usd ?? 0) -
      (period?.adjust_credit_micro_usd ?? 0),
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
    usage: await usageBody(ctx.store, account, ctx.now, planResult.plan),
  });
}

/**
 * The entitled model list.
 *
 * FILTERED BY ENTITLEMENT, ANNOTATED BY SPENDABILITY, and the split is deliberate. A model the plan does not
 * allow is ABSENT: an app's picker cannot offer an option that will come back 403. A model the plan allows
 * but that has no rate yet is PRESENT with `spendable: false`, because it is coming back the moment an
 * operator prices it, and a client that dropped it from its picker would never notice.
 *
 * Price overrides are read here too, so the rate a client is shown is the rate it will actually be charged.
 * A list that published the compiled-in price while the meter used an override would be a lie in the most
 * sensitive field on the response.
 */
export async function handleModels(ctx: Ctx, request: Request): Promise<Response> {
  const authed = await requireCaller(ctx, request);
  if (!authed.ok) return authed.response;
  const planResult = resolvePlan(ctx.requestId, authed.caller);
  if (!planResult.ok) return planResult.response;

  const overrides = new Map((await ctx.store.listModelPrices()).map((row) => [row.model_id, row]));
  return jsonResponse(ctx.requestId, {
    object: "list",
    data: modelsForTiers(planResult.plan.allowedTiers).map((entry) =>
      publicModel(entry, resolvePrice(entry, overrides.get(entry.id) ?? null)),
    ),
  });
}

export async function handleUsage(ctx: Ctx, request: Request): Promise<Response> {
  const authed = await requireCaller(ctx, request);
  if (!authed.ok) return authed.response;
  const planResult = resolvePlan(ctx.requestId, authed.caller);
  if (!planResult.ok) return planResult.response;

  return jsonResponse(
    ctx.requestId,
    await usageBody(ctx.store, authed.caller.account, ctx.now, planResult.plan),
  );
}
