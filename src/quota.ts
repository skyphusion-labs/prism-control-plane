// The pre-flight spend gate. PURE.
//
// WHAT THIS GATE CAN AND CANNOT DO, stated up front because the limitation is inherent and pretending
// otherwise would be the actual defect:
//
// The cost of a request is not known until the model answers. So the only thing checkable BEFORE
// spending is usage already recorded. An account sitting just under its allowance will therefore be
// allowed one more request, and that request can carry it over. The overshoot is bounded by one
// request priced at the plan's max_output_tokens, which is why plans.ts refuses a plan whose output
// ceiling is not a positive integer: that number is what makes this bound real rather than rhetorical.
//
// The alternatives were considered and are worse. Reserving an estimate up front and refunding the
// difference doubles the write path and makes every crashed request leak a reservation. Metering
// mid-stream cannot work for a non-streaming call at all. A hard mid-request abort would bill the
// tokens already generated and hand the client nothing. So: allow the overshoot, bound it, and say so
// in the contract.

export interface AllowanceState {
  /** Integer micro-USD already recorded for the period. */
  usedMicroUsd: number;
  /** Integer micro-USD included by the plan for the period. */
  includedMicroUsd: number;
}

export type AllowanceDecision =
  | { outcome: "allow"; remainingMicroUsd: number }
  | { outcome: "exhausted"; usedMicroUsd: number; includedMicroUsd: number }
  /** We could not establish the account's position, so we do not spend on its behalf. */
  | { outcome: "indeterminate"; reason: string };

/**
 * Decide whether one more request may be spent.
 *
 * `indeterminate` IS NOT `exhausted`, and the difference is load-bearing. Exhausted is a fact about the
 * account (402, and the client should stop asking until the period rolls). Indeterminate is a fact
 * about US (503, and it is a bug or a misconfiguration on this side). Mapping a broken counter to 402
 * would tell a paying user their allowance is spent when it may be untouched, which is the worst kind
 * of wrong: plausible, user-blaming, and invisible to us.
 *
 * Both refuse the request. Fail-closed either way: unmetered service is the one outcome this plane
 * exists to prevent.
 */
export function decideAllowance(state: AllowanceState): AllowanceDecision {
  if (!Number.isInteger(state.includedMicroUsd) || state.includedMicroUsd < 0) {
    return {
      outcome: "indeterminate",
      reason: `included allowance ${String(state.includedMicroUsd)} is not a non-negative integer micro-USD`,
    };
  }
  if (!Number.isInteger(state.usedMicroUsd) || state.usedMicroUsd < 0) {
    return {
      outcome: "indeterminate",
      reason: `recorded period usage ${String(state.usedMicroUsd)} is not a non-negative integer micro-USD`,
    };
  }
  if (state.usedMicroUsd >= state.includedMicroUsd) {
    return {
      outcome: "exhausted",
      usedMicroUsd: state.usedMicroUsd,
      includedMicroUsd: state.includedMicroUsd,
    };
  }
  return { outcome: "allow", remainingMicroUsd: state.includedMicroUsd - state.usedMicroUsd };
}

/** Clamped remaining, for display. Never negative: an overshot period reads as 0 remaining, not as a
 * negative allowance a client would have to interpret. */
export function remainingMicroUsd(state: AllowanceState): number {
  return Math.max(0, state.includedMicroUsd - state.usedMicroUsd);
}
