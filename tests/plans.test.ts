import { describe, expect, it } from "vitest";
import { effectiveMaxTokens, entitlesTier, parseTiers, planFromRow } from "../src/plans";
import { testPlan } from "./fake-store";

describe("parseTiers", () => {
  it("parses a list and normalizes case and whitespace", () => {
    expect(parseTiers("standard, PREMIUM ")).toEqual(["standard", "premium"]);
  });

  it("drops unrecognized tier names", () => {
    // A typo must not become an entitlement. Dropping keeps the parsed shape closed over the catalog's
    // tier set, so the entitlement check has no unknown members to reason about.
    expect(parseTiers("standard,standrd,gold")).toEqual(["standard"]);
  });

  it("parses an empty list to no entitlement, which entitles no model", () => {
    expect(parseTiers("")).toEqual([]);
  });
});

describe("planFromRow", () => {
  it("accepts a well-formed row", () => {
    const result = planFromRow(testPlan());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.signupCreditMicroUsd).toBe(1_000_000);
      expect(result.plan.allowedTiers).toEqual(["standard"]);
    }
  });

  it("accepts an explicit zero signup credit", () => {
    // Zero is a decision (an account that must be topped up before it can do anything). Only a MALFORMED
    // value is refused, and this asserts the two are not conflated.
    expect(planFromRow(testPlan({ signup_credit_micro_usd: 0 })).ok).toBe(true);
  });

  it("refuses a malformed signup credit rather than coercing it", () => {
    expect(planFromRow(testPlan({ signup_credit_micro_usd: -1 }))).toMatchObject({ ok: false });
    expect(planFromRow(testPlan({ signup_credit_micro_usd: 1.5 }))).toMatchObject({ ok: false });
  });

  it("refuses a non-positive rate limit or output ceiling", () => {
    expect(planFromRow(testPlan({ requests_per_minute: 0 }))).toMatchObject({ ok: false });
    // max_output_tokens is what BOUNDS the single-request prepaid overshoot, so a bad value there quietly
    // invalidates the contract's honest statement about how far an account can exceed its credit.
    expect(planFromRow(testPlan({ max_output_tokens: 0 }))).toMatchObject({ ok: false });
  });
});

describe("entitlesTier", () => {
  it("gates on the parsed tier list", () => {
    const plan = planFromRow(testPlan({ allowed_tiers: "standard" }));
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(entitlesTier(plan.plan, "standard")).toBe(true);
      expect(entitlesTier(plan.plan, "premium")).toBe(false);
    }
  });
});

describe("effectiveMaxTokens", () => {
  it("clamps down to the smaller of plan and model ceilings", () => {
    expect(effectiveMaxTokens(100_000, 1024, 4096)).toBe(1024);
    expect(effectiveMaxTokens(100_000, 8192, 4096)).toBe(4096);
  });

  it("passes a smaller request through unchanged", () => {
    expect(effectiveMaxTokens(200, 1024, 4096)).toBe(200);
  });

  it("uses the ceiling when the client asks for nothing", () => {
    expect(effectiveMaxTokens(undefined, 1024, 4096)).toBe(1024);
  });

  it("never resolves below 1", () => {
    // A zero or negative cap would forward "generate nothing" to the model and bill for the prompt.
    expect(effectiveMaxTokens(0, 1024, 4096)).toBe(1);
    expect(effectiveMaxTokens(-5, 1024, 4096)).toBe(1);
  });
});
