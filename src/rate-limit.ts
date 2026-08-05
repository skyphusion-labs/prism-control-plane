// Fixed-window rate limiting on a D1 counter. Same shape prism's auth limiter uses.
//
// A D1 counter rather than the Workers rate-limiting binding, for two reasons that both matter for a
// first build: it works identically under `wrangler dev` (an unbindable limiter is an untestable one),
// and the bucket is transactional with the account data it protects, so there is no second store to
// keep consistent.
//
// The DECISION is pure and unit tested; the store only does the read and the upsert.

export interface RateLimitDecision {
  allowed: boolean;
  nextCount: number;
  nextWindowStart: number;
  /** Seconds until the current window rolls. Sent as `retry-after` on a refusal. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window decision.
 *
 * DENIED ATTEMPTS STILL COUNT. A limiter that only counts allowed requests lets a client hammering at
 * ten times the limit ride exactly at the limit forever, which is the opposite of throttling. Sustained
 * pressure keeps the bucket shut until the window rolls.
 *
 * The fixed window's known weakness, stated rather than discovered: a client can send `limit` requests
 * at the very end of one window and `limit` more at the start of the next, so the true worst-case burst
 * is 2x the limit over a window boundary. A sliding window would bound that, at the cost of storing
 * per-request timestamps. For a per-minute cap whose purpose is bounding cost and abuse rather than
 * enforcing an SLA, 2x over one boundary is an acceptable and BOUNDED overshoot, and the allowance gate
 * in quota.ts is what actually bounds spend.
 */
export function rateLimitDecision(
  nowSec: number,
  windowStartSec: number | null,
  count: number,
  limit: number,
  windowSeconds: number,
): RateLimitDecision {
  if (windowStartSec === null || nowSec - windowStartSec >= windowSeconds) {
    return {
      allowed: true,
      nextCount: 1,
      nextWindowStart: nowSec,
      retryAfterSeconds: windowSeconds,
    };
  }
  const nextCount = count + 1;
  const elapsed = nowSec - windowStartSec;
  return {
    allowed: nextCount <= limit,
    nextCount,
    nextWindowStart: windowStartSec,
    // At least 1: a `retry-after: 0` invites an immediate retry that is guaranteed to fail again.
    retryAfterSeconds: Math.max(1, windowSeconds - elapsed),
  };
}

export const RATE_WINDOW_SECONDS = 60;

export interface RateLimiterStore {
  /**
   * Atomically record one attempt against a bucket and return the post-claim state.
   *
   * A separate read-then-write races under concurrent requests: every request reads the same count
   * and every one passes. The D1 implementation is a single UPSERT; the in-memory fake is single-
   * threaded. Callers must not re-implement the increment outside this method.
   */
  claimRateBucket(
    key: string,
    nowSec: number,
    windowSeconds: number,
  ): Promise<{ count: number; window_start: number }>;
  nowEpochSeconds(): Promise<number>;
}

/** Record one attempt against a bucket and report whether it is allowed. */
export async function checkRateLimit(
  store: RateLimiterStore,
  bucketKey: string,
  limit: number,
  windowSeconds: number = RATE_WINDOW_SECONDS,
): Promise<RateLimitDecision> {
  const now = await store.nowEpochSeconds();
  const row = await store.claimRateBucket(bucketKey, now, windowSeconds);
  const elapsed = now - row.window_start;
  return {
    allowed: row.count <= limit,
    nextCount: row.count,
    nextWindowStart: row.window_start,
    retryAfterSeconds: Math.max(1, windowSeconds - elapsed),
  };
}

/**
 * Bucket keys.
 *
 * Inference is limited per ACCOUNT, not per client, because the plan's allowance is per account: a
 * per-client limit would let an account multiply its throughput by enrolling more devices, which would
 * make the plan's `requests_per_minute` meaningless.
 *
 * Enrollment is limited per IP, because there is no account yet at that point in the flow.
 */
export function inferenceBucket(accountId: string): string {
  return `infer:${accountId}`;
}

export function enrollBucket(ip: string): string {
  return `enroll:${ip}`;
}

/** Enrollment attempts per IP per window. Low: a legitimate device enrolls once. */
export const ENROLL_LIMIT = 5;
