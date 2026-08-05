// The wire envelope: error codes, status mapping, JSON helpers, correlation ids.
//
// ONE definition of the error shape, because docs/CONTRACT.md promises clients a stable
// `{ error: { code, message, request_id } }` and a status per code. If any route hand-rolls its own
// error body, the contract is a suggestion. The status mapping lives in a table here so that adding a
// code without deciding its status is impossible.

/** The contract's API version. It rides on every response and the path prefix agrees with it. */
export const API_VERSION = "1";

/**
 * Stable machine-readable failure codes. Additive only: a client is told to treat an unknown code as
 * a non-retryable failure of its status class, which is only safe if existing codes never change
 * meaning.
 */
export type ErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "client_revoked"
  | "forbidden"
  | "model_not_entitled"
  | "model_not_found"
  | "model_unpriced"
  | "model_unsupported"
  | "not_found"
  | "payload_too_large"
  | "rate_limited"
  | "quota_exhausted"
  | "not_implemented"
  | "upstream_error"
  | "upstream_timeout"
  | "unavailable"
  | "internal";

/**
 * Code to HTTP status. Exhaustive by type, so a new code will not compile until its status is chosen.
 *
 * The two entries worth defending:
 *
 *   quota_exhausted -> 402, NOT 429. A spent allowance is budgetary: the identical request will keep
 *   failing until the period rolls. 429 tells every client and every HTTP library in the world to
 *   back off and retry, which is exactly the wrong behaviour, and it makes a hard stop look like a
 *   blip.
 *
 *   client_revoked -> 401 with its own code. The status is right (the credential is no good) but a
 *   client must distinguish it from a malformed header: one means retry with a correct bearer, the
 *   other means this key is dead forever and the stored copy should be deleted.
 *
 *   model_unpriced -> 409, and NOT 404 or 403. The model is real and the plan entitles it; what is
 *   missing is a rate on OUR side, so it is a conflict with the server's state rather than a fact about
 *   the client's request or entitlements. 404 would tell a client to drop the model from its picker,
 *   which is wrong: the model comes back the moment a price is set. GET /v1/models publishes
 *   `spendable: false` for exactly these, so a well-behaved client never reaches this code.
 *
 *   model_unsupported -> 501. The catalog lists every model prism offers, including image, video, audio
 *   and music. Those have no door here yet because their prices are per tile, per step and per audio
 *   minute, and no meter for those units exists. Listing them and refusing with a named reason is more
 *   useful than hiding them: a client can see the catalog it will eventually get.
 */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  client_revoked: 401,
  forbidden: 403,
  model_not_entitled: 403,
  model_not_found: 404,
  model_unpriced: 409,
  model_unsupported: 501,
  not_found: 404,
  payload_too_large: 413,
  rate_limited: 429,
  quota_exhausted: 402,
  not_implemented: 501,
  upstream_error: 502,
  upstream_timeout: 504,
  unavailable: 503,
  internal: 500,
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/** Correlation id. Opaque, 12 random bytes hex; handed to the client and written to the ledger. */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `req_${hex}`;
}

function baseHeaders(requestId: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("prism-api-version", API_VERSION);
  headers.set("prism-request-id", requestId);
  // This plane serves no browser origin of its own and is called by native clients, so there is no
  // CORS allowance to grant. Absent is the correct answer, and stating that here stops it being
  // added "just in case" later.
  headers.set("cache-control", "no-store");
  return headers;
}

export function jsonResponse(
  requestId: string,
  body: unknown,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: baseHeaders(requestId, init.headers),
  });
}

/**
 * The only way to produce a failure response.
 *
 * `detail` merges extra fields INTO the error object (e.g. `period` and `resets_at` on
 * quota_exhausted, `upstream_status` on upstream_error). Clients are told to tolerate extra fields, so
 * this stays additive.
 *
 * The message is prose for a human reading a log or a support report. Clients branch on `code`, never
 * on the message, which is why message wording is free to change and code wording is not.
 */
export function errorResponse(
  requestId: string,
  code: ErrorCode,
  message: string,
  detail: Record<string, unknown> = {},
  headers?: HeadersInit,
): Response {
  return jsonResponse(
    requestId,
    { error: { code, message, request_id: requestId, ...detail } },
    { status: statusForCode(code), headers },
  );
}

/**
 * Request body cap, in bytes. 256 KiB.
 *
 * Enforced BEFORE the body is fully buffered: Content-Length refuses early when present, and a
 * chunked body is streamed with a running total so the cap bounds memory, not a post-hoc measurement.
 */
export const MAX_BODY_BYTES = 256 * 1024;

export type ReadBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; code: "invalid_request" | "payload_too_large"; message: string };

/**
 * Read request body bytes under the size cap WITHOUT buffering past it.
 *
 * Content-Length is checked first when present. For chunked or missing length, the stream is
 * consumed with a running total and cancelled as soon as the cap is crossed -- so the cap bounds
 * memory, not just a post-hoc measurement of a fully buffered body.
 */
async function readBodyBytesCapped(request: Request): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: "invalid_request" | "payload_too_large"; message: string }
> {
  const declared = request.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return {
        ok: false,
        code: "payload_too_large",
        message: `Request body is ${n} bytes; the cap is ${MAX_BODY_BYTES}.`,
      };
    }
  }

  if (!request.body) {
    return { ok: true, bytes: new Uint8Array(0) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return {
          ok: false,
          code: "payload_too_large",
          message: `Request body exceeds the cap of ${MAX_BODY_BYTES} bytes.`,
        };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: "invalid_request", message: "Request body could not be read." };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** Read and parse a JSON body under the size cap. Never throws. */
export async function readJsonBody(request: Request): Promise<ReadBodyResult> {
  const raw = await readBodyBytesCapped(request);
  if (!raw.ok) return raw;

  const text = new TextDecoder().decode(raw.bytes);
  if (!text.trim()) {
    return { ok: false, code: "invalid_request", message: "Request body is required." };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, code: "invalid_request", message: "Request body is not valid JSON." };
  }
}
