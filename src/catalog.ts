// The model allowlist AND the price list. Single source of truth for both.
//
// A CLOSED ALLOWLIST, not a passthrough. A client can only name an id that appears here, so this
// plane can never be asked to reach a model nobody chose to offer.
//
// SCOPE (2026-08-04): every model prism (`skyphusion-llm`) offers today, all 94 of them, across all
// seven modalities. Parity with prism's catalog is the requirement, so this file is the join of two
// facts and nothing else:
//   - the id, label, modality and streaming flag come from prism's src/models.ts
//   - the price comes from Cloudflare's own account model catalog,
//     GET /accounts/{id}/ai/models/search, read live on 2026-08-04
// Neither half is typed from memory. The pricing docs page was cross-read and agrees with the API to
// the digit; where they differ in rounding the API wins, because that is the record CF bills from.
//
// PRICE IS NULLABLE. A model with `price: null` is catalogued but not spendable (`model_unpriced`).
//
// Workers AI (`@cf/`) rates come from Cloudflare's models API (2026-08-04). Unified Billing rates were
// filled from CF `compat/models` + live billing verification (issue #10, 2026-08-05). Those rates move
// intraday; operator overrides (`model_prices`) and POST /admin/reconcile true them up. One chat model
// stays unpriced: `@cf/llava-hf/llava-1.5-7b-hf` is absent from the gateway catalog.
//
// `publishedRates` carries the non-token rates CF does publish (per tile, per step, per audio minute).
// They are DISCLOSURE, not money math: the unit meters for tiles, steps and audio minutes do not exist
// yet, so those modalities have no door. Their numbers are floats in USD on purpose, so nobody mistakes
// them for the integer micro-USD the ledger is denominated in.

/** Which door a model belongs to. Only `chat` has one today; the rest are catalogued for parity. */
export type Modality = "chat" | "image" | "tts" | "stt" | "voice" | "music" | "video";

/**
 * Which bill the inference lands on.
 *
 * `workers-ai` bills at Workers AI rates. `unified-billing` draws down Cloudflare credits at the
 * provider's list price. Both are OUR money -- this plane is host-billed -- so the distinction is not
 * about who pays, it is about which rate card applies and which balance drains.
 */
export type Billing = "workers-ai" | "unified-billing";

/**
 * Entitlement bucket a plan grants or withholds.
 *
 * Mapped onto `billing` rather than invented: `standard` is Workers AI, `premium` is Unified Billing.
 * A price-band tier would need re-deciding every time a vendor moves a rate; a billing-surface tier is
 * a fact about where the money goes and it does not drift.
 */
export type ModelTier = "standard" | "premium";

/** A per-token rate this plane can meter. Integer micro-USD; 1 USD = 1,000,000 micro-USD. */
export interface TokenPrice {
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
  /**
   * The cached-input rate where the vendor publishes one, else null.
   *
   * PRESENT BUT NOT YET USED BY THE METER: no upstream shape this plane has verified reports cached
   * token counts separately, so pricing at the cached rate would be a guess in the customer's favour on
   * a number we cannot see. Recorded so the rate is not lost, and so the day usage reporting grows a
   * cached-token field the number is already here.
   */
  cachedInputMicroUsdPerMTok: number | null;
  /** ISO date the rate was read off Cloudflare. A stale rate should look stale, not authoritative. */
  pricedAt: string;
}

/** A published rate whose unit is not tokens, and which therefore no meter here can charge. */
export interface UnitRate {
  unit: string;
  /** USD per unit, as published. Float on purpose: see the header. */
  usdPerUnit: number;
}

export interface CatalogEntry {
  /**
   * The PUBLIC id, and also the upstream id.
   *
   * Same value today, separate FIELDS so that re-pointing a public id at a different upstream model (a
   * deprecation, a rename, a cheaper equivalent) is a one-line change here rather than a breaking
   * change to every installed client.
   */
  id: string;
  upstream: string;
  displayName: string;
  modality: Modality;
  billing: Billing;
  tier: ModelTier;
  streaming: boolean;
  /**
   * Vendor ceiling on output tokens, or null when this plane has not verified one.
   *
   * NULL IS NOT UNLIMITED. It means the effective cap is the plan's cap alone. Only three entries carry
   * a number because only three were read off a model page; filling the other 91 from a sibling model
   * would put 91 unverified facts into a contract clients read. Context window was dropped from the
   * catalog for the same reason.
   */
  maxOutputTokens: number | null;
  /** The meterable rate, or null when Cloudflare publishes none. Null closes the door: see header. */
  price: TokenPrice | null;
  /** Non-token published rates. Disclosure only; nothing here is charged. */
  publishedRates: readonly UnitRate[];
}

const PRICED_AT = "2026-08-04";
/** Unified Billing rates from CF compat/models + live billing, issue #10 (2026-08-05). */
const PRICED_AT_UB = "2026-08-05";

export const CATALOG: readonly CatalogEntry[] = [

  // ---- chat ----
  {
    id: "anthropic/claude-fable-5",
    upstream: "anthropic/claude-fable-5",
    displayName: "Claude Fable 5 (Anthropic)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 10000000,
      outputMicroUsdPerMTok: 50000000,
      cachedInputMicroUsdPerMTok: 1000000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "anthropic/claude-sonnet-5",
    upstream: "anthropic/claude-sonnet-5",
    displayName: "Claude Sonnet 5 (Anthropic)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 2000000,
      outputMicroUsdPerMTok: 10000000,
      cachedInputMicroUsdPerMTok: 200000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "anthropic/claude-opus-5",
    upstream: "anthropic/claude-opus-5",
    displayName: "Claude Opus 5 (Anthropic)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 5000000,
      outputMicroUsdPerMTok: 25000000,
      cachedInputMicroUsdPerMTok: 500000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "anthropic/claude-opus-4-8",
    upstream: "anthropic/claude-opus-4-8",
    displayName: "Claude Opus 4.8 (Anthropic)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 5000000,
      outputMicroUsdPerMTok: 25000000,
      cachedInputMicroUsdPerMTok: 500000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "anthropic/claude-opus-4-7",
    upstream: "anthropic/claude-opus-4-7",
    displayName: "Claude Opus 4.7 (Anthropic)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 5000000,
      outputMicroUsdPerMTok: 25000000,
      cachedInputMicroUsdPerMTok: 500000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "anthropic/claude-opus-4-6",
    upstream: "anthropic/claude-opus-4-6",
    displayName: "Claude Opus 4.6 (Anthropic)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 5000000,
      outputMicroUsdPerMTok: 25000000,
      cachedInputMicroUsdPerMTok: 500000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    upstream: "anthropic/claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6 (Anthropic)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 3000000,
      outputMicroUsdPerMTok: 15000000,
      cachedInputMicroUsdPerMTok: 300000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "anthropic/claude-haiku-4-5",
    upstream: "anthropic/claude-haiku-4-5",
    displayName: "Claude Haiku 4.5 (Anthropic)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 1000000,
      outputMicroUsdPerMTok: 5000000,
      cachedInputMicroUsdPerMTok: 100000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "xai/grok-4.5",
    upstream: "xai/grok-4.5",
    displayName: "Grok 4.5 (xAI)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 2000000,
      outputMicroUsdPerMTok: 6000000,
      cachedInputMicroUsdPerMTok: 300000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "xai/grok-4.3",
    upstream: "xai/grok-4.3",
    displayName: "Grok 4.3 (xAI)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 1250000,
      outputMicroUsdPerMTok: 2500000,
      cachedInputMicroUsdPerMTok: 200000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "xai/grok-4.20-multi-agent-0309",
    upstream: "xai/grok-4.20-multi-agent-0309",
    displayName: "Grok 4.20 Multi-Agent (xAI)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 1250000,
      outputMicroUsdPerMTok: 2500000,
      cachedInputMicroUsdPerMTok: 200000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "xai/grok-4.20-0309-reasoning",
    upstream: "xai/grok-4.20-0309-reasoning",
    displayName: "Grok 4.20 Reasoning (xAI)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 1250000,
      outputMicroUsdPerMTok: 2500000,
      cachedInputMicroUsdPerMTok: 200000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "moonshotai/kimi-k3",
    upstream: "moonshotai/kimi-k3",
    displayName: "Kimi K3 (Moonshot, 1M ctx)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 3000000,
      outputMicroUsdPerMTok: 15000000,
      cachedInputMicroUsdPerMTok: 300000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "@cf/moonshotai/kimi-k2.6",
    upstream: "@cf/moonshotai/kimi-k2.6",
    displayName: "Kimi K2.6 (1T)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 950_000,
      outputMicroUsdPerMTok: 4_000_000,
      cachedInputMicroUsdPerMTok: 160_000,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/moonshotai/kimi-k2.7-code",
    upstream: "@cf/moonshotai/kimi-k2.7-code",
    displayName: "Kimi K2.7 Code (1T, vision)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 950_000,
      outputMicroUsdPerMTok: 4_000_000,
      cachedInputMicroUsdPerMTok: 190_000,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/openai/gpt-oss-120b",
    upstream: "@cf/openai/gpt-oss-120b",
    displayName: "GPT-OSS 120B (reasoning)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 350_000,
      outputMicroUsdPerMTok: 750_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    upstream: "@cf/meta/llama-4-scout-17b-16e-instruct",
    displayName: "Llama 4 Scout (MoE, vision)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 270_000,
      outputMicroUsdPerMTok: 850_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    upstream: "@cf/google/gemma-4-26b-a4b-it",
    displayName: "Gemma 4 26B (vision)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: 8192,
    price: {
      inputMicroUsdPerMTok: 100_000,
      outputMicroUsdPerMTok: 300_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/openai/gpt-oss-20b",
    upstream: "@cf/openai/gpt-oss-20b",
    displayName: "GPT-OSS 20B",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 200_000,
      outputMicroUsdPerMTok: 300_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "openai/gpt-5.5",
    upstream: "openai/gpt-5.5",
    displayName: "GPT-5.5 (OpenAI)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 5000000,
      outputMicroUsdPerMTok: 30000000,
      cachedInputMicroUsdPerMTok: 500000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "openai/gpt-5.5-pro",
    upstream: "openai/gpt-5.5-pro",
    displayName: "GPT-5.5 Pro (OpenAI, Responses)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 30000000,
      outputMicroUsdPerMTok: 180000000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "openai/gpt-5.6-sol",
    upstream: "openai/gpt-5.6-sol",
    displayName: "GPT-5.6 Sol (OpenAI, Responses)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 5000000,
      outputMicroUsdPerMTok: 30000000,
      cachedInputMicroUsdPerMTok: 500000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "openai/gpt-5.6-terra",
    upstream: "openai/gpt-5.6-terra",
    displayName: "GPT-5.6 Terra (OpenAI, Responses)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 1000000,
      outputMicroUsdPerMTok: 6000000,
      cachedInputMicroUsdPerMTok: 100000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "openai/gpt-5.6-luna",
    upstream: "openai/gpt-5.6-luna",
    displayName: "GPT-5.6 Luna (OpenAI, Responses)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 100000,
      outputMicroUsdPerMTok: 600000,
      cachedInputMicroUsdPerMTok: 10000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "openai/gpt-5.4",
    upstream: "openai/gpt-5.4",
    displayName: "GPT-5.4 (OpenAI)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 2500000,
      outputMicroUsdPerMTok: 15000000,
      cachedInputMicroUsdPerMTok: 250000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "openai/gpt-5.4-mini",
    upstream: "openai/gpt-5.4-mini",
    displayName: "GPT-5.4 mini (OpenAI)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 750000,
      outputMicroUsdPerMTok: 4500000,
      cachedInputMicroUsdPerMTok: 75000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "openai/o4-mini",
    upstream: "openai/o4-mini",
    displayName: "o4-mini (OpenAI, reasoning)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 1100000,
      outputMicroUsdPerMTok: 4400000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    upstream: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    displayName: "Llama 3.3 70B (fp8)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 293_000,
      outputMicroUsdPerMTok: 2_253_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/meta/llama-3.2-11b-vision-instruct",
    upstream: "@cf/meta/llama-3.2-11b-vision-instruct",
    displayName: "Llama 3.2 11B (vision)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 48_500,
      outputMicroUsdPerMTok: 676_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/meta/llama-3.2-3b-instruct",
    upstream: "@cf/meta/llama-3.2-3b-instruct",
    displayName: "Llama 3.2 3B",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: 4096,
    price: {
      inputMicroUsdPerMTok: 50_900,
      outputMicroUsdPerMTok: 335_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    upstream: "@cf/qwen/qwen3-30b-a3b-fp8",
    displayName: "Qwen3 30B MoE",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 50_900,
      outputMicroUsdPerMTok: 335_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/qwen/qwq-32b",
    upstream: "@cf/qwen/qwq-32b",
    displayName: "QwQ 32B (reasoning)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 660_000,
      outputMicroUsdPerMTok: 1_000_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/qwen/qwen2.5-coder-32b-instruct",
    upstream: "@cf/qwen/qwen2.5-coder-32b-instruct",
    displayName: "Qwen2.5 Coder 32B",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 660_000,
      outputMicroUsdPerMTok: 1_000_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    upstream: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    displayName: "DeepSeek R1 32B",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 497_000,
      outputMicroUsdPerMTok: 4_881_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    upstream: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    displayName: "Mistral Small 3.1 (vision)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 351_000,
      outputMicroUsdPerMTok: 555_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/zai-org/glm-4.7-flash",
    upstream: "@cf/zai-org/glm-4.7-flash",
    displayName: "GLM-4.7 Flash (Z.AI, 100+ lang)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: 8192,
    price: {
      inputMicroUsdPerMTok: 60_500,
      outputMicroUsdPerMTok: 400_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/zai-org/glm-5.2",
    upstream: "@cf/zai-org/glm-5.2",
    displayName: "GLM-5.2 (Z.AI, agentic coding)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 1_400_000,
      outputMicroUsdPerMTok: 4_400_000,
      cachedInputMicroUsdPerMTok: 260_000,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/nvidia/nemotron-3-120b-a12b",
    upstream: "@cf/nvidia/nemotron-3-120b-a12b",
    displayName: "Nemotron 3 120B (NVIDIA, agentic)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 500_000,
      outputMicroUsdPerMTok: 1_500_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/aisingapore/gemma-sea-lion-v4-27b-it",
    upstream: "@cf/aisingapore/gemma-sea-lion-v4-27b-it",
    displayName: "SEA-LION v4 27B (SE Asian langs)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 351_000,
      outputMicroUsdPerMTok: 555_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "google/gemini-3.1-pro",
    upstream: "google/gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro (Google)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 2000000,
      outputMicroUsdPerMTok: 12000000,
      cachedInputMicroUsdPerMTok: 200000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "google/gemini-3.5-flash",
    upstream: "google/gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash (Google)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 1500000,
      outputMicroUsdPerMTok: 9000000,
      cachedInputMicroUsdPerMTok: 150000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "google/gemini-3.6-flash",
    upstream: "google/gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash (Google)",
    modality: "chat",
    billing: "unified-billing",
    tier: "premium",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 1500000,
      outputMicroUsdPerMTok: 7500000,
      cachedInputMicroUsdPerMTok: 150000,
      pricedAt: PRICED_AT_UB,
    },
    publishedRates: [],
  },
  {
    id: "@cf/ibm-granite/granite-4.0-h-micro",
    upstream: "@cf/ibm-granite/granite-4.0-h-micro",
    displayName: "Granite 4.0 Micro (IBM)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 17_000,
      outputMicroUsdPerMTok: 112_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },
  {
    id: "@cf/llava-hf/llava-1.5-7b-hf",
    upstream: "@cf/llava-hf/llava-1.5-7b-hf",
    displayName: "LLaVA 1.5 7B (image Q&A, single-shot)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "@cf/meta/llama-3.2-1b-instruct",
    upstream: "@cf/meta/llama-3.2-1b-instruct",
    displayName: "Llama 3.2 1B (tiny, cheap)",
    modality: "chat",
    billing: "workers-ai",
    tier: "standard",
    streaming: true,
    maxOutputTokens: null,
    price: {
      inputMicroUsdPerMTok: 27_000,
      outputMicroUsdPerMTok: 201_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT,
    },
    publishedRates: [],
  },

  // ---- image ----
  {
    id: "google/nano-banana-pro",
    upstream: "google/nano-banana-pro",
    displayName: "Nano Banana Pro (Google)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "google/nano-banana-2",
    upstream: "google/nano-banana-2",
    displayName: "Nano Banana 2 (Google)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "google/nano-banana-2-lite",
    upstream: "google/nano-banana-2-lite",
    displayName: "Nano Banana 2 Lite (Google)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "google/imagen-4",
    upstream: "google/imagen-4",
    displayName: "Imagen 4 (Google)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "openai/gpt-image-1.5",
    upstream: "openai/gpt-image-1.5",
    displayName: "GPT Image 1.5 (OpenAI)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "openai/gpt-image-2",
    upstream: "openai/gpt-image-2",
    displayName: "GPT Image 2 (OpenAI)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "recraft/recraftv4",
    upstream: "recraft/recraftv4",
    displayName: "Recraft V4 (art-directed, opaque)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "recraft/recraftv4-1",
    upstream: "recraft/recraftv4-1",
    displayName: "Recraft V4.1 (art-directed, opaque)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "recraft/recraftv4-1-pro",
    upstream: "recraft/recraftv4-1-pro",
    displayName: "Recraft V4.1 Pro (art-directed, opaque)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "xai/grok-imagine-image",
    upstream: "xai/grok-imagine-image",
    displayName: "Grok Imagine Image (xAI)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "xai/grok-imagine-image-quality",
    upstream: "xai/grok-imagine-image-quality",
    displayName: "Grok Imagine Image Quality (xAI)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "bytedance/seedream-5-pro",
    upstream: "bytedance/seedream-5-pro",
    displayName: "Seedream 5 Pro (ByteDance)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "bytedance/seedream-5-lite",
    upstream: "bytedance/seedream-5-lite",
    displayName: "Seedream 5 Lite (ByteDance)",
    modality: "image",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "@cf/black-forest-labs/flux-2-klein-9b",
    upstream: "@cf/black-forest-labs/flux-2-klein-9b",
    displayName: "FLUX 2 Klein 9B (frontier)",
    modality: "image",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    upstream: "@cf/black-forest-labs/flux-2-klein-4b",
    displayName: "FLUX 2 Klein 4B (faster)",
    modality: "image",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "@cf/black-forest-labs/flux-2-dev",
    upstream: "@cf/black-forest-labs/flux-2-dev",
    displayName: "FLUX 2 Dev (multi-reference)",
    modality: "image",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "@cf/black-forest-labs/flux-1-schnell",
    upstream: "@cf/black-forest-labs/flux-1-schnell",
    displayName: "FLUX-1 schnell (fast)",
    modality: "image",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [{ unit: "per 512 by 512 tile", usdPerUnit: 5.28e-05 }, { unit: "per step", usdPerUnit: 0.000106 }],
  },
  {
    id: "@cf/leonardo/lucid-origin",
    upstream: "@cf/leonardo/lucid-origin",
    displayName: "Lucid Origin (Leonardo)",
    modality: "image",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [{ unit: "per 512 by 512 tile", usdPerUnit: 0.007 }, { unit: "per step", usdPerUnit: 0.000132 }],
  },
  {
    id: "@cf/leonardo/phoenix-1.0",
    upstream: "@cf/leonardo/phoenix-1.0",
    displayName: "Phoenix 1.0 (Leonardo)",
    modality: "image",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [{ unit: "per 512 by 512 tile", usdPerUnit: 0.00583 }, { unit: "per step", usdPerUnit: 0.00011 }],
  },
  {
    id: "@cf/lykon/dreamshaper-8-lcm",
    upstream: "@cf/lykon/dreamshaper-8-lcm",
    displayName: "Dreamshaper 8 LCM (fast SD)",
    modality: "image",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    upstream: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    displayName: "Stable Diffusion XL (SDXL)",
    modality: "image",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [{ unit: "per step", usdPerUnit: 0 }],
  },

  // ---- video ----
  {
    id: "google/veo-3.1",
    upstream: "google/veo-3.1",
    displayName: "Veo 3.1 (Google)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "google/veo-3.1-fast",
    upstream: "google/veo-3.1-fast",
    displayName: "Veo 3.1 Fast (Google)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "bytedance/seedance-2.0",
    upstream: "bytedance/seedance-2.0",
    displayName: "Seedance 2.0 (ByteDance)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "bytedance/seedance-2.0-fast",
    upstream: "bytedance/seedance-2.0-fast",
    displayName: "Seedance 2.0 Fast (ByteDance)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "bytedance/seedance-2.0-mini",
    upstream: "bytedance/seedance-2.0-mini",
    displayName: "Seedance 2.0 Mini (ByteDance)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "minimax/hailuo-2.3",
    upstream: "minimax/hailuo-2.3",
    displayName: "Hailuo 2.3 (MiniMax)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "minimax/hailuo-2.3-fast",
    upstream: "minimax/hailuo-2.3-fast",
    displayName: "Hailuo 2.3 Fast (MiniMax)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "xai/grok-imagine-video",
    upstream: "xai/grok-imagine-video",
    displayName: "Grok Imagine Video (xAI)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "xai/grok-imagine-video-1.5-preview",
    upstream: "xai/grok-imagine-video-1.5-preview",
    displayName: "Grok Imagine Video 1.5 (xAI, preview)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "runwayml/gen-4.5",
    upstream: "runwayml/gen-4.5",
    displayName: "Gen-4.5 (RunwayML)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "alibaba/hh1-t2v",
    upstream: "alibaba/hh1-t2v",
    displayName: "HappyHorse 1.0 T2V (Alibaba)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "alibaba/hh1-i2v",
    upstream: "alibaba/hh1-i2v",
    displayName: "HappyHorse 1.0 I2V (Alibaba, image-to-video)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "alibaba/hh1.1-t2v",
    upstream: "alibaba/hh1.1-t2v",
    displayName: "HappyHorse 1.1 T2V (Alibaba)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "alibaba/hh1.1-i2v",
    upstream: "alibaba/hh1.1-i2v",
    displayName: "HappyHorse 1.1 I2V (Alibaba, image-to-video)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "alibaba/wan-2.7-i2v",
    upstream: "alibaba/wan-2.7-i2v",
    displayName: "Wan 2.7 I2V (Alibaba, image-to-video)",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "pixverse/v6",
    upstream: "pixverse/v6",
    displayName: "PixVerse v6",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "pixverse/v5.6",
    upstream: "pixverse/v5.6",
    displayName: "PixVerse v5.6",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "vidu/q3-pro",
    upstream: "vidu/q3-pro",
    displayName: "Vidu Q3 Pro",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "vidu/q3-turbo",
    upstream: "vidu/q3-turbo",
    displayName: "Vidu Q3 Turbo",
    modality: "video",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },

  // ---- tts ----
  {
    id: "@cf/deepgram/aura-2-en",
    upstream: "@cf/deepgram/aura-2-en",
    displayName: "Aura-2 English (Deepgram)",
    modality: "tts",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [{ unit: "per 1k characters", usdPerUnit: 0.03 }],
  },
  {
    id: "@cf/deepgram/aura-2-es",
    upstream: "@cf/deepgram/aura-2-es",
    displayName: "Aura-2 Spanish (Deepgram)",
    modality: "tts",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [{ unit: "per 1k characters", usdPerUnit: 0.03 }],
  },
  {
    id: "@cf/myshell-ai/melotts",
    upstream: "@cf/myshell-ai/melotts",
    displayName: "MeloTTS (multilingual)",
    modality: "tts",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [{ unit: "per audio minute", usdPerUnit: 0.000205 }],
  },

  // ---- stt ----
  {
    id: "@cf/openai/whisper-large-v3-turbo",
    upstream: "@cf/openai/whisper-large-v3-turbo",
    displayName: "Whisper Large v3 Turbo (best)",
    modality: "stt",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [{ unit: "per audio minute", usdPerUnit: 0.000513 }],
  },
  {
    id: "@cf/openai/whisper",
    upstream: "@cf/openai/whisper",
    displayName: "Whisper (general purpose)",
    modality: "stt",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [{ unit: "per audio minute", usdPerUnit: 0.000453 }],
  },
  {
    id: "@cf/openai/whisper-tiny-en",
    upstream: "@cf/openai/whisper-tiny-en",
    displayName: "Whisper Tiny EN (fast, beta)",
    modality: "stt",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },
  {
    id: "@cf/deepgram/nova-3",
    upstream: "@cf/deepgram/nova-3",
    displayName: "Deepgram Nova-3 (accurate)",
    modality: "stt",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [{ unit: "per audio minute", usdPerUnit: 0.0052 }, { unit: "per audio minute (websocket)", usdPerUnit: 0.0092 }],
  },

  // ---- voice ----
  {
    id: "@cf/deepgram/flux",
    upstream: "@cf/deepgram/flux",
    displayName: "Deepgram Flux (live mic)",
    modality: "voice",
    billing: "workers-ai",
    tier: "standard",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [{ unit: "per audio minute (websocket)", usdPerUnit: 0.0077 }],
  },

  // ---- music ----
  {
    id: "minimax/music-2.6",
    upstream: "minimax/music-2.6",
    displayName: "MiniMax Music 2.6",
    modality: "music",
    billing: "unified-billing",
    tier: "premium",
    streaming: false,
    maxOutputTokens: null,
    price: null,
    publishedRates: [],
  },];

const BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));

/** Look up a public model id. Returns undefined for anything not in the allowlist. */
export function findModel(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

/** The subset a tier list entitles, in catalog order. */
export function modelsForTiers(tiers: readonly ModelTier[]): CatalogEntry[] {
  const allowed = new Set(tiers);
  return CATALOG.filter((entry) => allowed.has(entry.tier));
}

/**
 * Whether this plane will actually run this model right now.
 *
 * TWO CONDITIONS, AND BOTH ARE ABOUT METERING RATHER THAN CAPABILITY. A non-chat modality has no door here
 * because its published rates are per tile, per step and per audio minute and no meter for those units
 * exists; an unpriced model has no rate to charge. In both cases the model is real and may well be entitled,
 * and serving it anyway would mean spending money this plane cannot put a number on.
 *
 * Exported so that GET /v1/models, the inference route's refusal, and the readiness check all answer this
 * question with the same code. Three copies of this predicate would eventually disagree, and the way that
 * disagreement surfaces is a client being told a model is spendable and then being refused at the 409.
 */
export function spendable(entry: CatalogEntry, priceOverride: TokenPrice | null): boolean {
  return entry.modality === "chat" && (priceOverride ?? entry.price) !== null;
}

/**
 * The client-facing projection. One place, so GET /v1/models and the contract cannot drift.
 *
 * `spendable` is computed, not stored, and it is the field a client should branch on. A model can be
 * listed, entitled, and still refused because it has no rate; publishing that as its own boolean means
 * a picker can grey the entry out instead of discovering it at the 409.
 *
 * THE OVERRIDE WINS AND IS LABELLED. `price.source` says whether the rate came from Cloudflare's published
 * card or from an operator's own number, because those two carry very different warranties: one is the
 * vendor's, the other is ours. Publishing an operator rate as though Cloudflare set it would misrepresent
 * where the figure came from on the one surface a client uses to decide what a request will cost.
 */
export function publicModel(entry: CatalogEntry, priceOverride?: TokenPrice | null): Record<string, unknown> {
  const override = priceOverride ?? null;
  const price = override ?? entry.price;
  return {
    id: entry.id,
    display_name: entry.displayName,
    modality: entry.modality,
    billing: entry.billing,
    tier: entry.tier,
    streaming: entry.streaming,
    max_output_tokens: entry.maxOutputTokens,
    spendable: spendable(entry, override),
    price:
      price === null
        ? null
        : {
            input_micro_usd_per_mtok: price.inputMicroUsdPerMTok,
            output_micro_usd_per_mtok: price.outputMicroUsdPerMTok,
            priced_at: price.pricedAt,
            source: override ? "operator" : "cloudflare",
          },
    published_rates: entry.publishedRates.map((rate) => ({
      unit: rate.unit,
      usd_per_unit: rate.usdPerUnit,
    })),
  };
}
