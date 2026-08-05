// The prepaid spend gate. PURE.
//
// PREPAID ONLY, ruled 2026-08-04. There is no overage, no postpaid, no grace. An account may spend what
// it has been granted and not one request more. When the balance is gone the door answers 402 and stays
// shut until someone tops it up. This is the entire money model, and its simplicity is the feature: there
// is no state in which this plane is owed money by a user.
//
// WHAT THIS GATE CAN AND CANNOT DO, stated up front because the limitation is inherent and pretending
// otherwise would be the actual defect:
//
// The cost of a request is not known until the model answers. So the only thing checkable BEFORE spending
// is what has already been recorded. An account sitting just under its balance will therefore be allowed
// one more request, and that request can carry it negative. The overshoot is bounded by one request priced
// at the plan's max_output_tokens against the most expensive entitled model, which is why plans.ts refuses
// a plan whose output ceiling is not a positive integer: that number is what makes the bound real rather
// than rhetorical.
//
// The alternatives were considered and are worse. Reserving an estimate up front and refunding the
// difference doubles the write path and makes every crashed request leak a reservation. A hard mid-request
// abort would bill the tokens already generated and hand the client nothing. So: allow the overshoot,
// bound it, and say so in the contract.
//
// A NEGATIVE BALANCE IS NOT A DEBT. It is the recorded size of that single overshoot. Nobody is invoiced
// for it; the account simply cannot spend again until credit covers it.

export interface BalanceState {
  /** Integer micro-USD granted to this account, ever. Monotonic. */
  creditMicroUsd: number;
  /** Integer micro-USD recorded as spent, ever. Monotonic. */
  spentMicroUsd: number;
}

export type BalanceDecision =
  | { outcome: "allow"; remainingMicroUsd: number }
  | { outcome: "exhausted"; creditMicroUsd: number; spentMicroUsd: number }
  /** We could not establish the account's position, so we do not spend on its behalf. */
  | { outcome: "indeterminate"; reason: string };

/**
 * Decide whether one more request may be spent.
 *
 * `indeterminate` IS NOT `exhausted`, and the difference is load-bearing. Exhausted is a fact about the
 * account (402; the client should stop asking until it is topped up). Indeterminate is a fact about US
 * (503; it is a bug or a corrupted counter on this side). Mapping a broken counter to 402 would tell a
 * user who has paid that their credit is gone when it may be untouched -- the worst kind of wrong:
 * plausible, user-blaming, and invisible to us.
 *
 * Both refuse the request. Fail-closed either way: unmetered service is the one outcome this plane exists
 * to prevent.
 *
 * NOTE that spent is allowed to EXCEED credit here without being called indeterminate. That is the
 * bounded overshoot above, a normal state, not corruption. Only a value that cannot be money at all -- a
 * non-integer, or a negative -- is indeterminate.
 */
export function decideBalance(state: BalanceState): BalanceDecision {
  if (!Number.isInteger(state.creditMicroUsd) || state.creditMicroUsd < 0) {
    return {
      outcome: "indeterminate",
      reason: `granted credit ${String(state.creditMicroUsd)} is not a non-negative integer micro-USD`,
    };
  }
  if (!Number.isInteger(state.spentMicroUsd) || state.spentMicroUsd < 0) {
    return {
      outcome: "indeterminate",
      reason: `recorded spend ${String(state.spentMicroUsd)} is not a non-negative integer micro-USD`,
    };
  }
  if (state.spentMicroUsd >= state.creditMicroUsd) {
    return {
      outcome: "exhausted",
      creditMicroUsd: state.creditMicroUsd,
      spentMicroUsd: state.spentMicroUsd,
    };
  }
  return { outcome: "allow", remainingMicroUsd: state.creditMicroUsd - state.spentMicroUsd };
}

/**
 * Clamped remaining balance, for display.
 *
 * Never negative: an overshot account reads as 0 remaining rather than as a negative number a client would
 * have to interpret as a debt. The true signed position stays available to operators as credit minus spend.
 */
export function remainingMicroUsd(state: BalanceState): number {
  return Math.max(0, state.creditMicroUsd - state.spentMicroUsd);
}
