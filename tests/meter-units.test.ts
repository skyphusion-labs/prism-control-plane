import { describe, expect, it } from "vitest";
import { priceUnits, resolveUnitPrice } from "../src/meter";
import { findModel } from "../src/catalog";

describe("priceUnits", () => {
  it("charges N times the unit rate", () => {
    expect(
      priceUnits(3, { microUsdPerUnit: 100, unit: "request", pricedAt: "2026-08-05" }),
    ).toEqual({ microUsd: 300, units: 3 });
  });

  it("allows a measured free rate", () => {
    expect(
      priceUnits(1, { microUsdPerUnit: 0, unit: "request", pricedAt: "2026-08-05" }),
    ).toEqual({ microUsd: 0, units: 1 });
  });
});

describe("resolveUnitPrice", () => {
  it("uses catalog unit price for FLUX-1 schnell", () => {
    const entry = findModel("@cf/black-forest-labs/flux-1-schnell");
    expect(entry).toBeDefined();
    const price = resolveUnitPrice(entry!, null);
    expect(price?.unit).toBe("request");
    expect(price!.microUsdPerUnit).toBeGreaterThan(0);
  });

  it("lets an operator unit override win", () => {
    const entry = findModel("@cf/black-forest-labs/flux-1-schnell")!;
    const price = resolveUnitPrice(entry, {
      model_id: entry.id,
      input_micro_usd_per_mtok: 0,
      output_micro_usd_per_mtok: 0,
      unit_micro_usd: 999,
      priced_at: "2026-08-05",
      note: null,
    });
    expect(price).toMatchObject({ microUsdPerUnit: 999, unit: "request" });
  });
});
