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
   * THERE IS NO `AI` BINDING, and its absence is deliberate even though the default credential mode is now
   * a shared one.
   *
   * The binding hard-codes ONE identity: the Worker's. Calling the AI REST API instead (src/upstream.ts)
   * means the credential is an argument, which is what lets UPSTREAM_CREDENTIAL_MODE be a config switch
   * rather than a rewrite. Adding the binding back would make the shared path the only possible path and
   * quietly delete the choice.
   */

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
   * Which credential reaches the model: "shared" (default) or "per-user".
   *
   * SHARED IS THE DEFAULT because of a hard Cloudflare ceiling: an account may hold 500 API tokens, total,
   * across every service on it. One token per Prism user therefore caps the product in the low hundreds and
   * competes with vivijure's per-tenant provisioning for the same slots. Cloudflare's own documented way to
   * attribute spend per user is custom metadata, which this plane sends in both modes.
   * https://developers.cloudflare.com/fundamentals/api/reference/limits/
   *
   * "per-user" remains supported and bounded (see USER_TOKEN_BUDGET) because it buys Cloudflare-layer
   * per-user revocation, which is worth having for a deployment small enough to afford it.
   */
  UPSTREAM_CREDENTIAL_MODE?: string;

  /**
   * SHARED MODE credential: one account-scoped token with AI Gateway Run + Workers AI Read.
   *
   * Required when UPSTREAM_CREDENTIAL_MODE is shared or unset; without it the inference route answers 503.
   * It is never sent to a client and never used to manage tokens.
   */
  CF_AIG_TOKEN?: string;

  /**
   * PER-USER MODE: how many of the account's 500 token slots this plane may consume. Required in that mode.
   *
   * There is no default, and that is the point. A default would be a guess at how much of a SHARED account
   * quota one product may take, made without knowing what else lives on the account. The deployer subtracts
   * the operator tokens and vivijure's tenant tokens themselves and writes down what is left.
   */
  USER_TOKEN_BUDGET?: string;

  /**
   * PER-USER MODE: the ACCOUNT-LEVEL Cloudflare token used ONLY to mint and revoke per-user tokens.
   *
   * Needs `Account API Tokens Write` (the dashboard calls it "Account Tokens: Edit"). MUST be created in
   * the dashboard: Cloudflare refuses API-created tokens any token-management rights, so a token minted
   * through this plane can never replace this one.
   *
   * It is never used for inference. src/cf-api.ts is the only file that reads it, and that file has no
   * code path that can reach a model.
   */
  PCP_CF_API_TOKEN?: string;

  /**
   * Base64 32-byte AES key encrypting minted per-user tokens at rest. See src/token-crypto.ts.
   *
   * UNSET CLOSES THE INFERENCE DOOR. A plane that cannot encrypt a minted credential must not mint one,
   * because the alternative is a spendable Cloudflare token sitting in plaintext D1.
   */
  USER_TOKEN_KEK?: string;
  /** The second key, present only during a rotation window. Reads try both. */
  USER_TOKEN_KEK_NEXT?: string;
  /** "primary" (default) or "next": which installed key NEW ciphertext is written under. */
  USER_TOKEN_KEK_ENCRYPT_SLOT?: string;

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
  accountId: string;
  id: string;
  collectLog: boolean;
}

/**
 * Which credential mode this deployment runs, resolved once.
 *
 * DEFAULTS TO SHARED, including when the value is junk. An unrecognised mode string must not be read as
 * "per-user", because that would let a typo start consuming a finite account-wide token quota.
 */
export function credentialMode(env: Env): "shared" | "per-user" {
  return (env.UPSTREAM_CREDENTIAL_MODE ?? "").trim().toLowerCase() === "per-user"
    ? "per-user"
    : "shared";
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
 * BOTH the account id and the gateway slug are required. The REST API path is built from the account id,
 * so a missing one is not a degraded mode, it is no upstream at all.
 */
export function gatewayConfig(env: Env): GatewayConfig | null {
  const accountId = (env.CF_ACCOUNT_ID ?? "").trim();
  const id = (env.AI_GATEWAY_ID ?? "").trim();
  if (!accountId || !id) return null;
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
