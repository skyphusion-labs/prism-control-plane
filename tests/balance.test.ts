import { describe, expect, it } from "vitest";
import {
  allocateCharge,
  decideBalance,
  remainingAllowanceMicroUsd,
  remainingMicroUsd,
} from "../src/balance";

const purePrepaid = {
  creditMicroUsd: 1000,
  spentMicroUsd: 0,
  monthlyIncludedMicroUsd: 0,
  allowanceSpentMicroUsd: 0,
};

describe("decideBalance", () => {
  it("allows while there is any credit left (pure prepaid)", () => {
    expect(decideBalance(purePrepaid)).toEqual({
      outcome: "allow",
      remainingMicroUsd: 1000,
      remainingAllowanceMicroUsd: 0,
      remainingCreditMicroUsd: 1000,
    });
    expect(
      decideBalance({ ...purePrepaid, spentMicroUsd: 999 }),
    ).toMatchObject({ outcome: "allow", remainingCreditMicroUsd: 1 });
  });

  it("exhausts at exactly the credit when allowance is zero", () => {
    expect(decideBalance({ ...purePrepaid, spentMicroUsd: 1000 })).toMatchObject({
      outcome: "exhausted",
    });
  });

  it("allows on remaining allowance even when credit is spent", () => {
    expect(
      decideBalance({
        creditMicroUsd: 100,
        spentMicroUsd: 100,
        monthlyIncludedMicroUsd: 500,
        allowanceSpentMicroUsd: 0,
      }),
    ).toMatchObject({
      outcome: "allow",
      remainingAllowanceMicroUsd: 500,
      remainingCreditMicroUsd: 0,
      remainingMicroUsd: 500,
    });
  });

  it("exhausts only when both pools are gone", () => {
    expect(
      decideBalance({
        creditMicroUsd: 100,
        spentMicroUsd: 150,
        monthlyIncludedMicroUsd: 500,
        allowanceSpentMicroUsd: 500,
      }),
    ).toMatchObject({ outcome: "exhausted" });
  });

  it("stays exhausted after credit overshoot rather than calling it corruption", () => {
    expect(decideBalance({ ...purePrepaid, spentMicroUsd: 1500 })).toMatchObject({
      outcome: "exhausted",
      creditMicroUsd: 1000,
      spentMicroUsd: 1500,
    });
  });

  it("treats zero credit and zero allowance as exhausted", () => {
    expect(
      decideBalance({
        creditMicroUsd: 0,
        spentMicroUsd: 0,
        monthlyIncludedMicroUsd: 0,
        allowanceSpentMicroUsd: 0,
      }),
    ).toMatchObject({ outcome: "exhausted" });
  });

  it("separates 'we could not tell' from 'nothing is left'", () => {
    expect(decideBalance({ ...purePrepaid, spentMicroUsd: -5 })).toMatchObject({
      outcome: "indeterminate",
    });
    expect(decideBalance({ ...purePrepaid, spentMicroUsd: 1.5 })).toMatchObject({
      outcome: "indeterminate",
    });
    expect(decideBalance({ ...purePrepaid, monthlyIncludedMicroUsd: -1 })).toMatchObject({
      outcome: "indeterminate",
    });
  });
});

describe("allocateCharge", () => {
  it("takes allowance first, then credit", () => {
    expect(
      allocateCharge(300, { monthlyIncludedMicroUsd: 200, allowanceSpentMicroUsd: 0 }),
    ).toEqual({ fromAllowanceMicroUsd: 200, fromCreditMicroUsd: 100 });
  });

  it("is pure credit when allowance is zero or exhausted", () => {
    expect(
      allocateCharge(50, { monthlyIncludedMicroUsd: 0, allowanceSpentMicroUsd: 0 }),
    ).toEqual({ fromAllowanceMicroUsd: 0, fromCreditMicroUsd: 50 });
    expect(
      allocateCharge(50, { monthlyIncludedMicroUsd: 100, allowanceSpentMicroUsd: 100 }),
    ).toEqual({ fromAllowanceMicroUsd: 0, fromCreditMicroUsd: 50 });
  });

  it("is pure allowance when the charge fits", () => {
    expect(
      allocateCharge(40, { monthlyIncludedMicroUsd: 100, allowanceSpentMicroUsd: 10 }),
    ).toEqual({ fromAllowanceMicroUsd: 40, fromCreditMicroUsd: 0 });
  });
});

describe("remainingMicroUsd / remainingAllowanceMicroUsd", () => {
  it("clamps at zero so an overshot account never reports a negative balance", () => {
    expect(remainingMicroUsd({ creditMicroUsd: 1000, spentMicroUsd: 1500 })).toBe(0);
    expect(remainingMicroUsd({ creditMicroUsd: 1000, spentMicroUsd: 250 })).toBe(750);
    expect(
      remainingAllowanceMicroUsd({ monthlyIncludedMicroUsd: 100, allowanceSpentMicroUsd: 150 }),
    ).toBe(0);
  });
});
