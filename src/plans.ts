// Plan entitlements: turning a stored plan row into a usable decision, or refusing to.
//
// Pure. The D1 read lives in store-d1.ts; everything here is testable against the values that matter
// rather than against whatever the seeded plan happens to be.

import type { ModelTier } from "./catalog";
import type { PlanRow } from "./store";

export interface Plan {
  id: string;
  name: string;
  /** Period allowance in integer micro-USD. */
  includedMicroUsd: number;
  requestsPerMinute: number;
  maxOutputTokens: number;
  allowedTiers: ModelTier[];
}

const KNOWN_TIERS: readonly string[] = ["standard", "premium"];

/**
 * Parse `allowed_tiers` ("standard,premium").
 *
 * An UNRECOGNISED tier name is DROPPED, not passed through. The value is compared against the
 * catalog's tier set, and a typo like "standrd" that survived would silently entitle nothing anyway;
 * dropping it keeps the parsed shape honest so the entitlement check below has no unknown members to
 * reason about. A plan that parses to an empty tier list entitles no model, which is the safe
 * direction: it fails visibly on the first request rather than opening the catalog.
 */
export function parseTiers(raw: string): ModelTier[] {
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => KNOWN_TIERS.includes(part)) as ModelTier[];
}

export type PlanResult =
  | { ok: true; plan: Plan }
  | { ok: false; reason: string };

/**
 * Validate a stored plan row into a Plan, or refuse.
 *
 * REFUSING IS THE POINT. Every field here prices or bounds something, and a plane that patches a
 * malformed plan with a default has invented a policy at runtime. The three failure directions this
 * closes, all of which have a wrong-but-plausible fallback someone would otherwise reach for:
 *
 *   A non-integer or negative allowance. "Round it" or "treat it as 0" are both decisions this code
 *   does not get to make; one bills from the first micro-USD, the other refuses everything. Neither
 *   is what a typo meant.
 *
 *   A non-positive rate limit. Defaulting to some number would mean the operator's intent (throttle
 *   this plan) is replaced by ours.
 *
 *   A non-positive output ceiling. This is the number that BOUNDS the single-request quota overshoot,
 *   so a bad value there quietly invalidates the honest statement in docs/CONTRACT.md about how far
 *   an account can exceed its allowance.
 *
 * A refusal surfaces as 503 unavailable, which is the fail-closed answer: the plane cannot say what
 * this caller is entitled to, so it does not spend on their behalf.
 */
export function planFromRow(row: PlanRow): PlanResult {
  if (!Number.isInteger(row.included_micro_usd) || row.included_micro_usd < 0) {
    return {
      ok: false,
      reason:
        `plan "${row.id}" has included_micro_usd ${String(row.included_micro_usd)}, which is not a ` +
        "non-negative integer. Refusing rather than coercing it: a malformed allowance and a chosen " +
        "allowance of zero must not be the same outcome",
    };
  }
  if (!Number.isInteger(row.requests_per_minute) || row.requests_per_minute <= 0) {
    return {
      ok: false,
      reason: `plan "${row.id}" has requests_per_minute ${String(row.requests_per_minute)}, which is not a positive integer`,
    };
  }
  if (!Number.isInteger(row.max_output_tokens) || row.max_output_tokens <= 0) {
    return {
      ok: false,
      reason: `plan "${row.id}" has max_output_tokens ${String(row.max_output_tokens)}, which is not a positive integer`,
    };
  }
  return {
    ok: true,
    plan: {
      id: row.id,
      name: row.name,
      includedMicroUsd: row.included_micro_usd,
      requestsPerMinute: row.requests_per_minute,
      maxOutputTokens: row.max_output_tokens,
      allowedTiers: parseTiers(row.allowed_tiers),
    },
  };
}

export function entitlesTier(plan: Plan, tier: ModelTier): boolean {
  return plan.allowedTiers.includes(tier);
}

/**
 * The effective output cap for one request: the smallest of what the client asked for, what the plan
 * allows, and what the model advertises.
 *
 * CLAMPS RATHER THAN REJECTS, and the contract promises that. The cap exists to bound one request's
 * cost, and a client should not need to know the plan's number to make a successful call. The applied
 * value is reported back in `prism-max-tokens-applied` so the clamp is visible rather than silent.
 */
export function effectiveMaxTokens(
  requested: number | undefined,
  planMax: number,
  modelMax: number,
): number {
  const ceiling = Math.min(planMax, modelMax);
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.max(1, Math.min(Math.floor(requested), ceiling));
}

/** The client-facing projection of a plan. */
export function publicPlan(plan: Plan): Record<string, unknown> {
  return {
    id: plan.id,
    name: plan.name,
    included_micro_usd: plan.includedMicroUsd,
    requests_per_minute: plan.requestsPerMinute,
    max_output_tokens: plan.maxOutputTokens,
    allowed_tiers: plan.allowedTiers,
  };
}
