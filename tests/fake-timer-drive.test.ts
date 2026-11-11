// The fake-timer driver used by the Grok video tests (#118).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { driveFakeTimers } from "./fake-timer-drive";

/** Resolve after `ticks` REAL event-loop turns, the way off-thread webcrypto resolves late. */
async function realTicks(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise<void>((r) => setImmediate(r));
}

describe("driveFakeTimers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-08-04T12:00:00.000Z"), toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("crosses a 45s fake wait that starts only after slow real-loop work", async () => {
    // 5000 real turns before the wait. The old loops stopped after 500 steps, and each step yields
    // only a few real turns, so they stopped before this wait started and the test hung until
    // vitest's 5000 ms timeout. Measured: with the 500-step cap put back, this case fails.
    const work = (async () => {
      await realTicks(5_000);
      await new Promise<void>((r) => setTimeout(r, 45_000));
      return "landed";
    })();
    await expect(driveFakeTimers(work)).resolves.toBe("landed");
  });

  it("passes a rejection through unchanged", async () => {
    const work = (async () => {
      await new Promise<void>((r) => setTimeout(r, 3_000));
      throw new Error("boom");
    })();
    await expect(driveFakeTimers(work)).rejects.toThrow("boom");
  });

  it("fails loudly, inside its real budget, on a promise that never settles", async () => {
    const never = new Promise<never>(() => undefined);
    const start = performance.now();
    await expect(driveFakeTimers(never, { realBudgetMs: 200 })).rejects.toThrow(
      /driveFakeTimers: the promise did not settle within 200 ms of real time/,
    );
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it("advances fake time while it waits", async () => {
    const before = Date.now();
    await driveFakeTimers(new Promise<void>((r) => setTimeout(r, 10_000)));
    expect(Date.now() - before).toBeGreaterThanOrEqual(10_000);
  });
});
