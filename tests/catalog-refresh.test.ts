import { describe, expect, it } from "vitest";
import {
  microUsdPerMTokFromUsdPerToken,
  parseGatewayModelRate,
  type GatewayModelRate,
  type GatewayModelSource,
} from "../src/aig-models";
import {
  GATEWAY_COMPAT_NOTE_PREFIX,
  gatewayIdCandidates,
  isOperatorProtectedNote,
  matchGatewayRate,
  runCatalogRefresh,
} from "../src/catalog-refresh";
import { FakeStore, testPlan } from "./fake-store";

function sourceOf(models: GatewayModelRate[], malformed = 0): GatewayModelSource {
  return {
    async listRates() {
      return { models, malformed };
    },
  };
}

describe("parseGatewayModelRate + conversion", () => {
  it("parses cost_in/cost_out", () => {
    const row = parseGatewayModelRate({
      id: "workers-ai/@cf/meta/llama-3.2-3b-instruct",
      cost_in: 5.1e-8,
      cost_out: 3.4e-7,
      owned_by: "workers-ai",
    });
    expect(row?.id).toBe("workers-ai/@cf/meta/llama-3.2-3b-instruct");
    expect(microUsdPerMTokFromUsdPerToken(5.1e-8)).toBe(51000);
    expect(microUsdPerMTokFromUsdPerToken(3.4e-7)).toBe(340000);
  });

  it("rejects negative and non-finite costs", () => {
    expect(parseGatewayModelRate({ id: "x", cost_in: -1, cost_out: 0 })).toBeNull();
    expect(parseGatewayModelRate({ id: "x", cost_in: NaN, cost_out: 0 })).toBeNull();
    expect(parseGatewayModelRate({ id: "", cost_in: 0, cost_out: 0 })).toBeNull();
  });

  it("handles 9.5e-7 without float drift into wrong MTok", () => {
    expect(microUsdPerMTokFromUsdPerToken(9.5e-7)).toBe(950000);
  });
});

describe("gateway id join", () => {
  it("aliases @cf, xai, and google", () => {
    expect(gatewayIdCandidates("@cf/meta/llama-3.2-3b-instruct")).toContain(
      "workers-ai/@cf/meta/llama-3.2-3b-instruct",
    );
    expect(gatewayIdCandidates("xai/grok-4.5")).toEqual(
      expect.arrayContaining(["xai/grok-4.5", "grok/grok-4.5", "xai/xai/grok-4.5"]),
    );
    expect(gatewayIdCandidates("google/gemini-2.5-flash")).toContain(
      "google-ai-studio/gemini-2.5-flash",
    );
  });

  it("matches workers-ai prefix for catalog @cf id", () => {
    const map = new Map<string, GatewayModelRate>([
      [
        "workers-ai/@cf/meta/llama-3.2-3b-instruct",
        {
          id: "workers-ai/@cf/meta/llama-3.2-3b-instruct",
          costInUsdPerToken: 5.1e-8,
          costOutUsdPerToken: 3.4e-7,
          ownedBy: "workers-ai",
        },
      ],
    ]);
    expect(matchGatewayRate("@cf/meta/llama-3.2-3b-instruct", map)?.id).toBe(
      "workers-ai/@cf/meta/llama-3.2-3b-instruct",
    );
  });
});

describe("isOperatorProtectedNote", () => {
  it("protects hand-set notes, not gateway-compat or empty", () => {
    expect(isOperatorProtectedNote("manual floor for launch")).toBe(true);
    expect(isOperatorProtectedNote(`${GATEWAY_COMPAT_NOTE_PREFIX}:2026-08-05`)).toBe(false);
    expect(isOperatorProtectedNote(null)).toBe(false);
    expect(isOperatorProtectedNote("")).toBe(false);
  });
});

describe("runCatalogRefresh", () => {
  const NOW = new Date("2026-08-05T15:00:00.000Z");
  const MODEL = "@cf/meta/llama-3.2-3b-instruct";
  const GW_ID = "workers-ai/@cf/meta/llama-3.2-3b-instruct";

  async function store() {
    const s = new FakeStore({ nowSeconds: Math.floor(NOW.getTime() / 1000) });
    s.plans.set("test", testPlan());
    return s;
  }

  const gwRate = (costIn: number, costOut: number): GatewayModelRate => ({
    id: GW_ID,
    costInUsdPerToken: costIn,
    costOutUsdPerToken: costOut,
    ownedBy: "workers-ai",
  });

  it("dry-run previews without writing", async () => {
    const s = await store();
    // Catalog baseline is 50900/335000; gateway 51000/340000 differs.
    const report = await runCatalogRefresh({
      source: sourceOf([gwRate(5.1e-8, 3.4e-7)]),
      store: s,
      dryRun: true,
      force: false,
      now: NOW,
    });
    const row = report.rows.find((r) => r.model_id === MODEL);
    expect(row?.action).toBe("would_update");
    expect(row?.gateway_input).toBe(51000);
    expect(row?.gateway_output).toBe(340000);
    expect(await s.getModelPrice(MODEL)).toBeNull();
    expect(report.updated).toBe(0);
    expect(report.would_update).toBeGreaterThanOrEqual(1);
  });

  it("live run writes model_prices with gateway-compat note", async () => {
    const s = await store();
    const report = await runCatalogRefresh({
      source: sourceOf([gwRate(5.1e-8, 3.4e-7)]),
      store: s,
      dryRun: false,
      force: false,
      now: NOW,
    });
    const row = report.rows.find((r) => r.model_id === MODEL);
    expect(row?.action).toBe("updated");
    const price = await s.getModelPrice(MODEL);
    expect(price?.input_micro_usd_per_mtok).toBe(51000);
    expect(price?.output_micro_usd_per_mtok).toBe(340000);
    expect(price?.note).toBe(`${GATEWAY_COMPAT_NOTE_PREFIX}:2026-08-05`);
    expect(price?.unit_micro_usd).toBeNull();
  });

  it("skips operator-protected notes unless force", async () => {
    const s = await store();
    await s.putModelPrice({
      model_id: MODEL,
      input_micro_usd_per_mtok: 1,
      output_micro_usd_per_mtok: 2,
      unit_micro_usd: null,
      priced_at: "2026-01-01",
      note: "operator floor",
    });
    const skipped = await runCatalogRefresh({
      source: sourceOf([gwRate(5.1e-8, 3.4e-7)]),
      store: s,
      dryRun: false,
      force: false,
      now: NOW,
    });
    expect(skipped.rows.find((r) => r.model_id === MODEL)?.action).toBe("skipped_operator");
    expect((await s.getModelPrice(MODEL))?.input_micro_usd_per_mtok).toBe(1);

    const forced = await runCatalogRefresh({
      source: sourceOf([gwRate(5.1e-8, 3.4e-7)]),
      store: s,
      dryRun: false,
      force: true,
      now: NOW,
    });
    expect(forced.rows.find((r) => r.model_id === MODEL)?.action).toBe("updated");
    expect((await s.getModelPrice(MODEL))?.input_micro_usd_per_mtok).toBe(51000);
  });

  it("preserves unit_micro_usd on update", async () => {
    const s = await store();
    await s.putModelPrice({
      model_id: MODEL,
      input_micro_usd_per_mtok: 1,
      output_micro_usd_per_mtok: 2,
      unit_micro_usd: 7700,
      priced_at: "2026-01-01",
      note: `${GATEWAY_COMPAT_NOTE_PREFIX}:2026-01-01`,
    });
    await runCatalogRefresh({
      source: sourceOf([gwRate(5.1e-8, 3.4e-7)]),
      store: s,
      dryRun: false,
      force: false,
      now: NOW,
    });
    expect((await s.getModelPrice(MODEL))?.unit_micro_usd).toBe(7700);
  });

  it("marks unmatched when gateway has no join", async () => {
    const s = await store();
    const report = await runCatalogRefresh({
      source: sourceOf([]),
      store: s,
      dryRun: true,
      force: false,
      now: NOW,
    });
    expect(report.unmatched).toBe(report.catalog_chat);
    expect(report.rows.every((r) => r.action === "unmatched")).toBe(true);
  });

  it("is unchanged when override already matches gateway", async () => {
    const s = await store();
    await s.putModelPrice({
      model_id: MODEL,
      input_micro_usd_per_mtok: 51000,
      output_micro_usd_per_mtok: 340000,
      unit_micro_usd: null,
      priced_at: "2026-08-01",
      note: `${GATEWAY_COMPAT_NOTE_PREFIX}:2026-08-01`,
    });
    const report = await runCatalogRefresh({
      source: sourceOf([gwRate(5.1e-8, 3.4e-7)]),
      store: s,
      dryRun: false,
      force: false,
      now: NOW,
    });
    expect(report.rows.find((r) => r.model_id === MODEL)?.action).toBe("unchanged");
  });
});
