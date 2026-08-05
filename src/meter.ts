// Pricing one inference request, or honestly declining to. PURE.
//
// TWO OUTCOMES, AND THE SECOND ONE IS THE WHOLE DESIGN:
//
//   metered     we know what the request consumed. Price it and charge the period.
//   unmetered   the model answered but did NOT report usable token counts. Record the request with a
//               reason, charge NOTHING, and do not advance the period counter.
//
// "Nothing was owed" and "we could not tell what was owed" must not share a representation. A zero
// charge is a complete, correct answer; an unpriceable request is a GAP. If both wrote the same row,
// every hole in the meter would look exactly like a cheap request, the totals would be quietly low,
// and nobody would ever find out. So an unmetered request is a first-class outcome that is counted
// separately and published to the client in GET /v1/usage.
//
// This is the same posture vivijure-control-plane's overage settlement takes (`unbillable`), applied
// one layer down: there it is a billing window we could not fully observe, here it is a single request
// whose usage the model would not tell us.
//
// The injected price is deliberate: a money decision that reads its own config can only be tested
// against the values the environment happens to hold, not against the values that matter.

import type { ModelPrice } from "./catalog";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type MeterOutcome =
  | {
      outcome: "metered";
      /** Integer micro-USD for this request. ALWAYS >= 1 when the model produced any tokens. */
      microUsd: number;
      usage: TokenUsage;
    }
  | { outcome: "unmetered"; reason: string };

/**
 * Read token counts out of whatever the upstream returned.
 *
 * DEFENSIVE BY DESIGN, and not because the shapes are unknown -- because there are genuinely SEVERAL,
 * verified on 2026-08-04: `@cf/meta/llama-3.2-3b-instruct` answers the Workers AI shape
 * (`{ response, usage }`), while `@cf/zai-org/glm-4.7-flash` and `@cf/google/gemma-4-26b-a4b-it`
 * answer the OpenAI shape (`{ choices, usage }`). Both spell usage the same way
 * (`prompt_tokens` / `completion_tokens`), so ONE reader covers both.
 *
 * DETECTION RATHER THAN A PER-MODEL FLAG is the deliberate choice. A pinned per-entry shape field
 * would be a fact about someone else's API that goes stale silently the next time a model's serving
 * path changes; a reader that looks at what actually arrived cannot go stale, and when it finds
 * nothing it says so instead of guessing.
 *
 * Returns null when there is nothing usable, which the caller turns into `unmetered`. A missing count
 * is NEVER read as zero: zero tokens is a claim about the request, absent is a claim about our
 * knowledge of it.
 */
export function extractUsage(body: unknown): TokenUsage | null {
  if (typeof body !== "object" || body === null) return null;
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const raw = usage as Record<string, unknown>;
  const input = raw.prompt_tokens ?? raw.input_tokens;
  const output = raw.completion_tokens ?? raw.output_tokens;
  if (!Number.isInteger(input) || !Number.isInteger(output)) return null;
  const inputTokens = input as number;
  const outputTokens = output as number;
  if (inputTokens < 0 || outputTokens < 0) return null;
  return { inputTokens, outputTokens };
}

/**
 * Price a request.
 *
 * ROUNDING IS UP, ON THE TOTAL, AND THAT IS A DECISION WITH A REASON.
 *
 * Rounding up on the total (rather than per component, or to nearest) guarantees that any request
 * which consumed tokens records at least 1 micro-USD. A request that reached a model and cost us GPU
 * time must never appear in the ledger as free, because a zero-cost metered row is indistinguishable
 * from an unmetered one when you sum the column, which would defeat the separation this whole file
 * exists to maintain.
 *
 * The cost of that choice, stated rather than buried: an account is over-charged by at most 1
 * micro-USD (0.000001 USD) per request. At any plausible request volume that is far below the
 * rounding error in the vendor's own per-token rates, and it errs in the direction that keeps a
 * cost-recovery product solvent rather than the direction that silently subsidises it.
 */
export function priceUsage(usage: TokenUsage, price: ModelPrice): MeterOutcome {
  if (!Number.isInteger(price.inputMicroUsdPerMTok) || price.inputMicroUsdPerMTok < 0) {
    return {
      outcome: "unmetered",
      reason: `input rate ${String(price.inputMicroUsdPerMTok)} is not a non-negative integer micro-USD per Mtok`,
    };
  }
  if (!Number.isInteger(price.outputMicroUsdPerMTok) || price.outputMicroUsdPerMTok < 0) {
    return {
      outcome: "unmetered",
      reason: `output rate ${String(price.outputMicroUsdPerMTok)} is not a non-negative integer micro-USD per Mtok`,
    };
  }
  const exact =
    (usage.inputTokens * price.inputMicroUsdPerMTok +
      usage.outputTokens * price.outputMicroUsdPerMTok) /
    1_000_000;
  return { outcome: "metered", microUsd: Math.ceil(exact), usage };
}

/**
 * The whole metering decision for one upstream answer: read the usage, then price it.
 *
 * Kept as one entry point so a caller cannot accidentally price a usage it did not validate, and so
 * the "no usable usage" path has exactly one wording of its reason.
 */
export function meterResponse(body: unknown, price: ModelPrice): MeterOutcome {
  const usage = extractUsage(body);
  if (!usage) {
    return {
      outcome: "unmetered",
      reason:
        "the upstream response carried no usable token counts (no integer prompt_tokens / " +
        "completion_tokens), so this request cannot be priced. Recorded as unmetered rather than " +
        "as a zero-cost request",
    };
  }
  return priceUsage(usage, price);
}
