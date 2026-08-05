// The catalog's job is to be the single table that decides what is reachable AND what it costs. These tests
// exist to keep the two halves from drifting apart, because the failure mode of drift is a spendable model
// with no rate -- inference this plane cannot bill for.

import { describe, expect, it } from "vitest";
import { CATALOG, findModel, modelsForTiers, publicModel, spendable } from "../src/catalog";

describe("CATALOG", () => {
  it("has no duplicate ids", () => {
    expect(new Set(CATALOG.map((entry) => entry.id)).size).toBe(CATALOG.length);
  });

  it("carries a well-formed rate wherever it carries a rate at all", () => {
    // NOT "prices every entry", which is what an earlier version of this test asserted and what the catalog
    // can no longer honestly promise: Cloudflare publishes no per-token rate for the third-party Unified
    // Billing models, so those entries are deliberately `price: null` and closed. What must hold is that a
    // rate, WHERE PRESENT, is a usable integer -- a malformed one would meter silently wrong, which is worse
    // than not metering at all.
    for (const entry of CATALOG) {
      if (!entry.price) continue;
      expect(Number.isInteger(entry.price.inputMicroUsdPerMTok)).toBe(true);
      expect(Number.isInteger(entry.price.outputMicroUsdPerMTok)).toBe(true);
      expect(entry.price.inputMicroUsdPerMTok).toBeGreaterThanOrEqual(0);
      expect(entry.price.outputMicroUsdPerMTok).toBeGreaterThanOrEqual(0);
      expect(entry.price.pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("closes the door on every unpriced entry", () => {
    // THE LOAD-BEARING INVARIANT. Chat needs a token rate; non-chat needs a unit rate (and a door).
    // Voice never has a door. If this ever inverts, the plane serves inference it cannot price.
    for (const entry of CATALOG) {
      if (entry.modality === "chat") {
        if (entry.price) continue;
        expect(spendable(entry, null, null)).toBe(false);
      } else {
        if (entry.unitPrice) continue;
        expect(spendable(entry, null, null)).toBe(false);
      }
    }
  });

  it("bounds an output ceiling wherever it claims one", () => {
    // `null` means "no vendor ceiling this repo can cite", which is honest; a zero or negative one would be a
    // transcription bug that clamps every request to nothing.
    for (const entry of CATALOG) {
      if (entry.maxOutputTokens === null) continue;
      expect(entry.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it("agrees with itself about which billing lane an entry is on", () => {
    // `@cf/` models bill at Workers AI rates; everything else bills through Unified Billing. The two facts
    // are stored separately (upstream id, billing lane) and a disagreement would send a model to be priced
    // against the wrong rate card.
    for (const entry of CATALOG) {
      const expected = entry.upstream.startsWith("@cf/") ? "workers-ai" : "unified-billing";
      expect(entry.billing).toBe(expected);
    }
  });
});

describe("findModel", () => {
  it("finds a catalog entry and refuses anything else", () => {
    expect(findModel("@cf/meta/llama-3.2-3b-instruct")?.modality).toBe("chat");
    expect(findModel("no/such-model")).toBeUndefined();
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
    expect(Object.keys(publicModel(CATALOG[0], null)).sort()).toEqual([
      "billing",
      "display_name",
      "id",
      "max_output_tokens",
      "modality",
      "price",
      "published_rates",
      "spendable",
      "streaming",
      "tier",
      "unit_price",
    ]);
  });

  it("publishes priced_at so a stale rate is visibly stale", () => {
    const priced = CATALOG.find((entry) => entry.price !== null);
    expect(priced).toBeDefined();
    const projected = publicModel(priced!, null).price as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual([
      "input_micro_usd_per_mtok",
      "output_micro_usd_per_mtok",
      "priced_at",
      "source",
    ]);
  });

  it("reports an operator override as the price, and as spendable", () => {
    // The client must be told the rate that will ACTUALLY be charged. An override must win over the catalog.
    const entry = CATALOG.find((e) => e.modality === "chat" && e.price !== null);
    expect(entry).toBeDefined();
    const projected = publicModel(entry!, {
      inputMicroUsdPerMTok: 500_000,
      outputMicroUsdPerMTok: 1_500_000,
      cachedInputMicroUsdPerMTok: null,
      pricedAt: "2026-08-04",
    });
    expect(projected.spendable).toBe(true);
    expect(projected.price).toMatchObject({
      input_micro_usd_per_mtok: 500_000,
      output_micro_usd_per_mtok: 1_500_000,
      source: "operator",
    });
  });
});
