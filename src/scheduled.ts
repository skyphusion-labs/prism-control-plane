// Cron entry for automated reconciliation (and future scheduled work).
//
// MONEY POSTURE: the cron defaults to DRY RUN. Only an explicit env flag turns on live apply.
// That keeps the original design (a robot with write access to a money column should not fire
// live until a human has watched dry reports) while still continuous-monitoring drift.
//
// First-run floor: when D1 has no watermark, the tick supplies `since` = now minus
// RECONCILE_CRON_INITIAL_LOOKBACK_MS (default 7 days) so the gateway history is not paged from epoch.
// Dry runs do not advance the watermark; live runs do (via runReconcile).

import { newId } from "./crypto";
import type { Env } from "./env";
import type { GatewayLogSource } from "./aig-logs";
import { runReconcile, type ReconcileRunResult } from "./reconcile-run";
import type { ControlPlaneStore } from "./store";

/** Default lookback when no watermark exists yet. 7 days. */
export const DEFAULT_INITIAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Live money writes on the cron require the literal string "true".
 * Anything else (absent, "1", "yes", "false") stays dry-run.
 */
export function reconcileCronLive(env: Env): boolean {
  return (env.RECONCILE_CRON_LIVE ?? "").trim().toLowerCase() === "true";
}

/**
 * Optional override for first-run lookback, in whole days (1..30).
 * Malformed or out of range falls back to 7 days.
 */
export function initialLookbackMs(env: Env): number {
  const raw = (env.RECONCILE_CRON_INITIAL_LOOKBACK_DAYS ?? "").trim();
  if (!raw) return DEFAULT_INITIAL_LOOKBACK_MS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 30) return DEFAULT_INITIAL_LOOKBACK_MS;
  return days * 24 * 60 * 60 * 1000;
}

export interface ScheduledTickArgs {
  store: ControlPlaneStore;
  /** Null closes the tick with a structured skip (half-configured deploy). */
  logs: GatewayLogSource | null;
  now: Date;
  dryRun: boolean;
  lookbackMs: number;
  newId?: () => string;
}

export type ScheduledTickResult =
  | { outcome: "skipped"; reason: "no_logs" }
  | { outcome: "reconcile"; result: ReconcileRunResult; dryRun: boolean };

/**
 * One cron tick. Exported so tests drive the same body as workerd scheduled().
 *
 * Does not throw across the tick boundary: failures are logged and returned so a future
 * second consumer on the same cron is not skipped by an uncaught throw (vivijure pattern).
 */
export async function runScheduledTick(args: ScheduledTickArgs): Promise<ScheduledTickResult> {
  if (!args.logs) {
    console.info("scheduled tick skipped", {
      event: "scheduled.skip",
      reason: "no_logs",
      detail: "CF_ACCOUNT_ID, AI_GATEWAY_ID, and CF_AIG_TOKEN required for reconcile cron",
    });
    return { outcome: "skipped", reason: "no_logs" };
  }

  const state = await args.store.getReconcileState(args.logs.gatewayId);
  const since =
    state?.watermark && !Number.isNaN(Date.parse(state.watermark))
      ? null
      : new Date(args.now.getTime() - args.lookbackMs).toISOString();

  console.info("scheduled reconcile start", {
    event: "scheduled.reconcile_start",
    dry_run: args.dryRun,
    gateway_id: args.logs.gatewayId,
    has_watermark: Boolean(state?.watermark),
    since_floor: since,
  });

  try {
    const result = await runReconcile({
      store: args.store,
      source: args.logs,
      now: args.now,
      dryRun: args.dryRun,
      since,
      newId: args.newId ?? (() => newId("adj")),
    });
    if (!result.ok) {
      console.error("scheduled reconcile failed", {
        event: "scheduled.reconcile_error",
        reason: result.reason,
        detail: result.detail,
        dry_run: args.dryRun,
      });
    }
    return { outcome: "reconcile", result, dryRun: args.dryRun };
  } catch (err) {
    console.error("scheduled reconcile threw", {
      event: "scheduled.reconcile_threw",
      error: err instanceof Error ? err.message : String(err),
      dry_run: args.dryRun,
    });
    return {
      outcome: "reconcile",
      dryRun: args.dryRun,
      result: {
        ok: false,
        reason: "upstream",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
