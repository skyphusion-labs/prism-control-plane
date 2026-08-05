// Conversational STT session Durable Object -- Deepgram Flux live mic.
//
// Mirrors prism's SttSession shape: browser/native WS <-> DO <-> flux WS via
// env.AI.run({ websocket: true }). Differences for the control plane:
//   - Identity is a Prism client key (resolved in the Worker before the DO).
//   - On close we meter audio minutes to D1; we do NOT store transcript text
//     (privacy invariant: no prompt/completion/transcript columns).
//   - Gateway routing: AI binding with gateway id when AI_GATEWAY_ID is set.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { billableAudioMinutes, sanitizeCloseCode } from "./stt-util";
import { d1Store } from "./store-d1";
import { newId } from "./crypto";
import { periodKey } from "./period";
import { allocateCharge } from "./balance";
import { planFromRow } from "./plans";
import { findModel } from "./catalog";
import { resolveUnitPrice } from "./meter";
import { FLUX_DEFAULT_UNIT_MICRO, FLUX_STT_MODEL, STT_WS_PROTOCOL } from "./flux-stt";

export { FLUX_DEFAULT_UNIT_MICRO, FLUX_STT_MODEL, STT_WS_PROTOCOL } from "./flux-stt";

/** Hard wall-clock cap so an idle open socket cannot bill forever (audit medium). */
export const FLUX_MAX_SESSION_MS = 15 * 60 * 1000;

interface FluxRunResult {
  webSocket?: WebSocket | null;
}

interface SessionMeta {
  account_id: string;
  client_id: string;
  plan_id: string;
  request_id: string;
  model_id: string;
  started_ms: number;
}

export class SttSession extends DurableObject<Env> {
  private upstream: WebSocket | null = null;
  private finalized = false;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    // Headers set by the Worker after client-key auth. Missing any is a wiring bug.
    // Unit rate is NOT passed in headers (tamper surface); resolved from catalog at finalize.
    const accountId = request.headers.get("x-prism-account-id") ?? "";
    const clientId = request.headers.get("x-prism-client-id") ?? "";
    const planId = request.headers.get("x-prism-plan-id") ?? "";
    const requestId = request.headers.get("x-prism-request-id") ?? newId("req");
    const modelId = request.headers.get("x-prism-model-id") ?? FLUX_STT_MODEL;
    const acceptProtocol = request.headers.get("x-prism-ws-protocol");

    if (!accountId || !clientId || !planId) {
      return Response.json(
        { error: { code: "internal", message: "STT session missing attribution headers." } },
        { status: 500 },
      );
    }
    if (modelId !== FLUX_STT_MODEL) {
      return Response.json(
        { error: { code: "invalid_request", message: "Only Deepgram Flux is supported on this door." } },
        { status: 400 },
      );
    }

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO meta (k, v) VALUES
         ('account_id', ?), ('client_id', ?), ('plan_id', ?),
         ('request_id', ?), ('model_id', ?), ('started_ms', ?)`,
      accountId,
      clientId,
      planId,
      requestId,
      modelId,
      String(Date.now()),
    );

    if (!this.env.AI) {
      return Response.json(
        {
          error: {
            code: "unavailable",
            message:
              "Deepgram Flux requires the Worker AI binding. Add [ai] binding = \"AI\" to wrangler config.",
          },
        },
        { status: 503 },
      );
    }

    let upstream: WebSocket | null;
    try {
      const gatewayId = (this.env.AI_GATEWAY_ID ?? "").trim();
      type RunOpts = { websocket: boolean; gateway?: { id: string } };
      const opts: RunOpts = { websocket: true };
      if (gatewayId) opts.gateway = { id: gatewayId };

      const resp = (await (
        this.env.AI as unknown as {
          run: (m: string, p: unknown, o: RunOpts) => Promise<FluxRunResult>;
        }
      ).run(
        FLUX_STT_MODEL,
        { encoding: "linear16", sample_rate: "16000" },
        opts,
      ));
      upstream = resp?.webSocket ?? null;
    } catch (err) {
      return Response.json(
        {
          error: {
            code: "upstream_error",
            message: `Flux upstream open failed: ${err instanceof Error ? err.message : String(err)}`.slice(
              0,
              300,
            ),
          },
        },
        { status: 502 },
      );
    }
    if (!upstream) {
      return Response.json(
        { error: { code: "upstream_error", message: "Flux did not return a WebSocket." } },
        { status: 502 },
      );
    }
    upstream.accept();
    this.upstream = upstream;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    // Cap wall-clock session so an idle hold cannot bill unbounded minutes.
    this.maxTimer = setTimeout(() => {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "session max duration");
        } catch {
          /* */
        }
      }
      try {
        this.upstream?.close(1000, "session max duration");
      } catch {
        /* */
      }
      void this.finalize();
    }, FLUX_MAX_SESSION_MS);

    upstream.addEventListener("message", (e: MessageEvent) => {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(e.data);
        } catch {
          /* peer gone */
        }
      }
    });
    upstream.addEventListener("close", (e: CloseEvent) => {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(sanitizeCloseCode(e.code), e.reason);
        } catch {
          /* */
        }
      }
    });
    upstream.addEventListener("error", () => {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1011, "upstream error");
        } catch {
          /* */
        }
      }
    });

    const headers = new Headers();
    if (acceptProtocol === STT_WS_PROTOCOL) {
      headers.set("Sec-WebSocket-Protocol", STT_WS_PROTOCOL);
    }
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.upstream) {
      try {
        this.upstream.send(message);
      } catch {
        /* upstream gone */
      }
      return;
    }
    try {
      _ws.close(1011, "session expired");
    } catch {
      /* */
    }
    await this.finalize();
  }

  async webSocketClose(_ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      this.upstream?.close(sanitizeCloseCode(code), reason);
    } catch {
      /* */
    }
    this.upstream = null;
    await this.finalize();
  }

  async webSocketError(_ws: WebSocket): Promise<void> {
    try {
      this.upstream?.close(1011);
    } catch {
      /* */
    }
    this.upstream = null;
    await this.finalize();
  }

  private readMeta(): SessionMeta | null {
    const rows = this.ctx.storage.sql
      .exec<{ k: string; v: string }>(`SELECT k, v FROM meta`)
      .toArray();
    const map = new Map(rows.map((r) => [r.k, r.v]));
    const account_id = map.get("account_id");
    const client_id = map.get("client_id");
    const plan_id = map.get("plan_id");
    const request_id = map.get("request_id");
    const model_id = map.get("model_id") ?? FLUX_STT_MODEL;
    const started_ms = Number(map.get("started_ms") ?? Date.now());
    if (!account_id || !client_id || !plan_id || !request_id) return null;
    return {
      account_id,
      client_id,
      plan_id,
      request_id,
      model_id,
      started_ms: Number.isFinite(started_ms) ? started_ms : Date.now(),
    };
  }

  /**
   * Charge audio minutes for the session. No transcript is written (privacy).
   * Idempotent: close + error can both fire.
   * Duration is wall-clock capped at FLUX_MAX_SESSION_MS; unit rate from catalog, not headers.
   */
  private async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }

    const meta = this.readMeta();
    if (!meta) {
      console.error("stt finalize missing meta");
      return;
    }

    const entry = findModel(meta.model_id);
    const unitPrice = entry ? resolveUnitPrice(entry, null) : null;
    const unitMicro =
      unitPrice && unitPrice.unit === "audio_minute"
        ? unitPrice.microUsdPerUnit
        : FLUX_DEFAULT_UNIT_MICRO;

    const rawSec = Math.max(0, (Date.now() - meta.started_ms) / 1000);
    const durationSec = Math.min(rawSec, FLUX_MAX_SESSION_MS / 1000);
    const units = billableAudioMinutes(durationSec);
    const microUsd = units * unitMicro;

    try {
      const store = d1Store(this.env.DB);
      const account = await store.getAccount(meta.account_id);
      const planRow = await store.getPlan(meta.plan_id);
      if (!account || !planRow) {
        console.error("stt finalize missing account/plan", meta.account_id, meta.plan_id);
        return;
      }
      const plan = planFromRow(planRow);
      if (!plan.ok) {
        console.error("stt finalize plan unusable", plan.reason);
        return;
      }

      const now = new Date();
      const pkey = periodKey(now);
      const period = await store.getPeriod(account.id, pkey);
      const split =
        microUsd > 0
          ? allocateCharge(microUsd, {
              monthlyIncludedMicroUsd: plan.plan.monthlyIncludedMicroUsd,
              allowanceSpentMicroUsd: period?.allowance_spent_micro_usd ?? 0,
            })
          : { fromAllowanceMicroUsd: 0, fromCreditMicroUsd: 0 };

      await store.recordUsage({
        id: newId("use"),
        request_id: meta.request_id,
        account_id: meta.account_id,
        client_id: meta.client_id,
        model_id: meta.model_id,
        period_key: pkey,
        input_tokens: null,
        output_tokens: null,
        micro_usd: microUsd,
        from_allowance_micro_usd: split.fromAllowanceMicroUsd,
        from_credit_micro_usd: split.fromCreditMicroUsd,
        metered: true,
        unmetered_reason: null,
        upstream_status: 101,
        gateway_log_id: null,
      });
    } catch (err) {
      console.error("stt finalize meter failed", {
        requestId: meta.request_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
