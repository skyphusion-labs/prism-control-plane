// POST /admin/catalog/refresh -- pull chat rates from AI Gateway compat/models.
//
// Operator door, dry-run default (absent-means-true). Writes only go to model_prices;
// catalog.ts is never mutated. See src/catalog-refresh.ts.

import { gatewayModelSource } from "../aig-models";
import { runCatalogRefresh } from "../catalog-refresh";
import { gatewayConfig } from "../env";
import { errorResponse, jsonResponse, readJsonBody } from "../http";
import { requireOperator } from "./admin";
import type { Ctx } from "./shared";

/**
 * POST /admin/catalog/refresh { dry_run?: false, force?: true }
 *
 * Body required (same posture as reconcile). dry_run omitted = preview.
 * force: overwrite operator-hand-set model_prices notes.
 */
export async function handleCatalogRefresh(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await requireOperator(ctx, request);
  if (!gate.ok) return gate.response;

  const gateway = gatewayConfig(ctx.env);
  const token = (ctx.env.CF_AIG_TOKEN ?? "").trim();
  if (!gateway || !token) {
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "This deployment cannot read compat/models: it needs CF_ACCOUNT_ID, AI_GATEWAY_ID, and CF_AIG_TOKEN. " +
        "Nothing was refreshed.",
    );
  }

  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(ctx.requestId, body.code, body.message);
  const raw = (body.value ?? {}) as Record<string, unknown>;

  if (raw.dry_run !== undefined && typeof raw.dry_run !== "boolean") {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      '"dry_run" must be a boolean when present. Omitted means true: only a literal false writes rates.',
    );
  }
  if (raw.force !== undefined && typeof raw.force !== "boolean") {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      '"force" must be a boolean when present. When true, overwrites operator-set model_prices notes.',
    );
  }

  const dryRun = raw.dry_run !== false;
  const force = raw.force === true;

  try {
    const report = await runCatalogRefresh({
      source: gatewayModelSource({
        accountId: gateway.accountId,
        gatewayId: gateway.id,
        token,
      }),
      store: ctx.store,
      dryRun,
      force,
      now: ctx.now,
    });
    console.info("catalog refresh", {
      event: "catalog.refresh",
      dry_run: report.dry_run,
      force: report.force,
      gateway_models: report.gateway_models,
      updated: report.updated,
      would_update: report.would_update,
      unmatched: report.unmatched,
      skipped_operator: report.skipped_operator,
    });
    return jsonResponse(ctx.requestId, report);
  } catch (err) {
    console.error("catalog refresh failed", {
      event: "catalog.refresh_error",
      requestId: ctx.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(
      ctx.requestId,
      "upstream_error",
      "Could not read AI Gateway compat/models. Nothing was written.",
      { detail: err instanceof Error ? err.message.slice(0, 200) : "unknown" },
    );
  }
}
