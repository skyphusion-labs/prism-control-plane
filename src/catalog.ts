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
// filled from CF `compat/models` + live billing verification (issue #10, 2026-08-05). Rates move
// intraday; operator overrides + POST /admin/reconcile true them up. All 45 chat models are priced.
// LLaVA is image-to-text (native wire, not chat/completions); measured 2026-08-05 gateway cost and
// neurons are $0 / 0 on successful runs, so its catalog rate is zero (still spendable).
//
// `publishedRates` carries the non-token rates CF publishes (per tile, per step, per audio minute).
// Floats in USD, disclosure-shaped. The meter uses integer `unitPrice` (micro-USD per request /
// audio minute / k-characters) derived from those rates for models that have a door.

/** Which door a model belongs to. `voice` is websocket-only and has no HTTP door yet. */
export type Modality = "chat" | "image" | "tts" | "stt" | "voice" | "music" | "video";

/** Modalities with a door on this plane (HTTP or WebSocket). */
export const DOOR_MODALITIES: ReadonlySet<Modality> = new Set([
  "chat",
  "image",
  "tts",
  "stt",
  "music",
  "video",
  "voice",
]);

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

/** A published rate whose unit is not tokens. Disclosure in publicModel; money uses UnitPrice. */
export interface UnitRate {
  unit: string;
  /** USD per unit, as published. Float on purpose: see the header. */
  usdPerUnit: number;
}

/** Meterable non-token rate. Integer micro-USD per unit. */
export type MeterUnit = "request" | "audio_minute" | "k_characters";

export interface UnitPrice {
  microUsdPerUnit: number;
  unit: MeterUnit;
  pricedAt: string;
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
  /**
   * Id sent on the HTTP gateway path (`/compat` or `/workers-ai`).
   *
   * May differ from `id` when Cloudflare's compat provider prefix is not the public id prefix
   * (measured 2026-08-05: public `xai/grok-*` must hit compat as `grok/grok-*` or the gateway
   * answers 400 `Invalid provider`).
   */
  upstream: string;
  /**
   * When true, chat dispatches via `env.AI.run(id, …, { gateway })` instead of HTTP `/compat`.
   *
   * Needed for models CF's legacy gateway allowlist does not inject Unified Billing credentials
   * for (measured: `anthropic/claude-fable-5` → provider 401; `xai/grok-4.5` → no credentials on
   * `grok/grok-4.5`). Prism already flags these `binding: true` for the same reason. Public `id`
   * is what the binding catalog expects.
   */
  binding?: boolean;
  /**
   * OpenAI wire surface for unified-billing HTTP dispatch.
   * - `chat` (default): `/compat/chat/completions` with messages
   * - `responses`: provider-native `/openai/v1/responses` (gpt-5.5-pro; chat completions returns 404)
   */
  api?: "chat" | "responses";
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
  /** Token meter rate for chat, or null. */
  price: TokenPrice | null;
  /**
   * Unit meter rate for non-chat doors (image/tts/stt/video/music), or null.
   * Null closes the non-chat door with model_unpriced until an operator sets a rate.
   * Chat entries leave this null (they use `price`).
   */
  unitPrice: UnitPrice | null;
  /** Non-token published rates. Disclosure; money math uses unitPrice. */
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
    // /compat keyless → Anthropic 401 Invalid API Key; env.AI.run injects UB.
    binding: true,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
    publishedRates: [],
  },
  {
    // Public id stays xai/* (prism catalog). Compat provider is `grok`, not `xai`
    // (xai/* → 400 Invalid provider). Grok 4.5 also needs binding: keyless
    // grok/grok-4.5 answers "No credentials presented".
    id: "xai/grok-4.5",
    upstream: "grok/grok-4.5",
    binding: true,
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
    unitPrice: null,
    publishedRates: [],
  },
  {
    id: "xai/grok-4.3",
    upstream: "grok/grok-4.3",
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
    unitPrice: null,
    publishedRates: [],
  },
  {
    // Multi-agent refuses chat/completions. xAI docs: use Responses API
    // (https://docs.x.ai/developers/model-capabilities/text/multi-agent). Gateway path is
    // /grok/v1/responses with unprefixed model id.
    id: "xai/grok-4.20-multi-agent-0309",
    upstream: "grok/grok-4.20-multi-agent-0309",
    api: "responses",
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
    unitPrice: null,
    publishedRates: [],
  },
  {
    id: "xai/grok-4.20-0309-reasoning",
    upstream: "grok/grok-4.20-0309-reasoning",
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
    publishedRates: [],
  },
  {
    // Chat Completions rejects this id ("not a chat model"); OpenAI Responses via gateway works.
    id: "openai/gpt-5.5-pro",
    upstream: "openai/gpt-5.5-pro",
    api: "responses",
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
    publishedRates: [],
  },
  {
    // Compat provider is google-ai-studio not google (Invalid provider). Several Gemini 3.x
    // ids also fail keyless UB on /compat (Missing Authorization); env.AI.run injects credentials.
    id: "google/gemini-3.1-pro",
    upstream: "google-ai-studio/gemini-3.1-pro-preview",
    binding: true,
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
    unitPrice: null,
    publishedRates: [],
  },
  {
    id: "google/gemini-3.5-flash",
    upstream: "google-ai-studio/gemini-3.5-flash",
    binding: true,
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
    unitPrice: null,
    publishedRates: [],
  },
  {
    id: "google/gemini-3.6-flash",
    upstream: "google-ai-studio/gemini-3.6-flash",
    binding: true,
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
    unitPrice: null,
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
    unitPrice: null,
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
    // Measured 2026-08-05 via REST ai/run + prism-proxy logs: five successful probes
    // (cost=0, tokens_in=0, tokens_out=0, neurons=0). CF publishes no unit price (beta).
    // Zero rate is the honest baseline; the plane still records a metered row.
    price: {
      inputMicroUsdPerMTok: 0,
      outputMicroUsdPerMTok: 0,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: PRICED_AT_UB,
    },
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: { microUsdPerUnit: 0, unit: "request", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 0, unit: "request", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 0, unit: "request", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 477, unit: "request", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 10300, unit: "request", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 8580, unit: "request", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 0, unit: "request", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 1, unit: "request", pricedAt: PRICED_AT },
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: null,
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
    unitPrice: { microUsdPerUnit: 30000, unit: "k_characters", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 30000, unit: "k_characters", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 205, unit: "audio_minute", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 513, unit: "audio_minute", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 453, unit: "audio_minute", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 0, unit: "audio_minute", pricedAt: PRICED_AT },
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
    unitPrice: { microUsdPerUnit: 5200, unit: "audio_minute", pricedAt: PRICED_AT },
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
    // Published $0.0077 per audio minute (websocket). Live door: GET/WS /v1/stt/stream.
    unitPrice: { microUsdPerUnit: 7700, unit: "audio_minute", pricedAt: PRICED_AT },
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
    unitPrice: null,
    publishedRates: [],
  },
];

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
 * THREE CONDITIONS, ALL ABOUT METERING AND DOORS rather than capability:
 *   1. The modality has an HTTP door (voice does not -- live WebSocket).
 *   2. Chat has a token rate (or operator override).
 *   3. Non-chat has a unit rate (or operator unit override).
 *
 * Serving without a rate means host-billed spend this plane cannot put a number on.
 */
export function spendable(
  entry: CatalogEntry,
  tokenOverride: TokenPrice | null,
  unitOverride: UnitPrice | null = null,
): boolean {
  if (!DOOR_MODALITIES.has(entry.modality)) return false;
  if (entry.modality === "chat") {
    return (tokenOverride ?? entry.price) !== null;
  }
  return (unitOverride ?? entry.unitPrice) !== null;
}

/**
 * The client-facing projection. One place, so GET /v1/models and the contract cannot drift.
 *
 * `spendable` is computed, not stored. Token rates land in `price`; unit rates land in `unit_price`.
 * A non-chat model with no unit rate is listed with spendable:false until an operator sets one.
 */
export function publicModel(
  entry: CatalogEntry,
  tokenOverride?: TokenPrice | null,
  unitOverride?: UnitPrice | null,
): Record<string, unknown> {
  const tOverride = tokenOverride ?? null;
  const uOverride = unitOverride ?? null;
  const price = tOverride ?? entry.price;
  const unit = uOverride ?? entry.unitPrice;
  return {
    id: entry.id,
    display_name: entry.displayName,
    modality: entry.modality,
    billing: entry.billing,
    tier: entry.tier,
    streaming: entry.streaming,
    max_output_tokens: entry.maxOutputTokens,
    spendable: spendable(entry, tOverride, uOverride),
    price:
      price === null
        ? null
        : {
            input_micro_usd_per_mtok: price.inputMicroUsdPerMTok,
            output_micro_usd_per_mtok: price.outputMicroUsdPerMTok,
            priced_at: price.pricedAt,
            source: tOverride ? "operator" : "cloudflare",
          },
    unit_price:
      unit === null
        ? null
        : {
            micro_usd_per_unit: unit.microUsdPerUnit,
            unit: unit.unit,
            priced_at: unit.pricedAt,
            source: uOverride ? "operator" : "cloudflare",
          },
    published_rates: entry.publishedRates.map((rate) => ({
      unit: rate.unit,
      usd_per_unit: rate.usdPerUnit,
    })),
  };
}
