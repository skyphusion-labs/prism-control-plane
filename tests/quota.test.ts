import { describe, expect, it } from "vitest";
import { decideAllowance, remainingMicroUsd } from "../src/quota";

describe("decideAllowance", () => {
  it("allows while there is any allowance left", () => {
    expect(decideAllowance({ usedMicroUsd: 0, includedMicroUsd: 1000 })).toEqual({
      outcome: "allow",
      remainingMicroUsd: 1000,
    });
    expect(decideAllowance({ usedMicroUsd: 999, includedMicroUsd: 1000 })).toEqual({
      outcome: "allow",
      remainingMicroUsd: 1,
    });
  });

  it("exhausts at exactly the allowance, not one past it", () => {
    // >= not >. Allowing a request at exactly the allowance would mean every account gets one free
    // request per period beyond what it paid for.
    expect(decideAllowance({ usedMicroUsd: 1000, includedMicroUsd: 1000 })).toMatchObject({
      outcome: "exhausted",
    });
  });

  it("stays exhausted after an overshoot rather than reporting a negative balance", () => {
    expect(decideAllowance({ usedMicroUsd: 1500, includedMicroUsd: 1000 })).toMatchObject({
      outcome: "exhausted",
      usedMicroUsd: 1500,
    });
  });

  it("treats a zero allowance as a real decision that refuses everything", () => {
    // A configured 0 IS a decision. plans.ts is what refuses an UNSET allowance; this layer must not
    // second-guess a chosen zero.
    expect(decideAllowance({ usedMicroUsd: 0, includedMicroUsd: 0 })).toMatchObject({
      outcome: "exhausted",
    });
  });

  it("separates 'we could not tell' from 'nothing is left'", () => {
    // The distinction that matters: exhausted is a fact about the account (402, stop asking);
    // indeterminate is a fact about us (503, our bug). Mapping a broken counter to 402 would tell a
    // paying user their allowance is spent when it may be untouched.
    expect(decideAllowance({ usedMicroUsd: -5, includedMicroUsd: 1000 })).toMatchObject({
      outcome: "indeterminate",
    });
    expect(decideAllowance({ usedMicroUsd: 1.5, includedMicroUsd: 1000 })).toMatchObject({
      outcome: "indeterminate",
    });
    expect(decideAllowance({ usedMicroUsd: 0, includedMicroUsd: -1 })).toMatchObject({
      outcome: "indeterminate",
    });
    expect(
      decideAllowance({ usedMicroUsd: 0, includedMicroUsd: Number.NaN }),
    ).toMatchObject({ outcome: "indeterminate" });
  });
});

describe("remainingMicroUsd", () => {
  it("clamps at zero so an overshot period never reports a negative allowance", () => {
    expect(remainingMicroUsd({ usedMicroUsd: 1500, includedMicroUsd: 1000 })).toBe(0);
    expect(remainingMicroUsd({ usedMicroUsd: 250, includedMicroUsd: 1000 })).toBe(750);
  });
});
