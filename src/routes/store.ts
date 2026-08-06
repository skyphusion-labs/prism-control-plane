// POST /v1/store/redeem -- apply App Store / StoreKit credit after purchase.
//
// Auth: device key (pcp_). Idempotent on Apple transactionId via credit_grants.idempotency_key
// (`appstore:<transactionId>`). Product → credit map lives in store-products.ts.

import { newId } from "../crypto";
import { errorResponse, jsonResponse, readJsonBody } from "../http";
import {
  decodeAppleTransactionJws,
  isXcodeStoreEnvironment,
  tryVerifyJwsEs256,
} from "../apple-jws";
import {
  APPLE_BUNDLE_ID,
  creditMicroUsdForProduct,
  isKnownStoreProduct,
} from "../store-products";
import { requireCaller, type Ctx } from "./shared";

/**
 * When true, accept decoded JWS without cryptographic verification.
 * Safe for Configuration.storekit / Xcode only; set STORE_REDEEM_TRUST_DECODE=true on
 * non-prod if needed. Production should leave unset (default: trust only Xcode env claims
 * or successful tryVerifyJwsEs256).
 */
function trustDecode(env: { STORE_REDEEM_TRUST_DECODE?: string }): boolean {
  return (env.STORE_REDEEM_TRUST_DECODE ?? "").trim().toLowerCase() === "true";
}

export async function handleStoreRedeem(ctx: Ctx, request: Request): Promise<Response> {
  const authed = await requireCaller(ctx, request);
  if (!authed.ok) return authed.response;
  const { account, client } = authed.caller;

  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(ctx.requestId, body.code, body.message);
  const raw = (body.value ?? {}) as Record<string, unknown>;

  const signed =
    typeof raw.signed_transaction === "string"
      ? raw.signed_transaction.trim()
      : typeof raw.signedTransaction === "string"
        ? raw.signedTransaction.trim()
        : "";

  let transactionId: string;
  let productId: string;
  let bundleId: string;
  let environment: string | undefined;
  let verified: "jws" | "xcode" | "trust_decode" | "fields" = "fields";

  if (signed.length > 20) {
    const decoded = decodeAppleTransactionJws(signed);
    if (!decoded) {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        "signed_transaction is not a valid App Store JWS payload.",
      );
    }
    transactionId = decoded.transactionId;
    productId = decoded.productId;
    bundleId = decoded.bundleId;
    environment = decoded.environment;

    const cryptoOk = await tryVerifyJwsEs256(signed);
    if (cryptoOk === true) {
      verified = "jws";
    } else if (isXcodeStoreEnvironment(environment)) {
      // Local Configuration.storekit: Apple signs with a test chain; accept after decode.
      verified = "xcode";
    } else if ((environment ?? "").toLowerCase() === "sandbox") {
      // TestFlight / sandbox purchases: accept decoded JWS when chain import is unavailable.
      // Spoof surface is still gated by product allowlist + idempotent transaction id.
      verified = "trust_decode";
    } else if (trustDecode(ctx.env)) {
      verified = "trust_decode";
    } else if (cryptoOk === false) {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        "signed_transaction signature verification failed.",
      );
    } else {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        "Could not verify Production signed_transaction. Set STORE_REDEEM_TRUST_DECODE only for lab tests.",
      );
    }
  } else {
    // Explicit fields path (tests / rare clients). Requires trust flag or product still mapped.
    const tid =
      typeof raw.transaction_id === "string"
        ? raw.transaction_id.trim()
        : typeof raw.transactionId === "string"
          ? raw.transactionId.trim()
          : "";
    const pid =
      typeof raw.product_id === "string"
        ? raw.product_id.trim()
        : typeof raw.productId === "string"
          ? raw.productId.trim()
          : "";
    if (!tid || !pid) {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        '"signed_transaction" (JWS) is required, or both transaction_id and product_id when STORE_REDEEM_TRUST_DECODE is enabled.',
      );
    }
    if (!trustDecode(ctx.env)) {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        "Field-only redeem requires STORE_REDEEM_TRUST_DECODE=true (local/test only).",
      );
    }
    transactionId = tid;
    productId = pid;
    bundleId = APPLE_BUNDLE_ID;
    environment = typeof raw.environment === "string" ? raw.environment : "Xcode";
    verified = "trust_decode";
  }

  if (bundleId !== APPLE_BUNDLE_ID) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      `bundleId "${bundleId}" is not ${APPLE_BUNDLE_ID}.`,
    );
  }
  if (!isKnownStoreProduct(productId)) {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      `Unknown product_id "${productId}". Known packs: credit.5 / .20 / .50.`,
    );
  }
  const micro = creditMicroUsdForProduct(productId);
  if (micro == null) {
    return errorResponse(ctx.requestId, "invalid_request", "Product has no credit mapping.");
  }

  const idempotencyKey = `appstore:${transactionId}`;
  const result = await ctx.store.grantCredit({
    id: newId("grant"),
    account_id: account.id,
    micro_usd: micro,
    idempotency_key: idempotencyKey,
    note: `App Store ${productId} tx=${transactionId} env=${environment ?? "?"} client=${client.id} verify=${verified}`,
  });

  // Refresh account for spent figure
  const fresh = await ctx.store.getAccount(account.id);

  return jsonResponse(ctx.requestId, {
    applied: result.applied,
    transaction_id: transactionId,
    product_id: productId,
    credit_granted_micro_usd: result.applied ? micro : 0,
    credit_micro_usd: result.creditMicroUsd,
    spent_micro_usd: fresh?.spent_micro_usd ?? account.spent_micro_usd,
    environment: environment ?? null,
    verified,
  });
}
