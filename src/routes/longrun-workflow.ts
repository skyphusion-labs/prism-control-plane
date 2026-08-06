// Durable long-run video/music generation via Cloudflare Workflows.
//
// Why not ctx.waitUntil (see prism README + CLAUDE.md):
//   waitUntil has ~30s after the HTTP response. MiniMax music and UB video
//   block 1-5 minutes on env.AI.run, so waitUntil dies mid-call. Live evidence
//   2026-08-06: every async_jobs row stuck status=running, never hit AI Gateway.
//
// Pattern mirrors prism LongRunWorkflow: step.do("invoke-model") holds the
// blocking AI call; later steps rehost + meter + finalize D1.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { allocateCharge, decideBalance } from "../balance";
import { findModel } from "../catalog";
import { newId } from "../crypto";
import type { Env } from "../env";
import { gatewayConfig, nonChatUpstreamTimeoutMs } from "../env";
import {
  MEDIA_MAX_BYTES,
  mediaPublicUrl,
  mediaSigningSecret,
  mintDownloadToken,
  mintUploadToken,
  newMusicObjectKey,
  newVideoObjectKey,
} from "../media";
import {
  buildMusicParams,
  buildVideoParams,
  extractMusicAsset,
  extractVideoAsset,
  nonChatRunnerFor,
  providerStateFailed,
} from "../nonchat-upstream";
import { periodBounds } from "../period";
import { priceUnits } from "../meter";
import { d1Store } from "../store-d1";
import type { UsageEvent } from "../store";
import type { MeterUnit } from "../catalog";

export type PlaneLongRunKind = "video" | "music";

/**
 * Workflow event payload. Prompt/lyrics live ONLY here for the job lifetime
 * (privacy: never written to async_jobs / usage_events).
 */
export interface PlaneLongRunParams extends Record<string, unknown> {
  jobId: string;
  kind: PlaneLongRunKind;
  modelId: string;
  upstreamModel: string;
  prompt: string;
  lyrics?: string;
  /** https URL or omitted; data: images staged to imageObjectKey first. */
  imageUrl?: string;
  /** MEDIA R2 key for a staged i2v still (optional). */
  imageObjectKey?: string;
  accountId: string;
  clientId: string;
  planId: string;
  requestId: string;
  unitMicroUsd: number;
  unit: string;
  monthlyIncludedMicroUsd: number;
  /** Origin for signed media URLs (e.g. https://play-proxy.skyphusion.org). */
  origin: string;
  startedAtIso: string;
}

export class PlaneLongRunWorkflow extends WorkflowEntrypoint<Env, PlaneLongRunParams> {
  async run(event: WorkflowEvent<PlaneLongRunParams>, step: WorkflowStep): Promise<void> {
    const p = event.payload;
    const store = d1Store(this.env.DB);

    const failJob = async (code: string, message: string): Promise<void> => {
      try {
        await store.updateAsyncJob({
          id: p.jobId,
          status: "failed",
          error_code: code,
          error_detail: message.slice(0, 280),
          updated_at: new Date().toISOString(),
        });
      } catch {
        /* D1 down: nothing else to do */
      }
    };

    try {
      // Step 1: long blocking AI call (the whole reason this is a Workflow).
      const asset = await step.do(
        "invoke-model",
        { retries: { limit: 1, delay: "30 seconds", backoff: "linear" } },
        async (): Promise<{ url: string; gatewayLogId: string | null }> => {
          const gw = gatewayConfig(this.env);
          if (!gw) throw new Error("No AI Gateway configured on this deployment.");
          if (!this.env.CF_AIG_TOKEN?.trim()) {
            throw new Error("CF_AIG_TOKEN is not configured.");
          }
          const runner = nonChatRunnerFor({
            accountId: gw.accountId,
            gatewayId: gw.id,
            timeoutMs: nonChatUpstreamTimeoutMs(this.env),
            collectLog: gw.collectLog,
            ai: this.env.AI,
          });

          let image: string | undefined = p.imageUrl;
          if (p.imageObjectKey && this.env.MEDIA) {
            const obj = await this.env.MEDIA.get(p.imageObjectKey);
            if (!obj) throw new Error("Staged i2v image missing from MEDIA R2.");
            const buf = await obj.arrayBuffer();
            const ct = obj.httpMetadata?.contentType ?? "image/jpeg";
            const b64 = bytesToBase64(new Uint8Array(buf));
            image = `data:${ct};base64,${b64}`;
          }

          let uploadUrl: string | undefined;
          let downloadUrl: string | undefined;
          let objectKey: string | undefined;
          if (p.kind === "video" && p.modelId.startsWith("xai/grok-imagine-video")) {
            const secret = mediaSigningSecret(this.env);
            if (!this.env.MEDIA || !secret) {
              throw new Error(
                "Grok video requires MEDIA R2 + CF_AIG_TOKEN for ZDR output.upload_url.",
              );
            }
            objectKey = newVideoObjectKey(p.accountId, p.requestId);
            const upTok = await mintUploadToken(secret, objectKey);
            const downTok = await mintDownloadToken(secret, objectKey);
            uploadUrl = mediaPublicUrl(p.origin, `/v1/media/ingress/${upTok.token}`);
            downloadUrl = mediaPublicUrl(p.origin, `/v1/media/${downTok.token}`);
          }

          const params =
            p.kind === "music"
              ? buildMusicParams(p.prompt, p.lyrics)
              : buildVideoParams(p.modelId, p.prompt, image, { uploadUrl });

          const entry = findModel(p.modelId);
          if (!entry) throw new Error(`Model not in catalog: ${p.modelId}`);

          const result = await runner.run({
            upstreamModel: p.upstreamModel,
            billing: entry.billing,
            modality: entry.modality,
            params,
            auth: { tokenId: "shared", value: this.env.CF_AIG_TOKEN.trim() },
            metadata: {
              account_id: p.accountId,
              client_id: p.clientId,
              plan_id: p.planId,
              request_id: p.requestId,
              job_id: p.jobId,
              cf_token_id: "shared",
            },
          });

          if (result.outcome === "timeout") {
            throw new Error(`Upstream timeout after ${result.waitedMs}ms`);
          }
          if (result.outcome === "unavailable") {
            throw new Error(result.detail);
          }
          if (result.outcome === "upstream_error") {
            throw new Error(result.detail);
          }

          const fail = providerStateFailed(result.body);
          if (fail) throw new Error(fail);

          let url: string | null =
            p.kind === "music" ? extractMusicAsset(result.body) : extractVideoAsset(result.body);

          // Grok ZDR: wait for xAI PUT into our R2.
          if (p.kind === "video" && downloadUrl && objectKey && this.env.MEDIA) {
            const ready = await waitForObject(this.env.MEDIA, objectKey, 45_000);
            if (ready) url = downloadUrl;
            else if (!url) url = downloadUrl;
          }

          if (!url) {
            throw new Error(
              `${p.kind} completed but no asset URL. Raw: ${JSON.stringify(result.body).slice(0, 400)}`,
            );
          }
          return { url, gatewayLogId: result.gatewayLogId };
        },
      );

      // Step 2: rehost provider HTTPS audio/video onto MEDIA when possible.
      const finalAsset = await step.do(
        "rehost-asset",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        async (): Promise<{ url: string; rehosted: boolean }> => {
          if (p.kind === "music" && looksLikeHttpUrl(asset.url)) {
            const hosted = await rehostMusic(this.env, p, asset.url);
            if (hosted) return { url: hosted, rehosted: true };
          }
          return { url: asset.url, rehosted: false };
        },
      );

      // Step 3: meter + mark job succeeded.
      await step.do(
        "finalize",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async (): Promise<void> => {
          await meterJob(this.env, p, asset.gatewayLogId);
          const resultJson =
            p.kind === "music"
              ? JSON.stringify({
                  audio: finalAsset.url,
                  rehosted: finalAsset.rehosted,
                  model: p.modelId,
                })
              : JSON.stringify({ video: finalAsset.url, model: p.modelId });
          await store.updateAsyncJob({
            id: p.jobId,
            status: "succeeded",
            result_json: resultJson,
            error_code: null,
            error_detail: null,
            updated_at: new Date().toISOString(),
          });
        },
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await failJob("upstream_error", m);
      throw err;
    }
  }
}

async function meterJob(
  env: Env,
  p: PlaneLongRunParams,
  gatewayLogId: string | null,
): Promise<void> {
  const store = d1Store(env.DB);
  const account = await store.getAccount(p.accountId);
  if (!account) throw new Error("Account missing at meter time");
  const bounds = periodBounds(new Date());
  const periodBefore = await store.getPeriod(p.accountId, bounds.key);
  const priced = priceUnits(1, {
    microUsdPerUnit: p.unitMicroUsd,
    unit: p.unit as MeterUnit,
    pricedAt: "workflow",
  });
  const balance = decideBalance({
    creditMicroUsd: account.credit_micro_usd,
    spentMicroUsd: account.spent_micro_usd,
    monthlyIncludedMicroUsd: p.monthlyIncludedMicroUsd,
    allowanceSpentMicroUsd: periodBefore?.allowance_spent_micro_usd ?? 0,
  });
  let fromAllowance = 0;
  let fromCredit = 0;
  if (priced.microUsd > 0 && balance.outcome === "allow") {
    const split = allocateCharge(priced.microUsd, {
      monthlyIncludedMicroUsd: p.monthlyIncludedMicroUsd,
      allowanceSpentMicroUsd: periodBefore?.allowance_spent_micro_usd ?? 0,
    });
    fromAllowance = split.fromAllowanceMicroUsd;
    fromCredit = split.fromCreditMicroUsd;
  }
  const event: UsageEvent = {
    id: newId("use"),
    request_id: p.requestId,
    account_id: p.accountId,
    client_id: p.clientId,
    model_id: p.modelId,
    period_key: bounds.key,
    input_tokens: null,
    output_tokens: null,
    micro_usd: priced.microUsd,
    from_allowance_micro_usd: fromAllowance,
    from_credit_micro_usd: fromCredit,
    metered: true,
    unmetered_reason: null,
    upstream_status: 200,
    gateway_log_id: gatewayLogId,
  };
  await store.recordUsage(event);
}

async function rehostMusic(
  env: Env,
  p: PlaneLongRunParams,
  sourceUrl: string,
): Promise<string | null> {
  const secret = mediaSigningSecret(env);
  if (!env.MEDIA || !secret) return null;
  try {
    const res = await fetch(sourceUrl, {
      method: "GET",
      headers: { accept: "audio/*,application/octet-stream,*/*" },
      redirect: "follow",
    });
    if (!res.ok || !res.body) return null;
    const contentType = res.headers.get("content-type") ?? "audio/mpeg";
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MEDIA_MAX_BYTES) return null;
    const objectKey = newMusicObjectKey(p.accountId, p.requestId);
    await env.MEDIA.put(objectKey, res.body, {
      httpMetadata: { contentType: contentType.split(";")[0]?.trim() || "audio/mpeg" },
    });
    const downTok = await mintDownloadToken(secret, objectKey);
    return mediaPublicUrl(p.origin, `/v1/media/${downTok.token}`);
  } catch {
    return null;
  }
}

async function waitForObject(
  bucket: R2Bucket,
  objectKey: string,
  maxMs: number,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await bucket.head(objectKey)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return !!(await bucket.head(objectKey));
}

function looksLikeHttpUrl(s: string): boolean {
  return s.startsWith("https://") || s.startsWith("http://");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
