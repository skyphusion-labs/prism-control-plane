// The operator surface. NOT part of the client contract: nothing under /admin is promised to mobile
// clients, and docs/openapi.yaml deliberately does not describe it.
//
// UNSET ADMIN_TOKEN MEANS THERE IS NO OPERATOR SURFACE. Every route here answers 503 in that state, by
// construction rather than by configuration discipline, so a deploy that forgot the secret cannot be
// driven by anyone. That is the same posture vivijure-control-plane's admin gate takes and for the same
// reason: an admin door that falls open when its credential is missing is worse than no door.
//
// SCOPE, stated so it is not mistaken for a finished feature: this is the minimum needed to make the
// plane operable (create an account, mint an enrollment token, revoke a client key). It is a single shared
// bearer, not an operator identity with scopes. Splitting it into authenticated operator principals is a
// later concern; what matters now is that the door exists, fails closed, and is not reachable by a client
// key.

import { constantTimeEqual, newId, randomSecret, sha256Hex } from "../crypto";
import { bearerFromRequest } from "../auth";
import { errorResponse, jsonResponse, readJsonBody } from "../http";
import type { Ctx } from "./shared";

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

  const account = await ctx.store.createAccount({
    id: newId("acct"),
    plan_id: plan.id,
    label,
  });
  return jsonResponse(
    ctx.requestId,
    { id: account.id, plan_id: account.plan_id, label: account.label, status: "active" },
    { status: 201 },
  );
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
