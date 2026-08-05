// The AI Gateway log feed: the only place Cloudflare's gateway LOG API is read.
//
// This is the biller's side of the meter. src/upstream.ts sends every inference call through the
// gateway with `cf-aig-metadata` carrying our own request id, and Cloudflare records an authoritative
// per-request `cost` against that row. This file reads those rows back so src/reconcile.ts can compare
// them to what we charged. It is a separate file from cf-api.ts and upstream.ts for the same reason
// those two are separate from each other: one credential, one blast radius, one thing it can do.
//
// IT CANNOT REACH A MODEL AND IT CANNOT READ A PAYLOAD. Neither is a matter of nobody having written
// the call yet:
//
//   * There is no code path here that POSTs anything. The only verb is GET.
//   * `GET .../logs/{id}/request` and `GET .../logs/{id}/response` are the two endpoints that return
//     stored prompt and completion bodies. Every request built here goes through `guardLogPath`, which
//     REFUSES those two shapes by throwing. The plane already sets `cf-aig-collect-log-payload: false`
//     on every call, so there is nothing stored for them to return -- but "the data should not exist"
//     and "we do not ask for it" are different guarantees, and the privacy invariant deserves both. A
//     future edit that adds a payload read has to delete a guard with a test on it, in a pull request,
//     rather than quietly add a fetch.
//
// COST IS A DECIMAL USD FLOAT ON THE WIRE, and this file is where it stops being one. Cloudflare
// reports e.g. `0.0000043` and `0.01719325`. `Math.round(cost * 1e6)` on a binary float is exactly the
// class of arithmetic migration 0001 forbids in the money path, and truncation via `toFixed(6)` would
// silently drop a third of a micro-USD on the first of those numbers. So the value is converted
// through its DECIMAL DIGITS with BigInt, which is exact.
//
// AN ABSENT COST IS UNKNOWN, NEVER ZERO. `cost` is optional in Cloudflare's own schema. A row that does
// not carry one means we cannot tell what it cost; reading that as free would create a credit refund
// out of a gap in someone else's telemetry. It is carried as null and reconciliation declines to move
// money on it, which is the same "unmetered is not a zero charge" rule src/meter.ts already enforces
// one layer up.
//
// https://developers.cloudflare.com/ai-gateway/observability/logging/
// GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs  (needs AI Gateway Read)

const CF_API = "https://api.cloudflare.com/client/v4";

/** Cloudflare's own ceiling on this endpoint's page size. Asking for more is a 400, not a bigger page. */
export const MAX_PER_PAGE = 50;

/**
 * The two endpoints that can return stored request and response bodies.
 *
 * Named as data rather than left implicit in a regex so the refusal is greppable and so the test that
 * proves the guard still fires can iterate the real list instead of a hand-copied string.
 */
export const PAYLOAD_ENDPOINT_SUFFIXES: readonly string[] = ["request", "response"];

const PAYLOAD_PATH = /\/logs\/[^/]+\/(?:request|response)\/?$/;

/** Thrown when something tries to build a request for a stored payload. Never caught in this file. */
export class GatewayPayloadRefused extends Error {
  constructor(readonly path: string) {
    super(
      `refusing to read an AI Gateway stored payload (${path}). This plane reconciles cost and token ` +
        "counts only; prompt and completion bodies are never fetched, and cf-aig-collect-log-payload " +
        "is hard-wired false so they are not stored either.",
    );
    this.name = "GatewayPayloadRefused";
  }
}

/**
 * The privacy guard, on the path rather than on the caller's intent.
 *
 * Returns the path so it can wrap a path expression inline and cannot be forgotten at a call site by
 * being written on its own line and then deleted in a refactor.
 */
export function guardLogPath(path: string): string {
  if (PAYLOAD_PATH.test(path)) throw new GatewayPayloadRefused(path);
  return path;
}

/** One gateway log row, in this plane's units and naming. Counts and cost only. */
export interface GatewayLogRow {
  /** Cloudflare's log id. Matches the `cf-aig-log-id` response header we already store on the ledger. */
  id: string;
  /** ISO 8601, from Cloudflare. The watermark is a value from this field, never a locally made clock. */
  createdAt: string;
  model: string | null;
  provider: string | null;
  statusCode: number | null;
  success: boolean | null;
  cached: boolean;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Integer micro-USD, or NULL when the row carries no usable cost. Null is unknown, not zero. */
  costMicroUsd: number | null;
  /** Our own correlation id, read out of `cf-aig-metadata`. Null when the row carries no metadata. */
  requestId: string | null;
  /** The account id we tagged the call with, for cross-checking the ledger row we join to. */
  accountId: string | null;
}

export interface GatewayLogPage {
  rows: GatewayLogRow[];
  /** Rows the API returned that could not be read at all. Counted, never silently dropped. */
  malformed: number;
  /** Cloudflare's own total for the filtered query, when it reports one. */
  totalCount: number | null;
}

/**
 * The seam reconciliation reads through.
 *
 * An interface rather than a direct fetch for the same reason `ControlPlaneStore` and `InferenceRunner`
 * are interfaces: the whole reconciliation path then runs in plain Node vitest against a scripted feed,
 * including the cases that are impossible to provoke on demand from the real API (a row with no cost, a
 * row whose metadata names a request we never recorded, a malformed page).
 */
export interface GatewayLogSource {
  /** The gateway these rows come from. Carried so the watermark row cannot be written under the wrong id. */
  readonly gatewayId: string;
  /**
   * One page of rows created strictly AFTER `sinceIso`, oldest first.
   *
   * Ascending order is load-bearing: the watermark advances to the newest row actually processed, and a
   * descending feed would make a partial run advance it past rows it never looked at.
   */
  listSince(args: { sinceIso: string; page: number; perPage: number }): Promise<GatewayLogPage>;
}

/**
 * A decimal USD value as exact integer micro-USD, or null when it is not a usable number.
 *
 * ROUNDS UP, matching src/meter.ts. The reasoning there applies unchanged: a request that reached a
 * model and cost us money must never round to free. Applied here it also means a true-up errs by at
 * most 1 micro-USD in the direction that keeps a cost-recovery product solvent, rather than the
 * direction that quietly subsidises it.
 *
 * NO FLOAT ARITHMETIC. The value is decomposed into `digits x 10^exponent` and scaled with BigInt, so
 * `0.0000043` becomes exactly 5 (4.3 rounded up) rather than whatever `0.0000043 * 1e6` happens to
 * produce in binary. Exponent notation is handled because `Number.prototype.toString` switches to it
 * below 1e-6, which is squarely inside the range of real per-request costs on cheap models.
 */
export function microUsdFromUsd(raw: unknown): number | null {
  const text =
    typeof raw === "number"
      ? Number.isFinite(raw)
        ? raw.toString()
        : null
      : typeof raw === "string"
        ? raw.trim()
        : null;
  if (!text) return null;

  const parsed = decimalParts(text);
  if (!parsed) return null;

  // Scale by 10^6 by moving the exponent, so the only division that can happen is the one that decides
  // rounding.
  const exponent = parsed.exponent + 6;
  if (exponent >= 0) {
    const scaled = parsed.digits * 10n ** BigInt(exponent);
    return withinSafeRange(scaled);
  }
  const divisor = 10n ** BigInt(-exponent);
  const whole = parsed.digits / divisor;
  const remainder = parsed.digits % divisor;
  return withinSafeRange(remainder === 0n ? whole : whole + 1n);
}

/**
 * A non-negative decimal string as `digits x 10^exponent`, or null.
 *
 * Negative values are REFUSED rather than absolute-valued. A negative cost from the biller is not a
 * refund this plane knows how to reason about, and turning it into a positive number would invent one.
 */
function decimalParts(text: string): { digits: bigint; exponent: number } | null {
  const match = /^\+?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const intPart = match[1] ?? "";
  const fracPart = match[2] ?? "";
  if (!intPart && !fracPart) return null;
  const exponent = match[3] ? Number(match[3]) : 0;
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 60) return null;
  return { digits: BigInt(`${intPart || "0"}${fracPart}`), exponent: exponent - fracPart.length };
}

/**
 * Refuse a value that cannot be an exact JavaScript integer.
 *
 * A cost above about 9 quadrillion micro-USD (9 billion USD) on one request is a corrupt feed, and
 * silently returning a lossy Number for it would put an unrepresentable amount into the money path.
 */
function withinSafeRange(value: bigint): number | null {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

/**
 * Custom metadata as an object, whatever shape it arrived in.
 *
 * BOTH SHAPES ARE REAL. Cloudflare's published schema types `metadata` as a string, and the live API on
 * this account returns it as an OBJECT (verified 2026-08-05 against the `skyphusion-llm` gateway), or
 * `null` when the request sent none. Handling one and not the other would make the join silently find
 * nothing, which is the failure mode that looks exactly like "no drift".
 */
export function metadataOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // A metadata string we cannot parse is treated as absent. It carries no content by construction
      // (ids only, see src/routes/chat.ts), so there is nothing to salvage and nothing to leak.
    }
  }
  return {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * One raw API row as a `GatewayLogRow`, or null when it is unusable.
 *
 * `id` and `created_at` are the two required fields, because they are the row's identity and the
 * watermark's only source. Everything else is optional and reads as null when absent -- including the
 * cost, which is the whole point of the type.
 */
export function parseGatewayLogRow(raw: unknown): GatewayLogRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = stringOrNull(row.id);
  const createdAt = stringOrNull(row.created_at);
  if (!id || !createdAt || Number.isNaN(Date.parse(createdAt))) return null;

  const metadata = metadataOf(row.metadata);
  return {
    id,
    createdAt,
    model: stringOrNull(row.model),
    provider: stringOrNull(row.provider),
    statusCode: intOrNull(row.status_code),
    success: typeof row.success === "boolean" ? row.success : null,
    cached: row.cached === true,
    tokensIn: intOrNull(row.tokens_in),
    tokensOut: intOrNull(row.tokens_out),
    costMicroUsd: microUsdFromUsd(row.cost),
    requestId: stringOrNull(metadata.request_id),
    accountId: stringOrNull(metadata.account_id),
  };
}

/** Cloudflare's standard v4 response envelope, only as far as this file reads it. */
interface CfEnvelope {
  success?: boolean;
  result?: unknown;
  result_info?: unknown;
  errors?: unknown;
}

export interface GatewayLogSourceDeps {
  accountId: string;
  gatewayId: string;
  /** A Cloudflare API token carrying AI Gateway Read. Never logged, never returned. */
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * The live log source.
 *
 * The filter is expressed with the endpoint's `filters` parameter (a JSON array in the query string,
 * verified live 2026-08-05) rather than the deprecated `start_date` pair, because the deprecated
 * parameters are the ones that will be removed.
 */
export function gatewayLogSource(deps: GatewayLogSourceDeps): GatewayLogSource {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    gatewayId: deps.gatewayId,

    async listSince({ sinceIso, page, perPage }) {
      const path = guardLogPath(
        `/accounts/${deps.accountId}/ai-gateway/gateways/${encodeURIComponent(deps.gatewayId)}/logs`,
      );
      const query = new URLSearchParams({
        page: String(Math.max(1, Math.trunc(page))),
        per_page: String(Math.min(MAX_PER_PAGE, Math.max(1, Math.trunc(perPage)))),
        order_by: "created_at",
        order_by_direction: "asc",
        filters: JSON.stringify([{ key: "created_at", operator: "gt", value: [sinceIso] }]),
      });

      const res = await doFetch(`${CF_API}${path}?${query.toString()}`, {
        method: "GET",
        headers: { authorization: `Bearer ${deps.token}`, accept: "application/json" },
      });

      let envelope: CfEnvelope | null = null;
      try {
        envelope = (await res.json()) as CfEnvelope;
      } catch {
        throw new Error(`ai-gateway logs: HTTP ${res.status} with an unreadable body`);
      }
      if (!res.ok || envelope?.success !== true) {
        // Cloudflare's own error codes are preserved. A 9109 (token lacks AI Gateway Read) and a 400
        // (bad filter) need completely different operator actions, and "reconcile failed" costs an
        // afternoon.
        const errors = Array.isArray(envelope?.errors)
          ? (envelope.errors as Array<{ code?: unknown; message?: unknown }>)
              .map((e) => `${String(e?.code ?? "?")} ${String(e?.message ?? "")}`.trim())
              .join("; ")
          : "";
        throw new Error(`ai-gateway logs: HTTP ${res.status}${errors ? ` (${errors})` : ""}`);
      }

      const raw = Array.isArray(envelope.result) ? envelope.result : [];
      const rows: GatewayLogRow[] = [];
      let malformed = 0;
      for (const item of raw) {
        const parsed = parseGatewayLogRow(item);
        if (parsed) rows.push(parsed);
        else malformed += 1;
      }
      const info = (envelope.result_info ?? {}) as Record<string, unknown>;
      return { rows, malformed, totalCount: intOrNull(info.total_count) };
    },
  };
}
