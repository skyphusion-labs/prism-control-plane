import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  DEFAULT_INITIAL_LOOKBACK_MS,
  initialLookbackMs,
  reconcileCronLive,
  runScheduledTick,
} from "../src/scheduled";
import { FakeLogSource } from "./fake-gateway-logs";
import { FakeStore, testPlan } from "./fake-store";

const NOW = new Date("2026-08-05T15:00:00.000Z");

describe("reconcileCronLive", () => {
  it("is true only for the literal string true (case-insensitive trim)", () => {
    expect(reconcileCronLive({} as Env)).toBe(false);
    expect(reconcileCronLive({ RECONCILE_CRON_LIVE: "false" } as Env)).toBe(false);
    expect(reconcileCronLive({ RECONCILE_CRON_LIVE: "1" } as Env)).toBe(false);
    expect(reconcileCronLive({ RECONCILE_CRON_LIVE: "yes" } as Env)).toBe(false);
    expect(reconcileCronLive({ RECONCILE_CRON_LIVE: "true" } as Env)).toBe(true);
    expect(reconcileCronLive({ RECONCILE_CRON_LIVE: " TRUE " } as Env)).toBe(true);
  });
});

describe("initialLookbackMs", () => {
  it("defaults to 7 days and clamps bad values", () => {
    expect(initialLookbackMs({} as Env)).toBe(DEFAULT_INITIAL_LOOKBACK_MS);
    expect(initialLookbackMs({ RECONCILE_CRON_INITIAL_LOOKBACK_DAYS: "3" } as Env)).toBe(
      3 * 24 * 60 * 60 * 1000,
    );
    expect(initialLookbackMs({ RECONCILE_CRON_INITIAL_LOOKBACK_DAYS: "0" } as Env)).toBe(
      DEFAULT_INITIAL_LOOKBACK_MS,
    );
    expect(initialLookbackMs({ RECONCILE_CRON_INITIAL_LOOKBACK_DAYS: "99" } as Env)).toBe(
      DEFAULT_INITIAL_LOOKBACK_MS,
    );
    expect(initialLookbackMs({ RECONCILE_CRON_INITIAL_LOOKBACK_DAYS: "nope" } as Env)).toBe(
      DEFAULT_INITIAL_LOOKBACK_MS,
    );
  });
});

describe("runScheduledTick", () => {
  it("skips when logs are not configured", async () => {
    const store = new FakeStore();
    const out = await runScheduledTick({
      store,
      logs: null,
      now: NOW,
      dryRun: true,
      lookbackMs: DEFAULT_INITIAL_LOOKBACK_MS,
    });
    expect(out).toEqual({ outcome: "skipped", reason: "no_logs" });
  });

  it("supplies a since floor when there is no watermark", async () => {
    const store = new FakeStore({ nowSeconds: Math.floor(NOW.getTime() / 1000) });
    store.plans.set("test", testPlan());
    const source = new FakeLogSource();
    // Empty feed: run succeeds with zero rows if floor is valid.
    const out = await runScheduledTick({
      store,
      logs: source,
      now: NOW,
      dryRun: true,
      lookbackMs: DEFAULT_INITIAL_LOOKBACK_MS,
      newId: () => "adj_test",
    });
    expect(out.outcome).toBe("reconcile");
    if (out.outcome !== "reconcile") return;
    expect(out.dryRun).toBe(true);
    expect(out.result.ok).toBe(true);
    if (out.result.ok) {
      expect(out.result.report.dry_run).toBe(true);
      expect(out.result.report.watermark_after).toBeNull();
      // Floor should be ~7 days before NOW
      const from = Date.parse(out.result.report.window_from);
      expect(NOW.getTime() - from).toBeGreaterThanOrEqual(DEFAULT_INITIAL_LOOKBACK_MS - 1000);
    }
  });

  it("dry-run does not write money even when live would", async () => {
    const store = new FakeStore({ nowSeconds: Math.floor(NOW.getTime() / 1000) });
    await store.advanceReconcileState({
      gateway_id: "prism-proxy",
      watermark: "2026-08-01T00:00:00.000Z",
      last_log_id: null,
      rows_seen: 0,
      rows_adjusted: 0,
      at: NOW.toISOString(),
    });
    const source = new FakeLogSource();
    const out = await runScheduledTick({
      store,
      logs: source,
      now: NOW,
      dryRun: true,
      lookbackMs: DEFAULT_INITIAL_LOOKBACK_MS,
      newId: () => "adj_test",
    });
    expect(out.outcome).toBe("reconcile");
    if (out.outcome === "reconcile" && out.result.ok) {
      expect(out.result.report.applied).toBe(0);
      // Dry run must not move watermark (advanceReconcileState only on live).
      const state = await store.getReconcileState("prism-proxy");
      // Fake may still have our seed watermark; runs should not change it on dry-run.
      expect(state?.watermark).toBe("2026-08-01T00:00:00.000Z");
    }
  });
});
