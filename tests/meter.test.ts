import { describe, expect, it } from "vitest";
import { extractUsage, meterResponse, priceUsage } from "../src/meter";
import type { TokenPrice } from "../src/catalog";

const PRICE: TokenPrice = {
  inputMicroUsdPerMTok: 100_000,
  outputMicroUsdPerMTok: 300_000,
  cachedInputMicroUsdPerMTok: null,
  pricedAt: "2026-08-04",
};

describe("extractUsage", () => {
  it("reads the Workers AI shape", () => {
    // The shape @cf/meta/llama-3.2-3b-instruct answers with.
    expect(
      extractUsage({ response: "hi", usage: { prompt_tokens: 31, completion_tokens: 24 } }),
    ).toEqual({ inputTokens: 31, outputTokens: 24 });
  });

  it("reads the OpenAI shape", () => {
    // The shape @cf/zai-org/glm-4.7-flash and @cf/google/gemma-4-26b-a4b-it answer with. ONE reader
    // covers both, which is the reason detection beats a per-model flag in the catalog.
    expect(
      extractUsage({
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      }),
    ).toEqual({ inputTokens: 5, outputTokens: 7 });
  });

  it("accepts input_tokens / output_tokens spelling", () => {
    expect(extractUsage({ usage: { input_tokens: 2, output_tokens: 3 } })).toEqual({
      inputTokens: 2,
      outputTokens: 3,
    });
  });

  it("returns null rather than zero when a count is missing", () => {
    // The whole doctrine in one assertion: absent is a claim about OUR knowledge, zero is a claim about
    // the request. Reading absent as zero is what turns a meter gap into a silent free ride.
    expect(extractUsage({ usage: { prompt_tokens: 10 } })).toBeNull();
    expect(extractUsage({ usage: {} })).toBeNull();
    expect(extractUsage({})).toBeNull();
    expect(extractUsage(null)).toBeNull();
    expect(extractUsage("nope")).toBeNull();
  });

  it("rejects non-integer and negative counts", () => {
    expect(extractUsage({ usage: { prompt_tokens: 1.5, completion_tokens: 2 } })).toBeNull();
    expect(extractUsage({ usage: { prompt_tokens: -1, completion_tokens: 2 } })).toBeNull();
    expect(extractUsage({ usage: { prompt_tokens: "3", completion_tokens: 2 } })).toBeNull();
  });

  it("folds separate reasoning_tokens into output when completion under-reports", () => {
    // Issue #10: grok-style responses with completion_tokens: 1 and reasoning_tokens: 113.
    expect(
      extractUsage({
        usage: { prompt_tokens: 10, completion_tokens: 1, reasoning_tokens: 113 },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 114 });
    // Already-included: do not double-count.
    expect(
      extractUsage({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 114,
          completion_tokens_details: { reasoning_tokens: 113 },
        },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 114 });
  });
});

describe("priceUsage", () => {
  it("prices from the injected rate", () => {
    // 1,000,000 in at 100,000/Mtok = 100,000; 1,000,000 out at 300,000/Mtok = 300,000.
    expect(priceUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, PRICE)).toEqual({
      outcome: "metered",
      microUsd: 400_000,
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
  });

  it("never records a request that consumed tokens as free", () => {
    // 1 input token at 100,000 micro-USD per million is 0.1 micro-USD. Rounding to nearest would store 0,
    // and a zero-cost metered row is indistinguishable from an unmetered one when the column is summed.
    const result = priceUsage({ inputTokens: 1, outputTokens: 0 }, PRICE);
    expect(result).toEqual({
      outcome: "metered",
      microUsd: 1,
      usage: { inputTokens: 1, outputTokens: 0 },
    });
  });

  it("prices a genuinely empty request as zero", () => {
    // Zero tokens is a real observation of nothing consumed, so it is 0 rather than the 1 micro-USD floor.
    expect(priceUsage({ inputTokens: 0, outputTokens: 0 }, PRICE)).toMatchObject({
      outcome: "metered",
      microUsd: 0,
    });
  });

  it("rounds up on the total, not per component", () => {
    // Per-component ceil would give 1 + 1 = 2. On the total: 0.1 + 0.3 = 0.4 -> 1.
    expect(priceUsage({ inputTokens: 1, outputTokens: 1 }, PRICE)).toMatchObject({ microUsd: 1 });
  });

  it("refuses a malformed rate instead of guessing one", () => {
    expect(
      priceUsage({ inputTokens: 10, outputTokens: 10 }, { ...PRICE, inputMicroUsdPerMTok: -1 }),
    ).toMatchObject({ outcome: "unmetered" });
    expect(
      priceUsage({ inputTokens: 10, outputTokens: 10 }, { ...PRICE, outputMicroUsdPerMTok: 1.5 }),
    ).toMatchObject({ outcome: "unmetered" });
  });
});

describe("meterResponse", () => {
  it("meters a usable response", () => {
    expect(
      meterResponse({ usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }, PRICE),
    ).toMatchObject({ outcome: "metered", microUsd: 100_000 });
  });

  it("reports unmetered with a reason when usage is unusable", () => {
    const result = meterResponse({ response: "hi" }, PRICE);
    expect(result.outcome).toBe("unmetered");
    if (result.outcome === "unmetered") {
      expect(result.reason).toContain("no usable token counts");
    }
  });
});

describe("extractUsage Gemini usageMetadata", () => {
  it("reads promptTokenCount / candidatesTokenCount", () => {
    expect(
      extractUsage({
        candidates: [{ content: { parts: [{ text: "hi" }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      }),
    ).toEqual({ inputTokens: 3, outputTokens: 2 });
  });
});
