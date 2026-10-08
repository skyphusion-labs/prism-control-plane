// GET /v1/jobs      -- list the calling client's recent jobs (#92).
// GET /v1/jobs/:id   -- poll one long-run video/music job.

import type { AsyncJobRow, AsyncJobStatus } from "../store";
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

const JOB_STATUSES: readonly AsyncJobStatus[] = ["queued", "running", "succeeded", "failed"];

const DEFAULT_JOB_LIMIT = 20;
const MAX_JOB_LIMIT = 100;

/**
 * GET /v1/jobs -- the caller's recent jobs, newest first.
 *
 * WHY THIS EXISTS (#92): GET /v1/jobs/:id was the only job route, so the id was
 * the single handle on paid work. A poll that timed out, a crash, or a reinstall
 * destroyed it, and GET /v1/usage returns aggregates only, so a user could see
 * THAT they were charged and never FOR WHAT. This is the way back.
 *
 * Scope: client_id, the same ownership predicate handleGetJob already applies.
 * A caller can therefore enumerate only its own jobs, so this does not weaken
 * the "same 404 for missing and other-account" posture of the single-job route.
 *
 * Deliberately an INDEX, not a result feed: the row's result_json is omitted
 * here and stays on GET /v1/jobs/:id. Keeps the list bounded, and keeps exactly
 * one route serving signed asset URLs.
 *
 * Bad input is REFUSED, not silently clamped: a client that asked for
 * limit=1000 and quietly got 100 would reasonably believe it had seen
 * everything, which is the failure this endpoint exists to prevent.
 */
export async function handleListJobs(ctx: Ctx, request: Request): Promise<Response> {
  const auth = await requireCaller(ctx, request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;

  const rawStatus = params.get("status");
  let status: AsyncJobStatus | undefined;
  if (rawStatus !== null) {
    if (!(JOB_STATUSES as readonly string[]).includes(rawStatus)) {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        `status must be one of: ${JOB_STATUSES.join(", ")}.`,
      );
    }
    status = rawStatus as AsyncJobStatus;
  }

  const rawLimit = params.get("limit");
  let limit = DEFAULT_JOB_LIMIT;
  if (rawLimit !== null) {
    // Number() so "abc" is NaN and "1e9" does not sneak past a parseInt prefix read.
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_JOB_LIMIT) {
      return errorResponse(
        ctx.requestId,
        "invalid_request",
        `limit must be an integer between 1 and ${MAX_JOB_LIMIT}.`,
      );
    }
    limit = parsed;
  }

  const jobs = await ctx.store.listAsyncJobsByClient({
    clientId: auth.caller.client.id,
    limit,
    status,
  });

  return jsonResponse(ctx.requestId, {
    jobs: jobs.map(jobSummaryToWire),
    count: jobs.length,
  });
}

/** List projection: identity and state only, never the result payload. */
export function jobSummaryToWire(job: AsyncJobRow): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    model: job.model_id,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
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
