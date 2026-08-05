import { describe, expect, it } from "vitest";
import { decideBalance, remainingMicroUsd } from "../src/balance";

describe("decideBalance", () => {
  it("allows while there is any credit left", () => {
    expect(decideBalance({ creditMicroUsd: 1000, spentMicroUsd: 0 })).toEqual({
      outcome: "allow",
      remainingMicroUsd: 1000,
    });
    expect(decideBalance({ creditMicroUsd: 1000, spentMicroUsd: 999 })).toEqual({
      outcome: "allow",
      remainingMicroUsd: 1,
    });
  });

  it("exhausts at exactly the credit, not one past it", () => {
    // >= not >. Allowing a request at exactly the granted amount would hand every account one free request
    // beyond what it paid for, forever, which on a prepaid plane is the whole business model leaking.
    expect(decideBalance({ creditMicroUsd: 1000, spentMicroUsd: 1000 })).toMatchObject({
      outcome: "exhausted",
    });
  });

  it("stays exhausted after the bounded overshoot rather than calling it corruption", () => {
    // Spend EXCEEDING credit is a normal, expected state: the cost of a request is unknowable until the
    // model answers, so the last allowed request can carry an account negative. It must read as exhausted
    // (402, top up) and not as indeterminate (503, our bug), because the account is fine and the number is
    // real.
    expect(decideBalance({ creditMicroUsd: 1000, spentMicroUsd: 1500 })).toMatchObject({
      outcome: "exhausted",
      creditMicroUsd: 1000,
      spentMicroUsd: 1500,
    });
  });

  it("treats zero credit as a real decision that refuses everything", () => {
    // A granted zero IS a decision (an account created on a plan with no signup credit). This layer must
    // not second-guess it into a free request.
    expect(decideBalance({ creditMicroUsd: 0, spentMicroUsd: 0 })).toMatchObject({
      outcome: "exhausted",
    });
  });

  it("separates 'we could not tell' from 'nothing is left'", () => {
    // The distinction that matters: exhausted is a fact about the account (402, stop asking until top-up);
    // indeterminate is a fact about US (503, our bug). Mapping a corrupt counter to 402 would tell a paying
    // user their credit is spent when it may be untouched -- plausible, user-blaming, and invisible to us.
    expect(decideBalance({ creditMicroUsd: 1000, spentMicroUsd: -5 })).toMatchObject({
      outcome: "indeterminate",
    });
    expect(decideBalance({ creditMicroUsd: 1000, spentMicroUsd: 1.5 })).toMatchObject({
      outcome: "indeterminate",
    });
    expect(decideBalance({ creditMicroUsd: -1, spentMicroUsd: 0 })).toMatchObject({
      outcome: "indeterminate",
    });
    expect(decideBalance({ creditMicroUsd: Number.NaN, spentMicroUsd: 0 })).toMatchObject({
      outcome: "indeterminate",
    });
  });
});

describe("remainingMicroUsd", () => {
  it("clamps at zero so an overshot account never reports a negative balance", () => {
    // A negative here would reach a client as something that looks like a debt. There is no debt on this
    // plane; there is only "you cannot spend until you top up".
    expect(remainingMicroUsd({ creditMicroUsd: 1000, spentMicroUsd: 1500 })).toBe(0);
    expect(remainingMicroUsd({ creditMicroUsd: 1000, spentMicroUsd: 250 })).toBe(750);
  });
});
