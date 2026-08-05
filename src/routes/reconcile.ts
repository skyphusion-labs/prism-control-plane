// POST /admin/reconcile -- the operator door onto the AI Gateway cost true-up.
//
// AN OPERATOR ROUTE, NOT A CRON, and that is the whole reason this exists as a route at all. A scheduled
// handler would give a robot with write access to a money column its own trigger before anybody had
// watched it run once against real data. Pulling the trigger by hand means the first live run has a human
// reading the report, and the dry run makes that reading free. A `[triggers]` cron can be added later by
// calling `runReconcile` from a `scheduled` handler; nothing in the run path assumes a request.
//
// DRY RUN IS THE DEFAULT AND IT IS ABSENT-MEANS-TRUE. `dry_run` omitted, null, or anything other than the
// literal `false` previews. Only `"dry_run": false` writes money. A truthiness check would make
// `"dry_run": "no"` a live run, and the direction that mistake fails in is a real charge against a real
// user's prepaid balance.
//
// THE REPORT IS THE PRODUCT. Even a live run's value is mostly in what it declined to do: five of the
// outcomes in src/reconcile.ts move nothing, and each one is counted separately so the single alarming
// case (spend Cloudflare billed that this plane never recorded) cannot hide inside a total.

import { newId } from "../crypto";
import { errorResponse, jsonResponse, readJsonBody } from "../http";
import { MAX_ROWS_PER_RUN } from "../reconcile";
import { runReconcile } from "../reconcile-run";
import { requireOperator } from "./admin";
import type { Ctx } from "./shared";

/**
 * POST /admin/reconcile { dry_run?: false, since?: ISO 8601, max_rows?: integer }
 *
 * A BODY IS REQUIRED, even though every field in it is optional. `readJsonBody` refuses an empty body, and
 * that refusal is kept rather than worked around: it means a bare `curl -XPOST` cannot start a run at all,
 * so every run is something somebody typed a body for.
 */
export async function handleReconcile(ctx: Ctx, request: Request): Promise<Response> {
  const gate = await requireOperator(ctx, request);
  if (!gate.ok) return gate.response;

  // FAIL CLOSED, with the reason. Reconciliation needs the gateway coordinates and a token carrying AI
  // Gateway Read; in per-user credential mode there is no shared CF_AIG_TOKEN, so this door is simply
  // shut. Answering 503 and saying which piece is missing is the same posture the inference route takes.
  if (!ctx.logs) {
    return errorResponse(
      ctx.requestId,
      "unavailable",
      "This deployment cannot read the AI Gateway log feed: it needs CF_ACCOUNT_ID, AI_GATEWAY_ID, and a " +
        "CF_AIG_TOKEN carrying AI Gateway Read. Nothing was reconciled.",
    );
  }

  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(ctx.requestId, body.code, body.message);
  const raw = (body.value ?? {}) as Record<string, unknown>;

  if (raw.dry_run !== undefined && typeof raw.dry_run !== "boolean") {
    return errorResponse(
      ctx.requestId,
      "invalid_request",
      '"dry_run" must be a boolean when present. It is omitted-means-true: only a literal false writes money.',
    );
  }
  const dryRun = raw.dry_run !== false;

  let since: string | null = null;
  if (raw.since !== undefined) {
    if (typeof raw.since !== "string" || Number.isNaN(Date.parse(raw.since))) {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        '"since" must be an ISO 8601 timestamp. It is the floor for the FIRST run against a gateway; once ' +
          "a watermark exists it is ignored.",
      );
    }
    since = raw.since;
  }

  let maxRows: number | undefined;
  if (raw.max_rows !== undefined) {
    if (!Number.isInteger(raw.max_rows) || (raw.max_rows as number) < 1) {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        `"max_rows" must be a positive integer. The default and ceiling is ${MAX_ROWS_PER_RUN}.`,
      );
    }
    maxRows = Math.min(raw.max_rows as number, MAX_ROWS_PER_RUN);
  }

  const result = await runReconcile({
    store: ctx.store,
    source: ctx.logs,
    now: ctx.now,
    dryRun,
    since,
    maxRows,
    newId: () => newId("adj"),
  });

  if (!result.ok) {
    if (result.reason === "no_floor") {
      return errorResponse(ctx.requestId, "invalid_request", result.detail);
    }
    // 502, NOT 200 with an empty report. "Reconciled 0 rows" and "could not read the feed" look identical
    // in a dashboard and mean opposite things, and the second one is the state where drift accumulates
    // unseen. Cloudflare's own error text is preserved: a token missing AI Gateway Read (9109) and a bad
    // filter (400) need different operator actions.
    console.error("reconcile could not read the gateway feed", {
      event: "reconcile.upstream_error",
      requestId: ctx.requestId,
      gateway_id: ctx.logs.gatewayId,
      error: result.detail,
    });
    return errorResponse(
      ctx.requestId,
      "upstream_error",
      `The AI Gateway log feed could not be read, so nothing was reconciled: ${result.detail}`,
    );
  }

  return jsonResponse(ctx.requestId, result.report);
}
