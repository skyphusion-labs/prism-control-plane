import { describe, expect, it } from "vitest";
import { checkRateLimit, rateLimitDecision } from "../src/rate-limit";
import { FakeStore } from "./fake-store";

describe("rateLimitDecision", () => {
  it("opens a fresh window on a first attempt", () => {
    expect(rateLimitDecision(1000, null, 0, 3, 60)).toMatchObject({
      allowed: true,
      nextCount: 1,
      nextWindowStart: 1000,
    });
  });

  it("resets once the window has fully elapsed", () => {
    expect(rateLimitDecision(1060, 1000, 3, 3, 60)).toMatchObject({
      allowed: true,
      nextCount: 1,
      nextWindowStart: 1060,
    });
  });

  it("allows up to the limit and refuses past it", () => {
    expect(rateLimitDecision(1010, 1000, 2, 3, 60).allowed).toBe(true);
    expect(rateLimitDecision(1010, 1000, 3, 3, 60).allowed).toBe(false);
  });

  it("counts denied attempts so sustained pressure keeps the bucket shut", () => {
    // A limiter that only counts allowed requests lets a client hammering at ten times the limit ride
    // exactly at the limit forever.
    const denied = rateLimitDecision(1010, 1000, 9, 3, 60);
    expect(denied.allowed).toBe(false);
    expect(denied.nextCount).toBe(10);
  });

  it("reports the seconds left in the window, never zero", () => {
    expect(rateLimitDecision(1010, 1000, 5, 3, 60).retryAfterSeconds).toBe(50);
    // At the very last second of the window, retry-after must still be at least 1: a retry-after of 0
    // invites an immediate retry that is guaranteed to fail.
    expect(rateLimitDecision(1059, 1000, 5, 3, 60).retryAfterSeconds).toBe(1);
  });
});

describe("checkRateLimit", () => {
  it("persists the bucket and refuses once the limit is reached", async () => {
    const store = new FakeStore({ nowSeconds: 5000 });
    for (let i = 0; i < 3; i++) {
      expect((await checkRateLimit(store, "b", 3, 60)).allowed).toBe(true);
    }
    expect((await checkRateLimit(store, "b", 3, 60)).allowed).toBe(false);
    expect(store.buckets.get("b")).toEqual({ count: 4, window_start: 5000 });
  });

  it("reopens after the window rolls", async () => {
    const store = new FakeStore({ nowSeconds: 5000 });
    for (let i = 0; i < 4; i++) await checkRateLimit(store, "b", 3, 60);
    store.nowSeconds = 5060;
    expect((await checkRateLimit(store, "b", 3, 60)).allowed).toBe(true);
  });

  it("keeps buckets independent", async () => {
    const store = new FakeStore({ nowSeconds: 5000 });
    for (let i = 0; i < 4; i++) await checkRateLimit(store, "a", 3, 60);
    expect((await checkRateLimit(store, "b", 3, 60)).allowed).toBe(true);
  });
});
