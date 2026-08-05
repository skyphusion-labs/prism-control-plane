// The spend gate: monthly allowance first, then prepaid credit. PURE.
//
// PREPAID ONLY ON THE CREDIT SIDE, ruled 2026-08-04 and kept. There is no overage, no postpaid, no
// grace. When both pools are gone the door answers 402 and stays shut until the next period
// (allowance) or a top-up (credit).
//
// TWO POOLS (issue #11):
//
//   monthly allowance   plan.monthly_included_micro_usd for the current UTC month. Spent first.
//                       Resets when the period_key rolls; unused expires, never becomes credit.
//   prepaid credit      accounts.credit_micro_usd - accounts.spent_micro_usd. Lifetime. Never expires.
//
// Spend order on every metered request: allowance first, then credit. A request can split across both.
//
// THE PRE-FLIGHT LIMITATION is the same as before: cost is unknown until the model answers, so the
// gate checks what is already recorded. An account can overshoot the combined remaining pool by at
// most one request, bounded by max_output_tokens against the most expensive entitled model.
//
// A NEGATIVE CREDIT BALANCE IS NOT A DEBT. It is the recorded size of that single overshoot. Nobody
// is invoiced for it; the account simply cannot spend again until credit covers it (or a new period
// restores allowance).

export interface BalanceState {
  /** Integer micro-USD granted to this account, ever. Monotonic. */
  creditMicroUsd: number;
  /** Integer micro-USD of prepaid credit recorded as spent, ever. Monotonic. */
  spentMicroUsd: number;
}

export interface SpendPools {
  creditMicroUsd: number;
  spentMicroUsd: number;
  /** Plan's monthly included grant for this period. Zero = pure prepaid. */
  monthlyIncludedMicroUsd: number;
  /** Allowance already consumed in this period. */
  allowanceSpentMicroUsd: number;
}

export type BalanceDecision =
  | { outcome: "allow"; remainingMicroUsd: number; remainingAllowanceMicroUsd: number; remainingCreditMicroUsd: number }
  | { outcome: "exhausted"; creditMicroUsd: number; spentMicroUsd: number; remainingAllowanceMicroUsd: number }
  /** We could not establish the account's position, so we do not spend on its behalf. */
  | { outcome: "indeterminate"; reason: string };

export interface ChargeAllocation {
  fromAllowanceMicroUsd: number;
  fromCreditMicroUsd: number;
}

/**
 * Remaining monthly allowance for the current period. Clamped at zero.
 *
 * Overshoot (allowanceSpent > monthlyIncluded) is a normal single-request overshoot state, not corruption.
 */
export function remainingAllowanceMicroUsd(pools: Pick<SpendPools, "monthlyIncludedMicroUsd" | "allowanceSpentMicroUsd">): number {
  if (!Number.isInteger(pools.monthlyIncludedMicroUsd) || pools.monthlyIncludedMicroUsd < 0) return 0;
  if (!Number.isInteger(pools.allowanceSpentMicroUsd) || pools.allowanceSpentMicroUsd < 0) return 0;
  return Math.max(0, pools.monthlyIncludedMicroUsd - pools.allowanceSpentMicroUsd);
}

/**
 * Clamped remaining prepaid credit, for display and for the gate.
 *
 * Never negative: an overshot account reads as 0 remaining rather than as a negative number a client
 * would have to interpret as a debt. The true signed position stays available to operators as credit
 * minus spend.
 */
export function remainingMicroUsd(state: BalanceState): number {
  return Math.max(0, state.creditMicroUsd - state.spentMicroUsd);
}

/**
 * Decide whether one more request may be spent against the two pools.
 *
 * `indeterminate` IS NOT `exhausted`. Exhausted is a fact about the account (402). Indeterminate is a
 * fact about US (503). Mapping a broken counter to 402 would tell a paying user their credit is gone
 * when it may be untouched.
 *
 * Allow when EITHER pool still has room (remaining allowance > 0, or spent < credit). Exhausted only
 * when both are gone.
 */
export function decideBalance(pools: SpendPools): BalanceDecision {
  if (!Number.isInteger(pools.creditMicroUsd) || pools.creditMicroUsd < 0) {
    return {
      outcome: "indeterminate",
      reason: `granted credit ${String(pools.creditMicroUsd)} is not a non-negative integer micro-USD`,
    };
  }
  if (!Number.isInteger(pools.spentMicroUsd) || pools.spentMicroUsd < 0) {
    return {
      outcome: "indeterminate",
      reason: `recorded spend ${String(pools.spentMicroUsd)} is not a non-negative integer micro-USD`,
    };
  }
  if (!Number.isInteger(pools.monthlyIncludedMicroUsd) || pools.monthlyIncludedMicroUsd < 0) {
    return {
      outcome: "indeterminate",
      reason: `monthly included ${String(pools.monthlyIncludedMicroUsd)} is not a non-negative integer micro-USD`,
    };
  }
  if (!Number.isInteger(pools.allowanceSpentMicroUsd) || pools.allowanceSpentMicroUsd < 0) {
    return {
      outcome: "indeterminate",
      reason: `allowance spent ${String(pools.allowanceSpentMicroUsd)} is not a non-negative integer micro-USD`,
    };
  }

  const remainingAllowance = remainingAllowanceMicroUsd(pools);
  const remainingCredit = remainingMicroUsd({
    creditMicroUsd: pools.creditMicroUsd,
    spentMicroUsd: pools.spentMicroUsd,
  });

  if (remainingAllowance === 0 && pools.spentMicroUsd >= pools.creditMicroUsd) {
    return {
      outcome: "exhausted",
      creditMicroUsd: pools.creditMicroUsd,
      spentMicroUsd: pools.spentMicroUsd,
      remainingAllowanceMicroUsd: 0,
    };
  }

  return {
    outcome: "allow",
    remainingMicroUsd: remainingAllowance + remainingCredit,
    remainingAllowanceMicroUsd: remainingAllowance,
    remainingCreditMicroUsd: remainingCredit,
  };
}

/**
 * Split one metered charge across allowance then credit.
 *
 * Allowance is taken first up to what remains; the rest is credit (which may overshoot). Unmetered
 * charges never reach this function.
 */
export function allocateCharge(
  microUsd: number,
  pools: Pick<SpendPools, "monthlyIncludedMicroUsd" | "allowanceSpentMicroUsd">,
): ChargeAllocation {
  if (!Number.isInteger(microUsd) || microUsd <= 0) {
    return { fromAllowanceMicroUsd: 0, fromCreditMicroUsd: 0 };
  }
  const remainingAllowance = remainingAllowanceMicroUsd(pools);
  const fromAllowance = Math.min(microUsd, remainingAllowance);
  return {
    fromAllowanceMicroUsd: fromAllowance,
    fromCreditMicroUsd: microUsd - fromAllowance,
  };
}
