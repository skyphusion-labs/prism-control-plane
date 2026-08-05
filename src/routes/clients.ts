// POST /v1/clients -- device enrollment.
//
// FAIL-CLOSED BY CONSTRUCTION. There is no anonymous self-signup on this plane: enrollment requires a
// single-use, unexpired, account-scoped token that something else decided to mint. That "something else"
// is deliberately outside this file (docs/CONTRACT.md open decision 1) -- an operator today, a validated
// App Store / Play receipt or a first-party account later. The enrollments table is the seam, so whichever
// lands writes rows and this route does not change.

import { mintClientKey } from "../auth";
import { sha256Hex } from "../crypto";
import { errorResponse, jsonResponse, readJsonBody } from "../http";
import { checkRateLimit, enrollBucket, ENROLL_LIMIT } from "../rate-limit";
import { clientIp, type Ctx } from "./shared";

const ALLOWED_FIELDS = new Set(["enrollment_token", "label", "platform"]);
const ALLOWED_PLATFORMS = new Set(["ios", "android", "other"]);
const MAX_LABEL_CHARS = 64;

interface EnrollBody {
  token: string;
  label: string | null;
  platform: string | null;
}

type ParseResult = { ok: true; value: EnrollBody } | { ok: false; message: string };

export function parseEnrollBody(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, message: `Unknown field "${key}".` };
    }
  }
  if (typeof raw.enrollment_token !== "string" || raw.enrollment_token.trim().length < 8) {
    return { ok: false, message: '"enrollment_token" is required.' };
  }
  if (raw.label !== undefined && (typeof raw.label !== "string" || raw.label.length > MAX_LABEL_CHARS)) {
    return { ok: false, message: `"label" must be a string of at most ${MAX_LABEL_CHARS} characters.` };
  }
  if (raw.platform !== undefined && (typeof raw.platform !== "string" || !ALLOWED_PLATFORMS.has(raw.platform))) {
    return { ok: false, message: '"platform" must be one of ios, android, other.' };
  }
  return {
    ok: true,
    value: {
      token: raw.enrollment_token.trim(),
      label: typeof raw.label === "string" ? raw.label : null,
      platform: typeof raw.platform === "string" ? raw.platform : null,
    },
  };
}

export async function handleEnroll(ctx: Ctx, request: Request): Promise<Response> {
  // Rate limited per IP because there is no account to limit against yet at this point in the flow.
  const rate = await checkRateLimit(ctx.store, enrollBucket(clientIp(request)), ENROLL_LIMIT);
  if (!rate.allowed) {
    return errorResponse(
      ctx.requestId,
      "rate_limited",
      "Too many enrollment attempts from this network.",
      {},
      { "retry-after": String(rate.retryAfterSeconds) },
    );
  }

  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(ctx.requestId, body.code, body.message);
  const parsed = parseEnrollBody(body.value);
  if (!parsed.ok) return errorResponse(ctx.requestId, "invalid_request", parsed.message);

  // The key is minted BEFORE the token is redeemed, because redemption records which client consumed it
  // and that needs an id. Nothing is persisted for the client yet, so an abandoned mint costs nothing.
  const minted = await mintClientKey();

  const redeemed = await ctx.store.consumeEnrollment(await sha256Hex(parsed.value.token), minted.clientId);
  if (!redeemed) {
    // ONE answer for every failure mode: unknown token, already consumed, expired. Distinguishing them
    // would turn this door into an oracle for guessing valid tokens, and the client's action is identical
    // in all three cases (get a fresh token).
    return errorResponse(
      ctx.requestId,
      "forbidden",
      "That enrollment token is not valid. Tokens are single-use and expire.",
    );
  }

  const account = await ctx.store.getAccount(redeemed.account_id);
  if (!account) {
    console.error("enrollment token references a missing account", {
      requestId: ctx.requestId,
      accountId: redeemed.account_id,
    });
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "That enrollment token points at an account that does not exist.",
    );
  }
  if (account.suspended_at) {
    return errorResponse(ctx.requestId, "forbidden", "That account is suspended.");
  }

  // THE TOKEN IS ALREADY BURNED at this point, and a failure below leaves it burned. That is the correct
  // direction: a replayable enrollment token is a credential anyone who saw it once can reuse, whereas a
  // burned token costs one operator action to replace. Stated here so the next reader does not "fix" it
  // by un-consuming on failure.
  const client = await ctx.store.createClient({
    id: minted.clientId,
    account_id: account.id,
    key_id: minted.keyId,
    secret_hash: minted.secretHash,
    label: parsed.value.label,
    platform: parsed.value.platform,
  });

  return jsonResponse(
    ctx.requestId,
    {
      client_id: client.id,
      // The ONLY time the plaintext key exists outside the device. It is not recoverable, and this
      // response is the whole reason the enrollment flow exists.
      key: minted.key,
      account: {
        id: account.id,
        plan_id: account.plan_id,
        status: account.suspended_at ? "suspended" : "active",
      },
    },
    { status: 201 },
  );
}
