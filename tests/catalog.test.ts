import { describe, expect, it } from "vitest";
import { CATALOG, findModel, modelsForTiers, publicModel } from "../src/catalog";

describe("CATALOG", () => {
  it("has no duplicate ids", () => {
    expect(new Set(CATALOG.map((entry) => entry.id)).size).toBe(CATALOG.length);
  });

  it("prices every entry", () => {
    // The reason allowlist and price list are ONE table: an unpriced entry would be a spendable model
    // with an unmeterable bill. This is the assertion that keeps that unrepresentable in practice as well
    // as in the type.
    for (const entry of CATALOG) {
      expect(Number.isInteger(entry.price.inputMicroUsdPerMTok)).toBe(true);
      expect(Number.isInteger(entry.price.outputMicroUsdPerMTok)).toBe(true);
      expect(entry.price.inputMicroUsdPerMTok).toBeGreaterThan(0);
      expect(entry.price.outputMicroUsdPerMTok).toBeGreaterThan(0);
      expect(entry.price.pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("bounds every entry with a positive context window and output ceiling", () => {
    for (const entry of CATALOG) {
      expect(entry.contextWindow).toBeGreaterThan(0);
      expect(entry.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it("routes only to Workers AI models", () => {
    // Workers-AI-only is a SPEND decision (Workers AI pricing rather than Unified Billing credits), so a
    // third-party model appearing here should fail a test rather than merely surprise a reviewer.
    for (const entry of CATALOG) expect(entry.upstream.startsWith("@cf/")).toBe(true);
  });
});

describe("findModel", () => {
  it("finds a catalog entry and refuses anything else", () => {
    expect(findModel("@cf/meta/llama-3.2-3b-instruct")?.tier).toBe("standard");
    expect(findModel("openai/gpt-4.1-mini")).toBeUndefined();
    expect(findModel("")).toBeUndefined();
  });
});

describe("modelsForTiers", () => {
  it("filters to the entitled tiers", () => {
    expect(modelsForTiers(["standard"]).every((entry) => entry.tier === "standard")).toBe(true);
    expect(modelsForTiers([])).toEqual([]);
  });
});

describe("publicModel", () => {
  it("projects exactly the contract's model fields", () => {
    expect(Object.keys(publicModel(CATALOG[0])).sort()).toEqual([
      "context_window",
      "display_name",
      "id",
      "max_output_tokens",
      "price",
      "streaming",
      "tier",
    ]);
  });

  it("publishes priced_at so a stale rate is visibly stale", () => {
    const projected = publicModel(CATALOG[0]).price as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual([
      "input_micro_usd_per_mtok",
      "output_micro_usd_per_mtok",
      "priced_at",
    ]);
  });
});
