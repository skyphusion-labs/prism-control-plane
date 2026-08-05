// The model allowlist AND the price list. Single source of truth for both.
//
// A CLOSED ALLOWLIST, not a passthrough. A client can only name an id that appears here, so this
// plane can never be used to reach a model whose cost we have not priced. That is the whole reason
// allowlist and pricing live in ONE table: an entry that exists but has no price would be a spendable
// model with an unmeterable bill, and the type makes that unrepresentable.
//
// EVERY NUMBER BELOW WAS READ OFF CLOUDFLARE'S OWN PAGES ON 2026-08-04, per entry, not carried over
// from memory and not inferred from a sibling model:
//   - context window and unit pricing: developers.cloudflare.com/workers-ai/models/<model>/
//   - the granular per-model rate: developers.cloudflare.com/workers-ai/platform/pricing/
// `pricedAt` records that date. It exists so that a stale rate is visibly stale rather than
// confidently wrong, and GET /v1/models publishes it to clients for the same reason.
//
// WHERE THE TWO CLOUDFLARE PAGES DISAGREE, the granular pricing page wins and the disagreement is
// noted on the entry. The model page rounds (llama-3.2-3b shows $0.34 output where the pricing table
// says $0.335); the pricing table is the billing rate, so that is what we meter from.
//
// WORKERS AI ONLY (`@cf/` prefix), deliberately. Those bill on Workers AI pricing rather than drawing
// down Unified Billing credits, which keeps this build's spend bounded and predictable. Adding a
// third-party model (`openai/`, `anthropic/`) is a spend decision, not a code change:
// docs/CONTRACT.md open decision 5.

/** Entitlement bucket a plan grants or withholds. Kept coarse on purpose: a per-model entitlement
 * list on every plan would have to be edited every time the catalog moves. */
export type ModelTier = "standard" | "premium";

export interface ModelPrice {
  /** Integer micro-USD per MILLION input tokens. 1 USD = 1,000,000 micro-USD. */
  inputMicroUsdPerMTok: number;
  /** Integer micro-USD per MILLION output tokens. */
  outputMicroUsdPerMTok: number;
  /** ISO date the rate was read off Cloudflare's published pricing. */
  pricedAt: string;
}

export interface CatalogEntry {
  /**
   * The PUBLIC id, and also the upstream id.
   *
   * They are the same value today but they are separate FIELDS so that re-pointing a public id at a
   * different upstream model (a deprecation, a rename, a cheaper equivalent) is a one-line change here
   * instead of a breaking change to every installed client.
   */
  id: string;
  upstream: string;
  displayName: string;
  tier: ModelTier;
  /** Vendor-published context window in tokens. Informational for the client; this plane does not
   * enforce it, the model does. */
  contextWindow: number;
  /** Vendor-published ceiling we advertise per request. The EFFECTIVE cap is the smaller of this and
   * the plan's max_output_tokens. */
  maxOutputTokens: number;
  streaming: boolean;
  price: ModelPrice;
}

const PRICED_AT = "2026-08-04";

/**
 * The seeded catalog.
 *
 * THERE IS NO `premium` ENTRY YET, and that is a finding rather than an omission. The premium
 * candidates were checked on 2026-08-04 and each one failed a check that matters:
 * `@cf/moonshotai/kimi-k2.5` is marked Deprecated (5/30/2026), and
 * `@cf/meta/llama-3.1-8b-instruct-fp8-fast` appears in the pricing table but has no model page (404),
 * so its context window could not be verified. Seeding either would put an unverifiable fact in a
 * contract clients read. The `premium` tier stays defined because the entitlement mechanism is real
 * and tested; filling it is a spend decision.
 */
export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "@cf/meta/llama-3.2-3b-instruct",
    upstream: "@cf/meta/llama-3.2-3b-instruct",
    displayName: "Llama 3.2 3B Instruct",
    tier: "standard",
    contextWindow: 80_000,
    maxOutputTokens: 4096,
    streaming: true,
    price: {
      inputMicroUsdPerMTok: 51_000,
      // The model page rounds this to $0.34; the granular pricing table says $0.335. Metering from
      // the granular rate, which is what we are actually billed.
      outputMicroUsdPerMTok: 335_000,
      pricedAt: PRICED_AT,
    },
  },
  {
    id: "@cf/zai-org/glm-4.7-flash",
    upstream: "@cf/zai-org/glm-4.7-flash",
    displayName: "GLM 4.7 Flash",
    tier: "standard",
    contextWindow: 131_072,
    maxOutputTokens: 8192,
    streaming: true,
    price: {
      inputMicroUsdPerMTok: 60_000,
      outputMicroUsdPerMTok: 400_000,
      pricedAt: PRICED_AT,
    },
  },
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    upstream: "@cf/google/gemma-4-26b-a4b-it",
    displayName: "Gemma 4 26B",
    tier: "standard",
    contextWindow: 256_000,
    maxOutputTokens: 8192,
    streaming: true,
    price: {
      inputMicroUsdPerMTok: 100_000,
      outputMicroUsdPerMTok: 300_000,
      pricedAt: PRICED_AT,
    },
  },
];

const BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));

/** Look up a public model id. Returns undefined for anything not in the allowlist. */
export function findModel(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

/** The subset a tier list entitles, in catalog order (which is cheapest-first by intent). */
export function modelsForTiers(tiers: readonly ModelTier[]): CatalogEntry[] {
  const allowed = new Set(tiers);
  return CATALOG.filter((entry) => allowed.has(entry.tier));
}

/** The client-facing projection. One place, so GET /v1/models and the contract cannot drift. */
export function publicModel(entry: CatalogEntry): Record<string, unknown> {
  return {
    id: entry.id,
    display_name: entry.displayName,
    tier: entry.tier,
    context_window: entry.contextWindow,
    max_output_tokens: entry.maxOutputTokens,
    streaming: entry.streaming,
    price: {
      input_micro_usd_per_mtok: entry.price.inputMicroUsdPerMTok,
      output_micro_usd_per_mtok: entry.price.outputMicroUsdPerMTok,
      priced_at: entry.price.pricedAt,
    },
  };
}
