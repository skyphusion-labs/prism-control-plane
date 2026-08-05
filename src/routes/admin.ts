// The operator surface. NOT part of the client contract: nothing under /admin is promised to mobile
// clients, and docs/openapi.yaml deliberately does not describe it.
//
// UNSET ADMIN_TOKEN MEANS THERE IS NO OPERATOR SURFACE. Every route here answers 503 in that state, by
// construction rather than by configuration discipline, so a deploy that forgot the secret cannot be
// driven by anyone. That is the same posture vivijure-control-plane's admin gate takes and for the same
// reason: an admin door that falls open when its credential is missing is worse than no door.
//
// SCOPE, stated so it is not mistaken for a finished feature: this is the minimum needed to make the plane
// operable -- create an account, mint an enrollment token, revoke a client key, top up prepaid credit, price
// a model, and kill one user's upstream credential. It is a single shared bearer, not an operator identity
// with scopes. Splitting it into authenticated operator principals is a later concern; what matters now is
// that the door exists, fails closed, and is not reachable by a client key.

import { constantTimeEqual, newId, randomSecret, sha256Hex } from "../crypto";
import { bearerFromRequest } from "../auth";
import { findModel } from "../catalog";
import { errorResponse, jsonResponse, readJsonBody } from "../http";
import { parseTiers, planFromRow, publicPlan } from "../plans";
import type { Ctx } from "./shared";

/** Plan ids are operator-chosen stable keys, not opaque random. Keep them boring. */
const PLAN_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Default enrollment-token lifetime. Short: a token is meant to be used on the device in front of you. */
const DEFAULT_TTL_MINUTES = 60;
const MAX_TTL_MINUTES = 60 * 24 * 7;

type Gate = { ok: true } | { ok: false; response: Response };

export async function requireOperator(ctx: Ctx, request: Request): Promise<Gate> {
  const configured = (ctx.env.ADMIN_TOKEN ?? "").trim();
  if (!configured) {
    return {
      ok: false,
      response: errorResponse(
        ctx.requestId,
        "unavailable",
        "No operator surface is configured on this deployment.",
      ),
    };
  }
  const presented = bearerFromRequest(request);
  if (!presented) {
    return {
      ok: false,
      response: errorResponse(ctx.requestId, "unauthenticated", "Operator authentication is required."),
    };
  }
  // Compare HASHES, not the raw strings. constantTimeEqual returns early on a length mismatch, which
  // would otherwise leak the configured token's length to anyone who can time a request.
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(configured)]);
  if (!constantTimeEqual(a, b)) {
    return {
      ok: false,
      response: errorResponse(ctx.requestId, "unauthenticated", "Operator authentication failed."),
    };
  }
  return { ok: true };
}

/** POST /admin/accounts { plan_id, label? } */
export async function handleCreateAccount(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await requireOperator(ctx, request);
  if (!gate.ok) return gate.response;

  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(ctx.requestId, body.code, body.message);
  const raw = (body.value ?? {}) as Record<string, unknown>;
  if (typeof raw.plan_id !== "string" || !raw.plan_id.trim()) {
    return errorResponse(ctx.requestId, "invalid_request", '"plan_id" is required.');
  }
  const label = typeof raw.label === "string" ? raw.label : null;

  // The plan must EXIST before an account references it. D1 does not enforce the foreign key, so this
  // check is the enforcement: an account pointing at a missing plan resolves as `misconfigured` on every
  // subsequent request, which is a 503 for the user and a puzzle for whoever debugs it.
  const plan = await ctx.store.getPlan(raw.plan_id.trim());
  if (!plan) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      `Plan "${raw.plan_id}" does not exist. Seed it before creating accounts against it.`,
    );
  }

  const id = newId("acct");
  // The plan's signup credit is applied AS PART OF creation, with its own grant row. An account created
  // with zero credit is an account that 402s on its first request, and a separate top-up call leaves
  // exactly that state behind every time the second call fails.
  const account = await ctx.store.createAccount({
    id,
    plan_id: plan.id,
    label,
    credit_micro_usd: plan.signup_credit_micro_usd,
    grant_id: newId("grant"),
    // Derived from the account id, which is unique, so re-running a create can never double-grant.
    grant_idempotency_key: `signup:${id}`,
  });
  return jsonResponse(
    ctx.requestId,
    {
      id: account.id,
      plan_id: account.plan_id,
      label: account.label,
      status: "active",
      credit_micro_usd: account.credit_micro_usd,
    },
    { status: 201 },
  );
}

/**
 * POST /admin/accounts/:id/credits { micro_usd, idempotency_key, note? }
 *
 * The only way credit enters the system after signup. PREPAID MEANS THIS IS THE ONLY WAY: there is no
 * overage, no auto-top-up and no negative-balance grace, so an account that has run out stays stopped until
 * a human decides otherwise. That decision is this route.
 *
 * `idempotency_key` IS REQUIRED and is not defaulted. A generated key would make every retry a fresh grant,
 * which turns a flaky network into free money. The operator supplies something meaningful (an invoice id, a
 * payment reference) and a repeat is answered with applied:false rather than an error.
 */
export async function handleGrantCredit(
  ctx: Ctx,
  request: Request,
  accountId: string,
): Promise<Response> {
  const gate = await requireOperator(ctx, request);
  if (!gate.ok) return gate.response;

  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(ctx.requestId, body.code, body.message);
  const raw = (body.value ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(raw.micro_usd) || (raw.micro_usd as number) <= 0) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      '"micro_usd" must be a positive integer number of micro-USD (1 USD = 1000000).',
    );
  }
  if (typeof raw.idempotency_key !== "string" || raw.idempotency_key.trim().length < 4) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      '"idempotency_key" is required (at least 4 characters): it is what makes a retried top-up safe.',
    );
  }

  const account = await ctx.store.getAccount(accountId);
  if (!account) {
    return errorResponse(ctx.requestId, "invalid_request", "That account does not exist.");
  }

  const result = await ctx.store.grantCredit({
    id: newId("grant"),
    account_id: account.id,
    micro_usd: raw.micro_usd as number,
    idempotency_key: raw.idempotency_key.trim(),
    note: typeof raw.note === "string" ? raw.note : null,
  });

  return jsonResponse(ctx.requestId, {
    account_id: account.id,
    // False means "this key was already used", which is a success. Reported so an operator can tell a new
    // grant from a replay without querying the grants table.
    applied: result.applied,
    credit_micro_usd: result.creditMicroUsd,
    spent_micro_usd: account.spent_micro_usd,
  });
}

/**
 * POST /admin/model-prices { model_id, input_micro_usd_per_mtok, output_micro_usd_per_mtok, note? }
 *
 * THIS IS HOW AN UNPRICED MODEL BECOMES SPENDABLE. Cloudflare publishes no per-token rate for third-party
 * Unified Billing models, so most of the interesting catalog arrives with no price and the inference door
 * refuses it. Setting a rate here opens it, with no deploy.
 *
 * The model MUST be in the catalog. Pricing an id this plane cannot route is a row that looks like a
 * decision and does nothing, and those are worse than an error.
 */
export async function handleSetModelPrice(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await requireOperator(ctx, request);
  if (!gate.ok) return gate.response;

  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(ctx.requestId, body.code, body.message);
  const raw = (body.value ?? {}) as Record<string, unknown>;
  if (typeof raw.model_id !== "string" || !findModel(raw.model_id)) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      '"model_id" must name a model in this deployment\'s catalog.',
    );
  }
  const hasToken =
    raw.input_micro_usd_per_mtok !== undefined || raw.output_micro_usd_per_mtok !== undefined;
  const hasUnit = raw.unit_micro_usd !== undefined;

  if (!hasToken && !hasUnit) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      "Provide token rates (input_micro_usd_per_mtok + output_micro_usd_per_mtok) and/or unit_micro_usd.",
    );
  }

  let input = 0;
  let output = 0;
  if (hasToken) {
    for (const field of ["input_micro_usd_per_mtok", "output_micro_usd_per_mtok"] as const) {
      if (!Number.isInteger(raw[field]) || (raw[field] as number) < 0) {
        return errorResponse(
          ctx.requestId,
          "invalid_request",
          `"${field}" must be a non-negative integer number of micro-USD per million tokens.`,
        );
      }
    }
    input = raw.input_micro_usd_per_mtok as number;
    output = raw.output_micro_usd_per_mtok as number;
  }

  let unitMicro: number | null = null;
  if (hasUnit) {
    if (!Number.isInteger(raw.unit_micro_usd) || (raw.unit_micro_usd as number) < 0) {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        '"unit_micro_usd" must be a non-negative integer micro-USD per unit.',
      );
    }
    unitMicro = raw.unit_micro_usd as number;
  }

  await ctx.store.putModelPrice({
    model_id: raw.model_id,
    input_micro_usd_per_mtok: input,
    output_micro_usd_per_mtok: output,
    unit_micro_usd: unitMicro,
    // Stamped from the request clock, not supplied by the caller: `priced_at` answers "when was this rate
    // decided", and a caller-chosen date could backdate a rate change.
    priced_at: ctx.now.toISOString().slice(0, 10),
    note: typeof raw.note === "string" ? raw.note : null,
  });

  const entry = findModel(raw.model_id)!;
  return jsonResponse(ctx.requestId, {
    model_id: raw.model_id,
    input_micro_usd_per_mtok: input,
    output_micro_usd_per_mtok: output,
    unit_micro_usd: unitMicro,
    modality: entry.modality,
    spendable: true,
  });
}

/**
 * POST /admin/accounts/:id/upstream-token/revoke
 *
 * The per-user kill switch at the Cloudflare layer, available ONLY in per-user credential mode. In shared
 * mode there is no per-account Cloudflare credential to kill, and this route says so with a 409 instead of
 * reporting a revocation that did not happen -- the stop button there is `POST /admin/clients/:id/revoke`
 * plus account suspension, both immediate.
 *
 * IT IS NOT INSTANT: roughly 8 to 16 seconds of propagation was measured on this estate. The plane's own
 * refusal paths are immediate and are the right tool for "stop this now"; this one is for "make sure that
 * credential is dead". Both, usually.
 */
export async function handleRevokeUserToken(
  ctx: Ctx,
  request: Request,
  accountId: string,
): Promise<Response> {
  const gate = await requireOperator(ctx, request);
  if (!gate.ok) return gate.response;

  if (!ctx.credentials) {
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "This deployment has no upstream credential configured, so there is nothing to revoke through it.",
    );
  }
  if (ctx.credentials.mode !== "per-user") {
    return errorResponse(
      ctx.requestId,
      "not_implemented",
      "This deployment runs a shared upstream credential, so there is no per-account Cloudflare token to revoke. " +
        "Revoke the account's client keys and suspend the account instead; both take effect immediately.",
    );
  }
  try {
    const revoked = await ctx.credentials.revokeForAccount(accountId);
    // 200 either way. `revoked: false` means there was nothing to revoke, which is the desired end state
    // and not an error an operator should have to interpret under pressure.
    return jsonResponse(ctx.requestId, { account_id: accountId, revoked });
  } catch (err) {
    // A FAILED REVOCATION IS REPORTED AS A FAILURE, loudly. Answering 200 here would tell an operator a
    // live credential is dead, which is the worst possible lie for this particular route.
    console.error("upstream token revocation failed", {
      requestId: ctx.requestId,
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(
      ctx.requestId,
      "upstream_error",
      "Cloudflare refused the revocation. The credential may still be live; retry, or revoke it in the dashboard.",
    );
  }
}

/** POST /admin/enrollments { account_id, ttl_minutes?, note? } */
export async function handleCreateEnrollment(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await requireOperator(ctx, request);
  if (!gate.ok) return gate.response;

  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(ctx.requestId, body.code, body.message);
  const raw = (body.value ?? {}) as Record<string, unknown>;
  if (typeof raw.account_id !== "string" || !raw.account_id.trim()) {
    return errorResponse(ctx.requestId, "invalid_request", '"account_id" is required.');
  }
  let ttl = DEFAULT_TTL_MINUTES;
  if (raw.ttl_minutes !== undefined) {
    if (!Number.isInteger(raw.ttl_minutes) || (raw.ttl_minutes as number) < 1) {
      return errorResponse(ctx.requestId, "invalid_request", '"ttl_minutes" must be a positive integer.');
    }
    ttl = Math.min(raw.ttl_minutes as number, MAX_TTL_MINUTES);
  }

  const account = await ctx.store.getAccount(raw.account_id.trim());
  if (!account) {
    return errorResponse(ctx.requestId, "invalid_request", "That account does not exist.");
  }

  const token = randomSecret();
  await ctx.store.createEnrollment({
    token_hash: await sha256Hex(token),
    account_id: account.id,
    expires_at: new Date(ctx.now.getTime() + ttl * 60_000).toISOString(),
    note: typeof raw.note === "string" ? raw.note : null,
  });

  return jsonResponse(
    ctx.requestId,
    {
      // Shown once, like the client key it will be traded for. Only the hash is stored.
      enrollment_token: token,
      account_id: account.id,
      expires_in_minutes: ttl,
    },
    { status: 201 },
  );
}

/** POST /admin/clients/:id/revoke */
export async function handleRevokeClient(
  ctx: Ctx,
  request: Request,
  clientId: string,
): Promise<Response> {
  const gate = await requireOperator(ctx, request);
  if (!gate.ok) return gate.response;

  const revoked = await ctx.store.revokeClient(clientId);
  // 200 either way, with `revoked` reporting whether THIS call did it. A second call is not an error:
  // revocation is idempotent, and an operator retrying under pressure should not have to interpret a 404.
  return jsonResponse(ctx.requestId, { client_id: clientId, revoked });
}

/**
 * POST /admin/plans -- create or replace a plan row.
 *
 * The only way product numbers enter the system without a migration. Idempotent on `id`: a second call
 * with the same id overwrites the row. Accounts already on that plan see the new numbers on the next
 * request (no versioning). That is deliberate for a pre-traffic plane; do not invent plan versioning
 * here without a product rule for grandparenting live accounts.
 *
 * Signup credit applies only to NEW accounts created against this plan after the write; changing
 * `signup_credit_micro_usd` does not retroactively grant or claw back existing accounts.
 */
export async function handleUpsertPlan(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await requireOperator(ctx, request);
  if (!gate.ok) return gate.response;

  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(ctx.requestId, body.code, body.message);
  const raw = (body.value ?? {}) as Record<string, unknown>;

  if (typeof raw.id !== "string" || !PLAN_ID_RE.test(raw.id)) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      '"id" must be a lowercase slug (letter first, then letters/digits/_/-, max 64).',
    );
  }
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    return errorResponse(ctx.requestId, "invalid_request", '"name" is required.');
  }

  for (const field of [
    "signup_credit_micro_usd",
    "monthly_included_micro_usd",
    "requests_per_minute",
    "max_output_tokens",
  ] as const) {
    if (!Number.isInteger(raw[field])) {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        `"${field}" must be an integer micro-USD or count field.`,
      );
    }
  }

  let allowedTiersCsv: string;
  if (Array.isArray(raw.allowed_tiers)) {
    if (!raw.allowed_tiers.every((t) => typeof t === "string")) {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        '"allowed_tiers" must be an array of tier name strings (standard, premium).',
      );
    }
    allowedTiersCsv = (raw.allowed_tiers as string[]).join(",");
  } else if (typeof raw.allowed_tiers === "string") {
    allowedTiersCsv = raw.allowed_tiers;
  } else {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      '"allowed_tiers" is required (array or comma-separated string of standard, premium).',
    );
  }

  const parsedTiers = parseTiers(allowedTiersCsv);
  if (parsedTiers.length === 0) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      '"allowed_tiers" must include at least one known tier (standard, premium).',
    );
  }

  const row = {
    id: raw.id,
    name: raw.name.trim(),
    signup_credit_micro_usd: raw.signup_credit_micro_usd as number,
    monthly_included_micro_usd: raw.monthly_included_micro_usd as number,
    requests_per_minute: raw.requests_per_minute as number,
    max_output_tokens: raw.max_output_tokens as number,
    // Normalise so storage is always the canonical "standard,premium" form from known tiers only.
    allowed_tiers: parsedTiers.join(","),
  };

  // planFromRow is the same validator the request path uses. Refuse here rather than writing a row
  // that will 503 every subsequent inference against it.
  const validated = planFromRow(row);
  if (!validated.ok) {
    return errorResponse(ctx.requestId, "invalid_request", validated.reason);
  }

  const existed = (await ctx.store.getPlan(row.id)) !== null;
  await ctx.store.putPlan(row);

  return jsonResponse(
    ctx.requestId,
    { ...publicPlan(validated.plan), created: !existed },
    { status: existed ? 200 : 201 },
  );
}
