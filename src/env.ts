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
  DB: D1Database;

  /**
   * Workers AI binding. Required for:
   *   - Deepgram Flux live STT (`{ websocket: true }`)
   *   - Unified Billing non-@cf non-chat (image/video/music via env.AI.run + gateway)
   * Chat and most @cf HTTP models still use CF_AIG_TOKEN over REST.
   * ABSENT: Flux and UB non-chat answer 503; @cf REST doors still work.
   */
  AI?: Ai;

  /**
   * Durable Object namespace for live voice STT sessions (Flux bridge).
   * ABSENT: GET /v1/stt/stream answers 503.
   */
  STT_SESSION?: DurableObjectNamespace;

  /** The Cloudflare account inference runs on. A plain var: an account id is not a secret. */
  CF_ACCOUNT_ID?: string;

  /**
   * AI Gateway slug every inference call routes through.
   *
   * ABSENT IS FAIL-CLOSED, not fail-open. With no slug, the inference route answers 503 rather than
   * calling the model directly. A metering plane whose traffic bypasses the gateway has thrown away the
   * attribution it exists for, so it declines to serve instead.
   */
  AI_GATEWAY_ID?: string;

  /**
   * "false" to suppress AI Gateway's per-request log row entirely. Default is ON, and that is safe here
   * for one specific reason: THE PAYLOAD IS NEVER STORED IN EITHER CASE.
   *
   * Cloudflare separates the two switches. `cf-aig-collect-log-payload: false` drops prompt and completion
   * bodies while still recording token counts, model, provider, status, cost and duration; that is exactly
   * "cost and tokens only", which is what this plane is allowed to keep. `cf-aig-collect-log: false` drops
   * the whole row including that metadata.
   *
   * So the payload switch is hard-wired off in src/upstream.ts with no env override -- privacy is not
   * config -- and this var only decides whether the cost metadata row exists at all. Leaving it on buys
   * Cloudflare-side cost reconciliation against our own ledger, which is how a metering bug gets caught.
   * https://developers.cloudflare.com/ai-gateway/observability/logging/
   */
  AI_GATEWAY_COLLECT_LOG?: string;

  /**
   * IGNORED. Product is shared-only.
   *
   * Cloudflare caps API tokens at **500 per account, total**
   * (https://developers.cloudflare.com/fundamentals/api/reference/limits/). One token per Prism account
   * would cap the product in the low hundreds and starve vivijure's per-tenant minting from the same
   * pool. This plane therefore uses **one** account-scoped `CF_AIG_TOKEN` for every request.
   * Per-user attribution is `cf-aig-metadata` plus the D1 ledger, never a second Cloudflare token.
   * A leftover `per-user` value is refused at wiring time rather than partially honored.
   */
  UPSTREAM_CREDENTIAL_MODE?: string;

  /**
   * The ONE account-scoped credential that reaches models for every account.
   *
   * AI Gateway Run + Workers AI Read + AI Gateway Read (read is for reconciliation). Required; without
   * it the inference route answers 503. Also used to HMAC-sign the STT DO handoff (stt-handoff.ts).
   * Never sent to a client. Never used to mint other tokens.
   */
  CF_AIG_TOKEN?: string;

  /**
   * RETIRED (per-user minting is not product). Kept on the Env type so an old wrangler still typechecks;
   * `upstreamCredentialSource` never reads these.
   */
  USER_TOKEN_BUDGET?: string;
  /** @deprecated See USER_TOKEN_BUDGET. */
  PCP_CF_API_TOKEN?: string;
  /** @deprecated See USER_TOKEN_BUDGET. */
  USER_TOKEN_KEK?: string;
  /** @deprecated See USER_TOKEN_BUDGET. */
  USER_TOKEN_KEK_NEXT?: string;
  /** @deprecated See USER_TOKEN_BUDGET. */
  USER_TOKEN_KEK_ENCRYPT_SLOT?: string;

  /** Milliseconds to wait for a model before answering 504. Blank falls back to the default below. */
  UPSTREAM_TIMEOUT_MS?: string;
  /** Optional longer timeout for image/video/music/STT doors (default 120s, max 180s). */
  NONCHAT_UPSTREAM_TIMEOUT_MS?: string;

  /** Operator bearer. UNSET = no operator surface at all (every /admin/* route answers 503). */
  ADMIN_TOKEN?: string;

  /**
   * Cron-only: set to the literal string "true" to allow scheduled reconcile to write money
   * (advance watermark + usage_adjustments). Absent or any other value = dry-run only.
   * POST /admin/reconcile is unaffected (still dry-run default, human can pass dry_run:false).
   */
  RECONCILE_CRON_LIVE?: string;

  /**
   * Cron-only: first-run lookback in whole days (1..30) when no watermark exists yet.
   * Default 7. Dry runs use this every tick until a live run establishes a watermark.
   */
  RECONCILE_CRON_INITIAL_LOOKBACK_DAYS?: string;
}

/** Documented default for UPSTREAM_TIMEOUT_MS: long enough for a slow first token, short enough that
 * a mobile client is not held open past the point a user has given up. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;

/** Video/music unit doors need longer waits than chat first-token (Seedance etc.). */
export const DEFAULT_NONCHAT_UPSTREAM_TIMEOUT_MS = 120_000;

/** Hard ceiling on the configurable timeout. A misconfigured 10-minute wait would pin a Worker
 * invocation and a phone socket on a request nobody is still waiting for. */
const MAX_UPSTREAM_TIMEOUT_MS = 180_000;

export function upstreamTimeoutMs(env: Env): number {
  const raw = (env.UPSTREAM_TIMEOUT_MS ?? "").trim();
  if (!raw) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  const parsed = Number(raw);
  // A malformed value falls back to the default rather than to zero. Coercing junk to 0 would mean
  // "time out immediately", turning a typo into a total outage of the only paid route.
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), MAX_UPSTREAM_TIMEOUT_MS);
}

/**
 * Timeout for image/video/music/STT doors (binding can run longer than chat).
 *
 * Intentionally does **not** fall back to UPSTREAM_TIMEOUT_MS: production often sets that to 60s
 * for chat first-token, which is too short for Seedance/Veo and re-introduced 60s timeouts after
 * v0.4.10. Only NONCHAT_UPSTREAM_TIMEOUT_MS (or the 120s default) applies here.
 */
export function nonChatUpstreamTimeoutMs(env: Env): number {
  const raw = (env.NONCHAT_UPSTREAM_TIMEOUT_MS ?? "").trim();
  if (!raw) return DEFAULT_NONCHAT_UPSTREAM_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_NONCHAT_UPSTREAM_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), MAX_UPSTREAM_TIMEOUT_MS);
}

export interface GatewayConfig {
  accountId: string;
  id: string;
  collectLog: boolean;
}

/**
 * Credential mode is always shared.
 *
 * Per-user minting is not product: Cloudflare's 500-token account ceiling makes one token per account
 * a hard product cap. If a deploy still has `UPSTREAM_CREDENTIAL_MODE=per-user`, `upstreamCredentialSource`
 * refuses to wire rather than mint.
 */
export function credentialMode(_env: Env): "shared" {
  return "shared";
}

/** True when config still asks for the retired per-user minting path. */
export function perUserModeRequested(env: Env): boolean {
  return (env.UPSTREAM_CREDENTIAL_MODE ?? "").trim().toLowerCase() === "per-user";
}

/**
 * The per-user token budget, or null when it is missing or unusable.
 *
 * Null CLOSES per-user mode rather than substituting a number. The budget is the only thing standing between
 * this plane and the account's shared 500-token quota, so an absent or malformed one is a configuration
 * error to refuse on, not a value to invent. Values above the account quota are clamped: no budget can
 * authorise more tokens than Cloudflare will issue.
 */
export function userTokenBudget(env: Env, accountQuota: number): number | null {
  const raw = (env.USER_TOKEN_BUDGET ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, accountQuota);
}

/**
 * The gateway routing decision, in one place.
 *
 * Returns null when the deployment is not wired to spend, and the caller MUST refuse on null. This is the
 * fail-closed seam: a function rather than an inline check, so there is exactly one answer to "are we
 * allowed to spend right now" and a test can assert the refusal without a Worker.
 *
 * BOTH the account id and the gateway slug are required. The upstream URL is built from both
 * (`gateway.ai.cloudflare.com/v1/{account}/{gateway}/...`), so a missing one is not a degraded mode, it is
 * no upstream at all.
 */
/** Cloudflare account ids are 32 hex chars. Reject anything else before it enters a URL path. */
const CF_ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

export function gatewayConfig(env: Env): GatewayConfig | null {
  const accountId = (env.CF_ACCOUNT_ID ?? "").trim();
  const id = (env.AI_GATEWAY_ID ?? "").trim();
  if (!accountId || !id) return null;
  // Fail closed on a non-hex account id so it cannot rewrite the REST/gateway URL path.
  if (!CF_ACCOUNT_ID_RE.test(accountId)) return null;
  // Gateway slug: letters, digits, hyphen, underscore only.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return {
    accountId,
    id,
    // DEFAULTS ON, and only an explicit "false" turns it off. Safe to default on only because the payload
    // switch is hard-wired off in upstream.ts: the row this keeps holds token counts and cost, never content.
    collectLog: (env.AI_GATEWAY_COLLECT_LOG ?? "").trim().toLowerCase() !== "false",
  };
}

/**
 * The KEK ring config, read as a triple.
 *
 * Returns null when no primary key is installed, which the caller turns into a closed door rather than a
 * plaintext credential. Parsing lives in token-crypto.ts; this only decides whether there is anything to
 * parse.
 */
export function userTokenKekConfig(env: Env): {
  primary: string;
  next?: string;
  slot?: string;
} | null {
  const primary = (env.USER_TOKEN_KEK ?? "").trim();
  if (!primary) return null;
  return {
    primary,
    next: (env.USER_TOKEN_KEK_NEXT ?? "").trim() || undefined,
    slot: (env.USER_TOKEN_KEK_ENCRYPT_SLOT ?? "").trim() || undefined,
  };
}
