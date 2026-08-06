// GET /v1/jobs/:id -- poll long-run video/music jobs.

import type { AsyncJobRow } from "../store";
import { errorResponse, jsonResponse } from "../http";
import type { Ctx } from "./shared";
import { requireCaller } from "./shared";

const JOB_PATH = /^\/v1\/jobs\/([A-Za-z0-9_-]+)$/;

export function matchJobPath(path: string): string | null {
  const m = JOB_PATH.exec(path);
  return m ? m[1] : null;
}

export async function handleGetJob(
  ctx: Ctx,
  request: Request,
  jobId: string,
): Promise<Response> {
  const auth = await requireCaller(ctx, request);
  if (!auth.ok) return auth.response;

  const job = await ctx.store.getAsyncJob(jobId);
  if (!job || job.client_id !== auth.caller.client.id) {
    // Same 404 for missing and other-account (no job enumeration).
    return errorResponse(ctx.requestId, "not_found", "Job not found.");
  }

  return jsonResponse(ctx.requestId, jobToWire(job));
}

export function jobToWire(job: AsyncJobRow): Record<string, unknown> {
  let result: unknown = null;
  if (job.result_json) {
    try {
      result = JSON.parse(job.result_json) as unknown;
    } catch {
      result = null;
    }
  }
  return {
    id: job.id,
    kind: job.kind,
    model: job.model_id,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    result,
    error:
      job.status === "failed"
        ? {
            code: job.error_code ?? "internal",
            message: job.error_detail ?? "Job failed.",
          }
        : null,
  };
}

/** Prefer async when body.async === true or Prefer: respond-async. */
export function wantsAsync(request: Request, body: Record<string, unknown>): boolean {
  if (body.async === true) return true;
  if (body.async === false) return false;
  const prefer = request.headers.get("prefer") ?? request.headers.get("Prefer") ?? "";
  return /\brespond-async\b/i.test(prefer);
}
