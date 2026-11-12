// The per-account in-flight cap (#100, options B and D).
//
// WHY THIS EXISTS. The prepaid gate (balance.ts) reads the recorded balance and reserves nothing, and
// a charge is written only when a request settles. One request at a time, an account can overshoot its
// remaining pool by at most that one request. With several requests in flight, every one of them reads
// the same balance and passes, so the overshoot is one request PER IN-FLIGHT REQUEST, and an async job
// (priced in the Workflow, after it was admitted) is in flight for minutes. Without a cap the bound is
// not a number. This cap makes it one:
//
//     overshoot <= cap x (the most one request or job can cost)
//
// WHAT COUNTS. Every admitted spend that has not yet been charged:
//   - a live slot in inflight_slots (a sync request, a chat stream until its settle, a live voice
//     session until the session DO finalizes), and
//   - a running async job (async_jobs.status = 'running'), which is priced after admission.
// An async request holds a slot while its handler runs, and its job row counts after that, so there
// is no moment where it counts as zero.
//
// THE CLAIM IS ONE ATOMIC WRITE. store.claimInflightSlot counts and inserts in a single statement, so
// concurrent requests cannot all read the same count and all pass. Callers must not count first and
// insert later.
//
// A LEAKED SLOT EXPIRES. A slot is released when its request settles. If a release never runs (an
// isolate dies mid-request), the slot expires after its TTL, and a running job row stops counting after
// ASYNC_JOB_COUNT_SEC. A leak lowers the account's concurrency for a while. It never moves money, and
// it never raises the cap.
//
// FAIL CLOSED. A claim that cannot be written answers 503. Admitting a request because the counter is
// unreadable would remove the bound at exactly the moment nobody can see it.

import { errorResponse } from "./http";
import type { Ctx } from "./routes/shared";

/** The cap when MAX_IN_FLIGHT_PER_ACCOUNT is not set. Four: a phone, a tablet, a browser and one job. */
export const DEFAULT_MAX_IN_FLIGHT = 4;

/** The largest cap the env var may set. The bound is cap x one request, so the cap is part of the price. */
export const MAX_MAX_IN_FLIGHT = 32;

/** A sync request or a chat stream. Longer than any request the plane serves; the release is the norm. */
export const SYNC_HOLD_SEC = 30 * 60;

/** A live voice session: FLUX_MAX_SESSION_MS (15 min) plus five minutes for the finalize write. */
export const VOICE_HOLD_SEC = 20 * 60;

/** A running async job stops counting this long after it was created, if nothing marked it done. */
export const ASYNC_JOB_COUNT_SEC = 2 * 60 * 60;

/** Seconds a refused client waits. A slot frees when a request settles, which is seconds for chat. */
export const IN_FLIGHT_RETRY_AFTER_SEC = 5;

export type InflightKind = "chat" | "nonchat" | "voice";

/** The slot a request holds. The id is the request id, so the session DO can release it too. */
export interface InflightHold {
  id: string;
  accountId: string;
}

/** The cap from MAX_IN_FLIGHT_PER_ACCOUNT: an integer 1..32, or the default for anything else. */
export function inFlightCap(raw: string | undefined): number {
  const s = (raw ?? "").trim();
  if (!/^[0-9]+$/.test(s)) return DEFAULT_MAX_IN_FLIGHT;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) return DEFAULT_MAX_IN_FLIGHT;
  return Math.min(n, MAX_MAX_IN_FLIGHT);
}

/**
 * Claim one in-flight slot for this request, or answer the refusal.
 *
 * Returns null when the slot is held; the hold is on ctx.inflight and the router releases it when the
 * handler returns (index.ts). A handler whose spend outlives its response takes the hold with
 * takeInflight and releases it itself.
 *
 * Returns a 429 rate_limited when the account is at its cap. That is the existing temporal code: the
 * same request succeeds once another one settles, and every client already backs off on it.
 */
export async function admitInFlight(
  ctx: Ctx,
  accountId: string,
  kind: InflightKind,
  holdSec: number,
): Promise<Response | null> {
  const cap = inFlightCap(ctx.env.MAX_IN_FLIGHT_PER_ACCOUNT);
  const nowSec = Math.floor(ctx.now.getTime() / 1000);
  const asyncSinceIso = new Date(ctx.now.getTime() - ASYNC_JOB_COUNT_SEC * 1000).toISOString();
  let claimed: boolean;
  try {
    claimed = await ctx.store.claimInflightSlot({
      id: ctx.requestId,
      accountId,
      kind,
      nowSec,
      expiresAtSec: nowSec + holdSec,
      asyncSinceIso,
      cap,
    });
  } catch (err) {
    console.error("in-flight claim failed", {
      requestId: ctx.requestId,
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "This account's in-flight requests could not be counted, so the request was refused rather than admitted unbounded.",
    );
  }
  if (!claimed) {
    return errorResponse(
      ctx.requestId,
      "rate_limited",
      `This account already has ${cap} requests or jobs in flight. Retry when one finishes.`,
      { in_flight_cap: cap },
      { "retry-after": String(IN_FLIGHT_RETRY_AFTER_SEC) },
    );
  }
  ctx.inflight = { id: ctx.requestId, accountId };
  return null;
}

/** Take the hold off ctx, so the router does not release it. The caller now owns the release. */
export function takeInflight(ctx: Ctx): InflightHold | null {
  const hold = ctx.inflight ?? null;
  ctx.inflight = null;
  return hold;
}

/** Release a hold. Never throws: a failed release is logged, and the slot expires on its TTL. */
export async function releaseHold(
  store: Pick<Ctx["store"], "releaseInflightSlot">,
  hold: InflightHold | null,
  requestId: string,
): Promise<void> {
  if (!hold) return;
  try {
    await store.releaseInflightSlot(hold.id, hold.accountId);
  } catch (err) {
    console.error("in-flight release failed; the slot expires on its TTL", {
      requestId,
      slotId: hold.id,
      accountId: hold.accountId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The router end of a request: release whatever hold is still on ctx. */
export async function releaseInflight(ctx: Ctx): Promise<void> {
  await releaseHold(ctx.store, takeInflight(ctx), ctx.requestId);
}
