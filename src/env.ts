// The hand-authored Env binding interface: a mirror of wrangler.example.toml.
//
// Hand-authored on purpose (estate convention). `wrangler types` output is not committed, so this
// file is the only thing tsc checks binding access against, and a binding added to the TOML without
// a line here fails the typecheck at its first use rather than at runtime on a deploy.
//
// Optional fields are optional because they are legitimately absent on some deploy: an unset
// ADMIN_TOKEN means there is no operator surface, an unset AI_GATEWAY_ID means the inference door is
// closed. Typing them as required would make tsc demand values from a deployer who correctly does
// not have them, and would push the fail-closed decision out of the code and into config discipline.

export interface Env {
  /** Unified AI binding: Workers AI directly, third parties through AI Gateway Unified Billing. */
  AI: Ai;
  DB: D1Database;

  /**
   * AI Gateway slug every inference call routes through.
   *
   * ABSENT IS FAIL-CLOSED, not fail-open. See gatewayConfig() below: with no slug, the inference
   * route answers 503 rather than calling the model directly. A metering plane whose traffic bypasses
   * the gateway has thrown away the attribution it exists for, so it declines to serve instead.
   */
  AI_GATEWAY_ID?: string;

  /**
   * "true" to let AI Gateway store a log row per request. Default OFF.
   *
   * The binding's gateway option is all-or-nothing, and a stored log includes the PAYLOAD, which
   * means prompts. Our ledger prices requests from token counts alone, so leaving this off costs the
   * plane nothing it needs. Privacy is the primary goal on this estate; a feature that conflicts with
   * that line yields.
   */
  AI_GATEWAY_COLLECT_LOG?: string;

  /** Milliseconds to wait for a model before answering 504. Blank falls back to the default below. */
  UPSTREAM_TIMEOUT_MS?: string;

  /** Operator bearer. UNSET = no operator surface at all (every /admin/* route answers 503). */
  ADMIN_TOKEN?: string;
}

/** Documented default for UPSTREAM_TIMEOUT_MS: long enough for a slow first token, short enough that
 * a mobile client is not held open past the point a user has given up. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;

/** Hard ceiling on the configurable timeout. A misconfigured 10-minute wait would pin a Worker
 * invocation and a phone socket on a request nobody is still waiting for. */
const MAX_UPSTREAM_TIMEOUT_MS = 120_000;

export function upstreamTimeoutMs(env: Env): number {
  const raw = (env.UPSTREAM_TIMEOUT_MS ?? "").trim();
  if (!raw) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  const parsed = Number(raw);
  // A malformed value falls back to the default rather than to zero. Coercing junk to 0 would mean
  // "time out immediately", turning a typo into a total outage of the only paid route.
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), MAX_UPSTREAM_TIMEOUT_MS);
}

export interface GatewayConfig {
  id: string;
  collectLog: boolean;
}

/**
 * The gateway routing decision, in one place.
 *
 * Returns null when no gateway is configured, and the caller MUST refuse the request on null. This is
 * the fail-closed seam: it is a function rather than an inline check so that there is exactly one
 * answer to "are we allowed to spend right now", and so a test can assert the refusal without a
 * Worker.
 */
export function gatewayConfig(env: Env): GatewayConfig | null {
  const id = (env.AI_GATEWAY_ID ?? "").trim();
  if (!id) return null;
  return { id, collectLog: (env.AI_GATEWAY_COLLECT_LOG ?? "").trim().toLowerCase() === "true" };
}
