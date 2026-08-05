// Refresh chat token rates from AI Gateway compat/models into model_prices.
//
// WHY NOT REWRITE catalog.ts: the committed table is the allowlist + disclosure baseline.
// Rates move intraday (ARCHITECTURE.md); operator overrides in D1 are the runtime rate card
// resolvePrice already prefers. Writing gateway rates there means no deploy to follow a CF reprice.
//
// DRY RUN DEFAULT (absent-means-true), same posture as reconcile: only dry_run: false writes.
// Manual operator rows (note not prefixed with gateway-compat) are preserved unless force: true.

import { CATALOG, type CatalogEntry } from "./catalog";
import {
  microUsdPerMTokFromUsdPerToken,
  type GatewayModelRate,
  type GatewayModelSource,
} from "./aig-models";
import type { ControlPlaneStore, ModelPriceRow } from "./store";

/** Note prefix that marks a row as owned by this refresh job. */
export const GATEWAY_COMPAT_NOTE_PREFIX = "gateway-compat";

export interface CatalogRefreshArgs {
  source: GatewayModelSource;
  store: ControlPlaneStore;
  /** Only a literal false writes. Omitted / true = preview. */
  dryRun: boolean;
  /**
   * When false (default), skip model_prices rows whose note is set and does not start with
   * gateway-compat (operator-hand-set token rates). When true, overwrite those too.
   */
  force: boolean;
  /** Clock for priced_at (YYYY-MM-DD). */
  now: Date;
}

export type CatalogRefreshAction =
  | "would_update"
  | "updated"
  | "unchanged"
  | "skipped_operator"
  | "unmatched"
  | "unusable_rate";

export interface CatalogRefreshRow {
  model_id: string;
  gateway_id: string | null;
  action: CatalogRefreshAction;
  catalog_input: number | null;
  catalog_output: number | null;
  gateway_input: number | null;
  gateway_output: number | null;
  previous_input: number | null;
  previous_output: number | null;
}

export interface CatalogRefreshReport {
  dry_run: boolean;
  force: boolean;
  gateway_models: number;
  gateway_malformed: number;
  catalog_chat: number;
  would_update: number;
  updated: number;
  unchanged: number;
  skipped_operator: number;
  unmatched: number;
  unusable_rate: number;
  rows: CatalogRefreshRow[];
}

/**
 * Candidate gateway ids for one catalog id (join aliases measured 2026-08-05).
 *
 * Prefer exact match first when present in the gateway map; callers iterate this list in order.
 */
export function gatewayIdCandidates(catalogId: string): string[] {
  const out: string[] = [catalogId];
  if (catalogId.startsWith("@cf/")) {
    out.push(`workers-ai/${catalogId}`);
  }
  if (catalogId.startsWith("xai/")) {
    const rest = catalogId.slice("xai/".length);
    out.push(`grok/${rest}`, `xai/xai/${rest}`);
  }
  if (catalogId.startsWith("google/")) {
    out.push(`google-ai-studio/${catalogId.slice("google/".length)}`);
  }
  return out;
}

/** Pick the first gateway rate that matches a catalog id under the alias list. */
export function matchGatewayRate(
  catalogId: string,
  byGatewayId: Map<string, GatewayModelRate>,
): GatewayModelRate | null {
  for (const cand of gatewayIdCandidates(catalogId)) {
    const hit = byGatewayId.get(cand);
    if (hit) return hit;
  }
  return null;
}

export function isOperatorProtectedNote(note: string | null | undefined): boolean {
  if (!note || !note.trim()) return false;
  return !note.trim().startsWith(GATEWAY_COMPAT_NOTE_PREFIX);
}

/**
 * Chat models only: token-metered door. Non-chat unit rates are not in compat/models cost_in/out.
 */
export function chatCatalogEntries(catalog: readonly CatalogEntry[] = CATALOG): CatalogEntry[] {
  return catalog.filter((e) => e.modality === "chat");
}

/**
 * Run one refresh. Pure relative to I/O: all network/store work is through args.
 */
export async function runCatalogRefresh(args: CatalogRefreshArgs): Promise<CatalogRefreshReport> {
  const page = await args.source.listRates();
  const byGatewayId = new Map<string, GatewayModelRate>();
  for (const m of page.models) {
    // First wins: gateway list can have duplicates; keep the first well-formed row.
    if (!byGatewayId.has(m.id)) byGatewayId.set(m.id, m);
  }

  const chat = chatCatalogEntries();
  const existing = new Map((await args.store.listModelPrices()).map((r) => [r.model_id, r]));
  const pricedAt = args.now.toISOString().slice(0, 10);
  const note = `${GATEWAY_COMPAT_NOTE_PREFIX}:${pricedAt}`;

  const rows: CatalogRefreshRow[] = [];
  let wouldUpdate = 0;
  let updated = 0;
  let unchanged = 0;
  let skippedOperator = 0;
  let unmatched = 0;
  let unusableRate = 0;

  for (const entry of chat) {
    const catalogIn = entry.price?.inputMicroUsdPerMTok ?? null;
    const catalogOut = entry.price?.outputMicroUsdPerMTok ?? null;
    const prev = existing.get(entry.id) ?? null;

    const gw = matchGatewayRate(entry.id, byGatewayId);
    if (!gw) {
      unmatched += 1;
      rows.push({
        model_id: entry.id,
        gateway_id: null,
        action: "unmatched",
        catalog_input: catalogIn,
        catalog_output: catalogOut,
        gateway_input: null,
        gateway_output: null,
        previous_input: prev?.input_micro_usd_per_mtok ?? null,
        previous_output: prev?.output_micro_usd_per_mtok ?? null,
      });
      continue;
    }

    const gatewayIn = microUsdPerMTokFromUsdPerToken(gw.costInUsdPerToken);
    const gatewayOut = microUsdPerMTokFromUsdPerToken(gw.costOutUsdPerToken);
    if (gatewayIn === null || gatewayOut === null) {
      unusableRate += 1;
      rows.push({
        model_id: entry.id,
        gateway_id: gw.id,
        action: "unusable_rate",
        catalog_input: catalogIn,
        catalog_output: catalogOut,
        gateway_input: gatewayIn,
        gateway_output: gatewayOut,
        previous_input: prev?.input_micro_usd_per_mtok ?? null,
        previous_output: prev?.output_micro_usd_per_mtok ?? null,
      });
      continue;
    }

    if (prev && isOperatorProtectedNote(prev.note) && !args.force) {
      skippedOperator += 1;
      rows.push({
        model_id: entry.id,
        gateway_id: gw.id,
        action: "skipped_operator",
        catalog_input: catalogIn,
        catalog_output: catalogOut,
        gateway_input: gatewayIn,
        gateway_output: gatewayOut,
        previous_input: prev.input_micro_usd_per_mtok,
        previous_output: prev.output_micro_usd_per_mtok,
      });
      continue;
    }

    const sameAsOverride =
      prev !== null &&
      prev.input_micro_usd_per_mtok === gatewayIn &&
      prev.output_micro_usd_per_mtok === gatewayOut;
    // When no override exists, still write if gateway differs from catalog baseline (or catalog null).
    const sameAsCatalog =
      prev === null &&
      catalogIn !== null &&
      catalogOut !== null &&
      catalogIn === gatewayIn &&
      catalogOut === gatewayOut;

    if (sameAsOverride || sameAsCatalog) {
      unchanged += 1;
      rows.push({
        model_id: entry.id,
        gateway_id: gw.id,
        action: "unchanged",
        catalog_input: catalogIn,
        catalog_output: catalogOut,
        gateway_input: gatewayIn,
        gateway_output: gatewayOut,
        previous_input: prev?.input_micro_usd_per_mtok ?? null,
        previous_output: prev?.output_micro_usd_per_mtok ?? null,
      });
      continue;
    }

    if (args.dryRun) {
      wouldUpdate += 1;
      rows.push({
        model_id: entry.id,
        gateway_id: gw.id,
        action: "would_update",
        catalog_input: catalogIn,
        catalog_output: catalogOut,
        gateway_input: gatewayIn,
        gateway_output: gatewayOut,
        previous_input: prev?.input_micro_usd_per_mtok ?? null,
        previous_output: prev?.output_micro_usd_per_mtok ?? null,
      });
      continue;
    }

    const next: ModelPriceRow = {
      model_id: entry.id,
      input_micro_usd_per_mtok: gatewayIn,
      output_micro_usd_per_mtok: gatewayOut,
      // Preserve unit rates set for hybrid rows; chat normally has null unit.
      unit_micro_usd: prev?.unit_micro_usd ?? null,
      priced_at: pricedAt,
      note,
    };
    await args.store.putModelPrice(next);
    existing.set(entry.id, next);
    updated += 1;
    rows.push({
      model_id: entry.id,
      gateway_id: gw.id,
      action: "updated",
      catalog_input: catalogIn,
      catalog_output: catalogOut,
      gateway_input: gatewayIn,
      gateway_output: gatewayOut,
      previous_input: prev?.input_micro_usd_per_mtok ?? null,
      previous_output: prev?.output_micro_usd_per_mtok ?? null,
    });
  }

  return {
    dry_run: args.dryRun,
    force: args.force,
    gateway_models: page.models.length,
    gateway_malformed: page.malformed,
    catalog_chat: chat.length,
    would_update: wouldUpdate,
    updated,
    unchanged,
    skipped_operator: skippedOperator,
    unmatched,
    unusable_rate: unusableRate,
    rows,
  };
}
