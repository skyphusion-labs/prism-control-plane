// Driving one reconciliation run: page the gateway feed, apply what src/reconcile.ts decided, move the
// watermark. This is the impure half of the pair.
//
// src/reconcile.ts is pure by construction and says so in its header. Everything that needs a clock, a
// database or a network call lives here instead, and reaches both through injected seams
// (`ControlPlaneStore`, `GatewayLogSource`). That is the same split the request path already uses, and it
// is what lets the interesting failures be unit tests: a truncated backlog, a page of rows with no cost,
// a ledger row the gateway never saw, a run that must not advance its watermark.
//
// A DRY RUN IS THE DEFAULT EVERYWHERE, and it is not a formality. This is a robot with write access to a
// money column, driven by another system's telemetry. The dry run does every read, every join and every
// decision, and reports exactly what it would move; it writes nothing at all, INCLUDING the watermark and
// the run counters. A dry run that advanced the watermark would be a live run that forgot to pay, and
// would leave the rows it "previewed" permanently unreconciled.
//
// THE FIRST RUN MUST BE GIVEN A FLOOR. With no stored watermark there is no lower bound, and defaulting
// to the epoch would page the gateway's entire retained history on the first call. The caller supplies
// `since` once; every later run reads the watermark.

import { MAX_PER_PAGE, type GatewayLogRow, type GatewayLogSource } from "./aig-logs";
import {
  MAX_ROWS_PER_RUN,
  SETTLE_MS,
  adjustmentIdempotencyKey,
  decideAdjustment,
  nextWatermark,
  tally,
  type LedgerEstimate,
  type ReconcileDecision,
  type ReconcileTotals,
} from "./reconcile";
import type { ControlPlaneStore, UsageAdjustmentRow } from "./store";

/** Cap on ledger rows the reverse check will look at in one run. Bounded scan, never the whole table. */
export const MAX_REVERSE_CHECK_ROWS = 500;

/**
 * Fraction of the biller's total that our estimate may be off by before the run says so out loud. 5%.
 *
 * A RATIO, NOT AN ABSOLUTE. A fixed micro-USD threshold would fire constantly on a busy day and never on
 * a quiet one, so it would be tuned to whichever the operator saw first and then ignored. Measured
 * against the gateway's own total, "5% of what we were actually billed" means the same thing at any
 * volume.
 */
export const DRIFT_ALERT_RATIO = 0.05;

/** One thing an operator should look at, carried out of the run rather than left in a log line. */
export interface ReconcileFinding {
  kind: "no_ledger_row" | "account_mismatch" | "unmatched_ledger_row" | "malformed_rows";
  detail: string;
}

/** A ledger row inside the window that no gateway row in the window accounted for. */
export interface UnmatchedLedgerRow {
  id: string;
  request_id: string;
  micro_usd: number;
  metered: boolean;
  created_at: string;
}

export interface ReconcileReport {
  gateway_id: string;
  dry_run: boolean;
  /** ISO. The exclusive lower bound the feed was queried from. */
  window_from: string;
  /** ISO. `now - SETTLE_MS`: the newest instant this run is willing to consider settled. */
  window_to: string;
  watermark_before: string | null;
  /** Null when the run left the watermark alone, which is always true of a dry run. */
  watermark_after: string | null;
  pages: number;
  /** True when the row cap stopped the run early. The next run continues from the new watermark. */
  truncated: boolean;
  /** Rows the API returned that could not be parsed. Counted, never silently dropped. */
  malformed_rows: number;
  /** True-ups this run actually wrote. Always 0 on a dry run. */
  applied: number;
  /** True-ups a previous run had already written. Idempotency working, not an error. */
  already_applied: number;
  totals: ReconcileTotals;
  /** Absolute drift as a fraction of the biller's total, or null when the biller total was zero. */
  drift_ratio: number | null;
  /** True when `drift_ratio` exceeded DRIFT_ALERT_RATIO. The number an alert rule watches. */
  drift_alert: boolean;
  unmatched_ledger_rows: UnmatchedLedgerRow[];
  findings: ReconcileFinding[];
}

export interface ReconcileRunArgs {
  store: ControlPlaneStore;
  source: GatewayLogSource;
  /** The one clock for the run. Injected so the settling window and the watermark are pinnable. */
  now: Date;
  /** False writes money. Callers default this to true; see the file header. */
  dryRun: boolean;
  /** ISO floor, used ONLY when the gateway has no stored watermark. */
  since?: string | null;
  maxRows?: number;
  perPage?: number;
  /** Adjustment row id minting, injected so a test can assert on stable ids. */
  newId: () => string;
}

export type ReconcileRunResult =
  | { ok: true; report: ReconcileReport }
  | { ok: false; reason: "no_floor" | "upstream"; detail: string };

/**
 * The ledger projection a decision is made against.
 *
 * A separate shape from `UsageEvent` because the decision must not be able to see anything else. The
 * whole row carries a model id, an upstream status and token counts, and none of those may influence
 * whether money moves; narrowing here is what makes that structural instead of a review note.
 */
function ledgerEstimate(event: {
  id: string;
  request_id: string;
  account_id: string;
  period_key: string;
  model_id: string;
  micro_usd: number;
  metered: boolean;
}): LedgerEstimate {
  return {
    id: event.id,
    request_id: event.request_id,
    account_id: event.account_id,
    period_key: event.period_key,
    model_id: event.model_id,
    micro_usd: event.micro_usd,
    metered: event.metered,
  };
}

/**
 * Whether this row can possibly need its ledger row read.
 *
 * The lookup is skipped for rows `decideAdjustment` refuses before it ever looks at the event, so a page
 * of traffic from another tenant of the same gateway costs zero D1 reads. The predicate MIRRORS the first
 * three refusals in that function and must stay in step with them; the test asserts the pairing rather
 * than trusting the comment.
 */
export function needsLedgerLookup(log: GatewayLogRow): boolean {
  return log.requestId !== null && !log.cached && log.costMicroUsd !== null;
}

/**
 * One reconciliation run.
 *
 * The ORDER of operations is the safety property: every row is decided and applied before the watermark
 * moves, and the watermark move is the last write. A run that dies partway therefore re-reads the rows it
 * did not finish, and the unique idempotency key on `usage_adjustments` makes re-reading the ones it did
 * finish a no-op. There is no ordering here that can lose a row or charge one twice.
 */
export async function runReconcile(args: ReconcileRunArgs): Promise<ReconcileRunResult> {
  const gatewayId = args.source.gatewayId;
  const state = await args.store.getReconcileState(gatewayId);
  const floor = state?.watermark ?? ((args.since ?? "").trim() || null);
  if (!floor || Number.isNaN(Date.parse(floor))) {
    return {
      ok: false,
      reason: "no_floor",
      detail:
        `Gateway ${gatewayId} has no reconciliation watermark yet, so this run has no lower bound. ` +
        'Supply "since" as an ISO 8601 timestamp on the first run; later runs read the watermark. It is ' +
        "required rather than defaulted because defaulting to the epoch would page the gateway's entire " +
        "retained log history.",
    };
  }

  const nowMs = args.now.getTime();
  const windowTo = new Date(nowMs - SETTLE_MS).toISOString();
  const maxRows = Math.max(1, Math.trunc(args.maxRows ?? MAX_ROWS_PER_RUN));
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.trunc(args.perPage ?? MAX_PER_PAGE)));

  const decisions: ReconcileDecision[] = [];
  const findings: ReconcileFinding[] = [];
  const seenRequestIds = new Set<string>();
  let malformed = 0;
  let pages = 0;
  let truncated = false;
  let applied = 0;
  let alreadyApplied = 0;
  let newestProcessed: string | null = null;
  let lastLogId: string | null = null;

  for (let page = 1; ; page += 1) {
    let batch;
    try {
      batch = await args.source.listSince({ sinceIso: floor, page, perPage });
    } catch (err) {
      // REPORTED, NOT SWALLOWED, and the watermark is not touched. A token missing AI Gateway Read and a
      // malformed filter are different operator actions, and "reconcile ran, found nothing" is the one
      // answer this must never give when it could not read the feed at all.
      return { ok: false, reason: "upstream", detail: err instanceof Error ? err.message : String(err) };
    }
    pages += 1;
    malformed += batch.malformed;

    for (const log of batch.rows) {
      // The settling ceiling is enforced ROW BY ROW, not just on the watermark. Cloudflare's filter is a
      // lower bound only, so a page can contain rows newer than the settled instant; processing one would
      // true it up before its cost figure is necessarily final.
      if (Date.parse(log.createdAt) > nowMs - SETTLE_MS) {
        truncated = true;
        break;
      }
      if (decisions.length >= maxRows) {
        truncated = true;
        break;
      }

      const event = needsLedgerLookup(log)
        ? await args.store.getUsageEventByRequestId(log.requestId as string)
        : null;
      const outcome = decideAdjustment(log, event ? ledgerEstimate(event) : null);
      decisions.push({ log, outcome });
      if (log.requestId) seenRequestIds.add(log.requestId);
      newestProcessed = log.createdAt;
      lastLogId = log.id;

      if (outcome.outcome === "skipped") {
        if (outcome.reason === "no_ledger_row" || outcome.reason === "account_mismatch") {
          findings.push({ kind: outcome.reason, detail: outcome.detail });
        }
        continue;
      }
      if (outcome.outcome !== "adjust" || args.dryRun) continue;

      const row: UsageAdjustmentRow = {
        id: args.newId(),
        account_id: outcome.event.account_id,
        usage_event_id: outcome.event.id,
        request_id: outcome.event.request_id,
        gateway_log_id: log.id,
        // THE LEDGER ROW'S PERIOD, not the current month. A true-up for a request made on the 31st can
        // land on the 1st, and putting it in the new month would move money out of the month whose
        // rollup it corrects, leaving both months wrong.
        period_key: outcome.event.period_key,
        model_id: log.model ?? outcome.event.model_id,
        estimate_micro_usd: outcome.estimateMicroUsd,
        gateway_micro_usd: outcome.gatewayMicroUsd,
        delta_micro_usd: outcome.deltaMicroUsd,
        direction: outcome.direction,
        applied_micro_usd: outcome.appliedMicroUsd,
        idempotency_key: adjustmentIdempotencyKey(log.id),
        note: `ai gateway true-up: estimate ${outcome.estimateMicroUsd}, billed ${outcome.gatewayMicroUsd} micro-USD`,
      };
      const result = await args.store.applyUsageAdjustment(row);
      if (result.applied) applied += 1;
      else alreadyApplied += 1;
    }

    if (truncated) break;
    // A short page is the end of the feed. Cloudflare returns a full page while more remain, so this is
    // the termination condition rather than a `total_count` comparison that a concurrent write can move.
    if (batch.rows.length + batch.malformed < perPage) break;
  }

  if (malformed > 0) {
    findings.push({
      kind: "malformed_rows",
      detail:
        `${malformed} row(s) in this window could not be read as gateway log rows and were not ` +
        "reconciled. Either Cloudflare changed the response shape or the feed is corrupt; neither is " +
        "safe to treat as an empty result",
    });
  }

  const totals = tally(decisions);
  const advance = nextWatermark({ current: floor, newestProcessed, nowMs });

  // THE REVERSE CHECK, and it runs on a dry run too: it moves no money, and being able to see the
  // finding without authorising a write is most of its value. Bounded by MAX_REVERSE_CHECK_ROWS because
  // an unbounded ledger scan is not something a request path may do.
  const unmatched: UnmatchedLedgerRow[] = [];
  const ledgerRows = await args.store.listUsageEventsBetween({
    fromIso: floor,
    toIso: windowTo,
    limit: MAX_REVERSE_CHECK_ROWS,
  });
  for (const row of ledgerRows) {
    if (seenRequestIds.has(row.request_id)) continue;
    unmatched.push({
      id: row.id,
      request_id: row.request_id,
      micro_usd: row.micro_usd,
      metered: row.metered,
      created_at: row.created_at,
    });
  }
  if (unmatched.length > 0) {
    findings.push({
      kind: "unmatched_ledger_row",
      detail:
        `${unmatched.length} ledger row(s) in this window have no gateway row: a request this plane ` +
        "metered that the gateway did not record. APPROXIMATE AT THE WINDOW EDGES -- a ledger row is " +
        "written after the response, so its timestamp is later than the gateway's, and a row just inside " +
        "the lower bound can have its gateway row just outside it. Treat a persistent count as the finding",
    });
  }

  // DRIFT MEASURED AGAINST WHAT THE BILLER SAID, so the ratio answers "how wrong was our meter" rather
  // than "how much did we serve". Both directions count toward it: over-charging a user by 20% is exactly
  // as much of a defect as under-charging, and summing them signed would let the two hide each other.
  //
  // A window whose compared rows cost nothing has NO ratio rather than a zero one. Dividing by zero would
  // publish NaN or, worse, a falsely healthy 0 on a window where nothing was checked at all.
  const absoluteDrift = totals.spend_micro_usd + totals.credit_micro_usd;
  const gatewayTotal = decisions.reduce(
    (sum, d) =>
      sum +
      (d.outcome.outcome === "adjust"
        ? d.outcome.gatewayMicroUsd
        : d.outcome.outcome === "in_agreement"
          ? d.outcome.microUsd
          : 0),
    0,
  );
  const driftRatio = gatewayTotal > 0 ? absoluteDrift / gatewayTotal : null;

  const report: ReconcileReport = {
    gateway_id: gatewayId,
    dry_run: args.dryRun,
    window_from: floor,
    window_to: windowTo,
    watermark_before: state?.watermark ?? null,
    watermark_after: args.dryRun ? null : advance,
    pages,
    truncated,
    malformed_rows: malformed,
    applied,
    already_applied: alreadyApplied,
    totals,
    drift_ratio: driftRatio,
    drift_alert: driftRatio !== null && driftRatio > DRIFT_ALERT_RATIO,
    unmatched_ledger_rows: unmatched,
    findings,
  };

  // THE LAST WRITE, and only on a live run. Recording the run before applying the rows would let a crash
  // step over rows nobody ever looked at.
  if (!args.dryRun) {
    await args.store.advanceReconcileState({
      gateway_id: gatewayId,
      watermark: advance,
      last_log_id: lastLogId,
      rows_seen: totals.rows,
      rows_adjusted: applied,
      at: args.now.toISOString(),
    });
  }

  emitRunLog(report);
  return { ok: true, report };
}

/**
 * The run as structured logs, for Workers observability and the Grafana panels built on it.
 *
 * TWO LINES WITH DIFFERENT LEVELS, because they answer different questions and only one of them should
 * ever wake anybody. The `info` line is the time series (rows, drift, skips) and is emitted every run.
 * The `error` line is emitted ONLY on a condition an operator must act on -- spend Cloudflare billed that
 * this plane never recorded, an account id that disagrees with itself, or drift past the ratio -- so an
 * alert rule can be "this event exists" rather than a threshold on a number somebody has to re-tune.
 *
 * The fields are flat and named for the query, not for the type. Nothing here carries prompt or
 * completion text, and nothing here carries a bearer: the whole payload is counts, ids and amounts.
 */
function emitRunLog(report: ReconcileReport): void {
  console.log("reconcile run", {
    event: "reconcile.run",
    gateway_id: report.gateway_id,
    dry_run: report.dry_run,
    window_from: report.window_from,
    window_to: report.window_to,
    rows: report.totals.rows,
    in_agreement: report.totals.in_agreement,
    adjusted_spend: report.totals.adjusted_spend,
    adjusted_credit: report.totals.adjusted_credit,
    spend_micro_usd: report.totals.spend_micro_usd,
    credit_micro_usd: report.totals.credit_micro_usd,
    applied: report.applied,
    already_applied: report.already_applied,
    skipped_no_request_id: report.totals.skipped_no_request_id,
    skipped_cached: report.totals.skipped_cached,
    skipped_unknown_cost: report.totals.skipped_unknown_cost,
    skipped_no_ledger_row: report.totals.skipped_no_ledger_row,
    skipped_account_mismatch: report.totals.skipped_account_mismatch,
    unmatched_ledger_rows: report.unmatched_ledger_rows.length,
    malformed_rows: report.malformed_rows,
    drift_ratio: report.drift_ratio,
    truncated: report.truncated,
    watermark_after: report.watermark_after,
  });

  const alarming =
    report.totals.skipped_no_ledger_row +
    report.totals.skipped_account_mismatch +
    report.unmatched_ledger_rows.length;
  if (alarming === 0 && !report.drift_alert) return;
  console.error("reconcile needs attention", {
    event: "reconcile.alert",
    gateway_id: report.gateway_id,
    dry_run: report.dry_run,
    drift_alert: report.drift_alert,
    drift_ratio: report.drift_ratio,
    unrecorded_spend_rows: report.totals.skipped_no_ledger_row,
    account_mismatch_rows: report.totals.skipped_account_mismatch,
    unmatched_ledger_rows: report.unmatched_ledger_rows.length,
    findings: report.findings.map((f) => f.kind),
  });
}
