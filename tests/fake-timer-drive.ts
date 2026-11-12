// Drive a promise to settlement under vitest fake timers (#118).
//
// The Grok video paths wait on fake setTimeout (the R2 rehost wait polls for up to 45s), but they
// reach that wait only after webcrypto work that resolves on the REAL event loop, off-thread. So a
// test has to advance fake time AND yield real event-loop turns until the promise settles.
//
// The old loops stopped after a fixed 500 steps. On a loaded CI runner webcrypto can take longer
// than 500 real turns, so the loop ran out before the code reached its wait. Nothing advanced the
// fake clock after that, the promise never settled, and the test hung until vitest killed it at
// 5000 ms (CI runs 42732640169 and 43020899395). This loop is bounded by REAL time instead, so a
// slow runner just takes more steps. If the budget runs out it fails with a message that says so,
// before vitest's own timeout, rather than hanging.

import { vi } from "vitest";

export interface DriveOptions {
  /** Fake milliseconds advanced per step. */
  stepMs?: number;
  /** Real milliseconds to keep stepping before giving up. Stays under vitest's 5000 ms default. */
  realBudgetMs?: number;
}

export async function driveFakeTimers<T>(promise: Promise<T>, opts: DriveOptions = {}): Promise<T> {
  const stepMs = opts.stepMs ?? 1_000;
  const realBudgetMs = opts.realBudgetMs ?? 4_000;
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  // Keep the rejection from being reported as unhandled while we step; it is re-raised below.
  tracked.catch(() => undefined);
  // performance.now is not faked (the suites fake setTimeout, clearTimeout and Date only).
  const start = performance.now();
  let steps = 0;
  while (!done) {
    if (performance.now() - start > realBudgetMs) {
      throw new Error(
        `driveFakeTimers: the promise did not settle within ${realBudgetMs} ms of real time ` +
          `(${steps} steps, ${steps * stepMs} fake ms advanced). Something waits on a timer this ` +
          `harness does not fake, or on work that never resolves.`,
      );
    }
    await vi.advanceTimersByTimeAsync(stepMs);
    await new Promise<void>((r) => setImmediate(r));
    steps++;
  }
  return tracked;
}
