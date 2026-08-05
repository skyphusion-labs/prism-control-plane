// Deciding what a gateway log row means for one ledger row. PURE.
//
// This file holds no I/O and no clock of its own. It takes a gateway row (src/aig-logs.ts) and the
// ledger row it joins to, and returns what should happen to the money. That separation is what makes
// the interesting cases testable at all: a row with no cost, a row that matches nothing we recorded, a
// row whose metadata names a different account than our ledger does. None of those can be provoked on
// demand from the real API, and every one of them is a case where moving money would be wrong.
//
// SEVEN OUTCOMES, AND FIVE OF THEM MOVE NOTHING. That ratio is the design. A reconciliation job is a
// robot with write access to a money column, fed from someone else's telemetry; the useful version of
// it refuses far more often than it acts, and says why each time.
//
//   adjust (spend)    the biller charged more than we estimated. `spent_micro_usd` rises.
//   adjust (credit)   the biller charged less than we estimated. `credit_micro_usd` rises.
//   in_agreement      the two numbers match to the micro-USD. The healthy case; nothing to write.
//   no_request_id     the row carries no `cf-aig-metadata.request_id`. Not traffic this plane sent.
//   cached            a gateway cache hit. Cost semantics are deliberately unresolved here; see below.
//   unknown_cost      the row carries no usable cost. Unknown is not zero, so nothing moves.
//   no_ledger_row     the row names a request we have no ledger entry for. A FINDING, not a no-op.
//   account_mismatch  metadata and ledger disagree on whose request this was. Refuse, loudly.
//
// WHY UPWARD DRIFT AND DOWNWARD DRIFT TAKE DIFFERENT PATHS. Both money columns on `accounts` are
// monotonic by construction (migration 0002), so each can be re-summed against its own audit trail.
// Charging more is a spend adjustment; charging less is a CREDIT GRANT rather than a decrement of
// spend. Decrementing would reach the same balance and destroy that property. See migration 0003.

import type { GatewayLogRow } from "./aig-logs";

/** The ledger row a gateway row is compared against. A projection, not the whole `UsageEvent`. */
export interface LedgerEstimate {
  id: string;
  request_id: string;
  account_id: string;
  period_key: string;
  model_id: string;
  /** What we charged, integer micro-USD. Zero on an unmetered row. */
  micro_usd: number;
  /**
   * Whether we could price it at all.
   *
   * An unmetered row is the case reconciliation exists for most of all: a timeout or a stream that never
   * sent its usage frame is recorded with a reason and a zero charge, and this is how it later acquires
   * the real cost instead of staying a permanent free ride.
   */
  metered: boolean;
}

export type SkipReason =
  | "no_request_id"
  | "cached"
  | "unknown_cost"
  | "no_ledger_row"
  | "account_mismatch";

export type ReconcileOutcome =
  | {
      outcome: "adjust";
      direction: "spend" | "credit";
      /** Always positive: the amount added to whichever monotonic column `direction` names. */
      appliedMicroUsd: number;
      /** gateway minus estimate. Signed, so the row records which way the meter was wrong. */
      deltaMicroUsd: number;
      estimateMicroUsd: number;
      gatewayMicroUsd: number;
      event: LedgerEstimate;
    }
  | {
      outcome: "in_agreement";
      microUsd: number;
      event: LedgerEstimate;
    }
  | {
      outcome: "skipped";
      reason: SkipReason;
      /** Operator prose. Goes to the log and the run report, never to a client. */
      detail: string;
    };

export interface ReconcileDecision {
  log: GatewayLogRow;
  outcome: ReconcileOutcome;
}

/**
 * Compare one gateway row against the ledger row it joins to.
 *
 * The ORDER of the refusals is the order of certainty, cheapest first, and each one is a different
 * fact about the world rather than a different flavour of failure.
 */
export function decideAdjustment(log: GatewayLogRow, event: LedgerEstimate | null): ReconcileOutcome {
  if (!log.requestId) {
    return {
      outcome: "skipped",
      reason: "no_request_id",
      detail:
        "the gateway row carries no cf-aig-metadata.request_id, so it cannot be attributed to a ledger " +
        "row. Traffic this plane sent always carries one; a row without it was sent by something else " +
        "on the same gateway",
    };
  }

  // A CACHE HIT IS DELIBERATELY OUT OF SCOPE, and skipping it is the conservative direction.
  //
  // The gateway runs with cache_ttl=0 precisely so this cannot happen (docs/ARCHITECTURE.md: a cached
  // answer costs nothing upstream, so the ledger would either charge for spend that did not occur or
  // serve free what it charged for). If caching is ever turned on before the ledger learns to read
  // `cf-aig-cache-status`, a cached row would arrive with cost 0 and this function would read it as
  // "the biller charged nothing" and refund the entire estimate as credit. Refusing here means a
  // premature cache change produces a visible skip count instead of silent free money.
  if (log.cached) {
    return {
      outcome: "skipped",
      reason: "cached",
      detail:
        "the gateway served this from cache. The gateway runs cache_ttl=0, so a cached row means the " +
        "cache was enabled without teaching the ledger to read cf-aig-cache-status; no money is moved",
    };
  }

  if (log.costMicroUsd === null) {
    return {
      outcome: "skipped",
      reason: "unknown_cost",
      detail:
        "the gateway row carries no usable cost, so what this request actually cost is unknown. An " +
        "absent cost is not a zero cost: reading it as free would turn a gap in Cloudflare's telemetry " +
        "into a credit refund",
    };
  }

  if (!event) {
    // A FINDING, and the only skip that should page someone. Either we spent money without recording
    // it (the residual gap src/routes/chat.ts documents on the upstream-error path: a provider that
    // fails after generating tokens bills us and writes nothing here), or the ledger write failed.
    return {
      outcome: "skipped",
      reason: "no_ledger_row",
      detail:
        `gateway log ${log.id} names request ${log.requestId} and cost ${log.costMicroUsd} micro-USD, ` +
        "but this plane has no ledger row for it. That is spend Cloudflare billed us and we did not " +
        "record",
    };
  }

  if (log.accountId && log.accountId !== event.account_id) {
    // Refuse rather than trust either side. Moving money on a row whose two identifiers disagree would
    // charge the wrong user, which is worse than not reconciling it at all.
    return {
      outcome: "skipped",
      reason: "account_mismatch",
      detail:
        `gateway log ${log.id} is tagged account ${log.accountId} but ledger row ${event.id} belongs to ` +
        `${event.account_id}. No adjustment was applied to either`,
    };
  }

  const estimateMicroUsd = event.metered ? event.micro_usd : 0;
  const gatewayMicroUsd = log.costMicroUsd;
  const deltaMicroUsd = gatewayMicroUsd - estimateMicroUsd;

  if (deltaMicroUsd === 0) {
    return { outcome: "in_agreement", microUsd: gatewayMicroUsd, event };
  }

  return {
    outcome: "adjust",
    direction: deltaMicroUsd > 0 ? "spend" : "credit",
    appliedMicroUsd: Math.abs(deltaMicroUsd),
    deltaMicroUsd,
    estimateMicroUsd,
    gatewayMicroUsd,
    event,
  };
}

/** The idempotency key a true-up is written under. One per gateway log row, forever. */
export function adjustmentIdempotencyKey(gatewayLogId: string): string {
  return `aig:${gatewayLogId}`;
}

export interface ReconcileTotals {
  rows: number;
  in_agreement: number;
  adjusted_spend: number;
  adjusted_credit: number;
  spend_micro_usd: number;
  credit_micro_usd: number;
  skipped_no_request_id: number;
  skipped_cached: number;
  skipped_unknown_cost: number;
  skipped_no_ledger_row: number;
  skipped_account_mismatch: number;
}

export function emptyTotals(): ReconcileTotals {
  return {
    rows: 0,
    in_agreement: 0,
    adjusted_spend: 0,
    adjusted_credit: 0,
    spend_micro_usd: 0,
    credit_micro_usd: 0,
    skipped_no_request_id: 0,
    skipped_cached: 0,
    skipped_unknown_cost: 0,
    skipped_no_ledger_row: 0,
    skipped_account_mismatch: 0,
  };
}

/**
 * Roll a run's decisions into the report an operator reads.
 *
 * EVERY OUTCOME GETS ITS OWN COUNTER. Collapsing the five skip reasons into one "skipped" number would
 * make the only alarming one (`no_ledger_row`, spend we never recorded) indistinguishable from the four
 * benign ones, and a single number nobody can decompose gets ignored the second time it is non-zero.
 */
export function tally(decisions: readonly ReconcileDecision[]): ReconcileTotals {
  const totals = emptyTotals();
  for (const decision of decisions) {
    totals.rows += 1;
    const outcome = decision.outcome;
    if (outcome.outcome === "in_agreement") {
      totals.in_agreement += 1;
      continue;
    }
    if (outcome.outcome === "adjust") {
      if (outcome.direction === "spend") {
        totals.adjusted_spend += 1;
        totals.spend_micro_usd += outcome.appliedMicroUsd;
      } else {
        totals.adjusted_credit += 1;
        totals.credit_micro_usd += outcome.appliedMicroUsd;
      }
      continue;
    }
    switch (outcome.reason) {
      case "no_request_id":
        totals.skipped_no_request_id += 1;
        break;
      case "cached":
        totals.skipped_cached += 1;
        break;
      case "unknown_cost":
        totals.skipped_unknown_cost += 1;
        break;
      case "no_ledger_row":
        totals.skipped_no_ledger_row += 1;
        break;
      case "account_mismatch":
        totals.skipped_account_mismatch += 1;
        break;
    }
  }
  return totals;
}

/**
 * How long a gateway row is given to become readable before the watermark may pass it. 15 minutes.
 *
 * NOT A GUESS AT LATENCY, A BOUND ON THE DAMAGE OF BEING WRONG ABOUT IT. The log feed is filtered on
 * `created_at`, so any row that appears with a timestamp already behind the watermark is invisible
 * forever: the next run asks for rows newer than the watermark and that one is not. Holding the
 * watermark back means the trailing edge is re-read on every run, and the unique idempotency key
 * (migration 0003) makes re-reading free. The cost of a longer lag is only that a true-up lands later.
 */
export const SETTLE_MS = 15 * 60 * 1000;

/**
 * Cap on rows one run will process. 2000 (40 pages of 50).
 *
 * A Worker invocation has a bounded lifetime, and an unbounded run against a backlog would be killed
 * partway with the watermark unadvanced, so the next run would redo the same doomed prefix forever. A
 * capped run makes progress, reports that it stopped early, and the next one continues.
 */
export const MAX_ROWS_PER_RUN = 2000;

/**
 * Where the watermark should sit after a run, or null to leave it alone.
 *
 * TWO RULES, both of which exist to make the watermark a value that was OBSERVED rather than assumed:
 *
 *   1. It never moves past `now - SETTLE_MS`, so late rows still fall inside the next query.
 *   2. It never moves BACKWARDS. A run that processed nothing, or whose newest row is older than where
 *      we already are, leaves it where it was. Rewinding would re-read rows already trued up (safe, by
 *      the idempotency key) but would also mean a single odd row could pull the window back
 *      indefinitely.
 */
export function nextWatermark(args: {
  current: string;
  newestProcessed: string | null;
  nowMs: number;
}): string | null {
  // COMPARED AS INSTANTS, NOT AS STRINGS. `current` came out of D1 and `newestProcessed` came out of
  // Cloudflare, so their textual shapes are two other systems' choices; a lexical comparison between
  // them is correct only for as long as both keep formatting timestamps identically. Parsing makes the
  // comparison mean what it says, and re-serialising the winner keeps one canonical shape in the column.
  const ceilingMs = args.nowMs - SETTLE_MS;
  const currentMs = Date.parse(args.current);
  const newestMs = args.newestProcessed === null ? NaN : Date.parse(args.newestProcessed);
  const candidateMs = Number.isFinite(newestMs) && newestMs < ceilingMs ? newestMs : ceilingMs;
  if (Number.isFinite(currentMs) && candidateMs <= currentMs) return null;
  return new Date(candidateMs).toISOString();
}
