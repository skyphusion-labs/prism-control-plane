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
import { entitlesTier, planFromRow } from "./plans";
import { findModel } from "./catalog";
import { resolveUnitPrice } from "./meter";
import { FLUX_DEFAULT_UNIT_MICRO, FLUX_STT_MODEL, STT_WS_PROTOCOL } from "./flux-stt";
import { requireHandoffSecret, verifySttHandoff } from "./stt-handoff";

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
  /** AI Gateway log id, when the binding surfaced one at open. Null is honest, not a placeholder. */
  gateway_log_id: string | null;
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
    const expRaw = request.headers.get("x-prism-exp") ?? "";
    const sig = request.headers.get("x-prism-sig") ?? "";
    const acceptProtocol = request.headers.get("x-prism-ws-protocol");

    if (!accountId || !clientId || !planId || !sig || !expRaw) {
      return Response.json(
        { error: { code: "internal", message: "STT session missing signed handoff headers." } },
        { status: 500 },
      );
    }
    if (modelId !== FLUX_STT_MODEL) {
      return Response.json(
        { error: { code: "invalid_request", message: "Only Deepgram Flux is supported on this door." } },
        { status: 400 },
      );
    }

    // Fail-closed: never verify against an empty key (that would accept attacker-forged sigs).
    const handoffSecret = requireHandoffSecret(this.env.CF_AIG_TOKEN);
    if (!handoffSecret) {
      return Response.json(
        { error: { code: "unavailable", message: "CF_AIG_TOKEN missing; cannot verify STT handoff." } },
        { status: 503 },
      );
    }
    const exp = Number(expRaw);
    if (!Number.isInteger(exp) || exp <= 0) {
      return Response.json(
        { error: { code: "forbidden", message: "STT session handoff expired or malformed." } },
        { status: 403 },
      );
    }
    const ok = await verifySttHandoff(handoffSecret, {
      accountId,
      clientId,
      planId,
      requestId,
      modelId,
      exp,
    }, sig);
    if (!ok) {
      return Response.json(
        { error: { code: "forbidden", message: "STT session handoff signature invalid or expired." } },
        { status: 403 },
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
      type RunOpts = {
        websocket: boolean;
        gateway?: { id: string; metadata?: Record<string, string> };
      };
      const opts: RunOpts = { websocket: true };
      // ATTRIBUTE THE OPEN, or this door is invisible to reconciliation.
      //
      // decideAdjustment joins a gateway row to a ledger row on cf-aig-metadata.request_id. Without
      // it every live-voice row lands in `skipped: no_request_id`, a bucket whose detail string says
      // the traffic "was sent by something else on the same gateway" -- false for every session, and
      // the reason nobody would investigate it. The same fields the other doors send, minus
      // cf_token_id, which does not exist here: the upstream is the AI binding, not a minted token.
      // Cloudflare keeps the first five metadata entries and silently drops the rest; this is four.
      if (gatewayId) {
        opts.gateway = {
          id: gatewayId,
          metadata: {
            account_id: accountId,
            client_id: clientId,
            plan_id: planId,
            request_id: requestId,
          },
        };
      }

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
      // Recorded opportunistically: the binding exposes the gateway log id after a run, but a
      // websocket open may not populate it. Stored when present, absent otherwise -- never
      // fabricated, because a wrong id joins the ledger row to somebody else's gateway row.
      const gatewayLogId = (this.env.AI as unknown as { aiGatewayLogId?: string | null })
        .aiGatewayLogId;
      if (typeof gatewayLogId === "string" && gatewayLogId.length > 0) {
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO meta (k, v) VALUES ('gateway_log_id', ?)`,
          gatewayLogId,
        );
      }
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
    const gateway_log_id = map.get("gateway_log_id") ?? null;
    if (!account_id || !client_id || !plan_id || !request_id) return null;
    return {
      account_id,
      client_id,
      plan_id,
      request_id,
      model_id,
      started_ms: Number.isFinite(started_ms) ? started_ms : Date.now(),
      gateway_log_id,
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

    const rawSec = Math.max(0, (Date.now() - meta.started_ms) / 1000);
    const durationSec = Math.min(rawSec, FLUX_MAX_SESSION_MS / 1000);
    const units = billableAudioMinutes(durationSec);

    try {
      const store = d1Store(this.env.DB);

      // THE OPERATOR RATE IS THE RATE, and it is read from the same place the pre-flight gate read
      // it. Resolving with a hardcoded null override made an operator who set unit_micro_usd via
      // POST /admin/model-prices get gated at their rate and metered at the catalog's, with no
      // error -- and the gate's own `model_unpriced` refusal could never protect a meter that never
      // asked the store. The rate is still not taken from request headers, which are a tamper
      // surface; the store is not a header.
      const entry = findModel(meta.model_id);
      const priceRow = entry ? await store.getModelPrice(entry.id) : null;
      const unitPrice = entry ? resolveUnitPrice(entry, priceRow) : null;
      const unitMicro =
        unitPrice && unitPrice.unit === "audio_minute"
          ? unitPrice.microUsdPerUnit
          : FLUX_DEFAULT_UNIT_MICRO;
      const microUsd = units * unitMicro;

      // Re-validate ownership at finalize (not only at handoff): client must still exist,
      // belong to the account, not be revoked; account not suspended; plan still entitles the model.
      const client = await store.getClient(meta.client_id);
      const account = await store.getAccount(meta.account_id);
      const planRow = await store.getPlan(meta.plan_id);

      // usage_events.account_id AND usage_events.client_id are both declared foreign keys, so with
      // either row absent there is nothing writable. This is the only branch that may discard the
      // session, and it is a schema constraint rather than a policy choice.
      if (!client || !account) {
        console.error("stt finalize missing client/account, cannot write a ledger row", meta);
        return;
      }

      const now = new Date();
      const pkey = periodKey(now);

      /**
       * Record the session WITHOUT charging for it.
       *
       * Every refusal below reaches this rather than returning. The session really happened and
       * really cost us upstream, so discarding it would make it indistinguishable from a session
       * that never opened -- the same reasoning chat.ts gives for writing an unmetered row when an
       * upstream times out. It is the posture the revoke case most needs: the user whose key an
       * operator just revoked is exactly the user you want a record of.
       */
      const recordUnmetered = async (reason: string, accountId: string): Promise<void> => {
        await store.recordUsage({
          id: newId("use"),
          request_id: meta.request_id,
          account_id: accountId,
          client_id: client.id,
          model_id: meta.model_id,
          period_key: pkey,
          input_tokens: null,
          output_tokens: null,
          micro_usd: 0,
          from_allowance_micro_usd: 0,
          from_credit_micro_usd: 0,
          metered: false,
          unmetered_reason: reason,
          upstream_status: 101,
          gateway_log_id: meta.gateway_log_id,
        });
      };

      if (client.account_id !== account.id || client.account_id !== meta.account_id) {
        console.error("stt finalize client/account mismatch", meta.client_id, meta.account_id);
        // Attributed to the CLIENT's own account, which is the pair the foreign keys agree on.
        // Nothing is charged, so this records the discrepancy without billing anybody for it.
        await recordUnmetered(
          `client/account mismatch at finalize: session meta claimed account ${meta.account_id}, ` +
            `client ${client.id} belongs to ${client.account_id}. ${units} audio minute(s) served ` +
            "and deliberately not charged",
          client.account_id,
        );
        return;
      }
      if (client.revoked_at) {
        await recordUnmetered(
          `client ${client.id} was revoked before the session closed; ${units} audio minute(s) ` +
            "served and not charged",
          account.id,
        );
        return;
      }
      if (account.suspended_at) {
        await recordUnmetered(
          `account ${account.id} was suspended before the session closed; ${units} audio minute(s) ` +
            "served and not charged",
          account.id,
        );
        return;
      }
      if (!planRow) {
        await recordUnmetered(
          `plan ${meta.plan_id} no longer exists, so no allowance split can be computed; ` +
            `${units} audio minute(s) served and not charged`,
          account.id,
        );
        return;
      }
      const plan = planFromRow(planRow);
      if (!plan.ok) {
        await recordUnmetered(
          `plan ${meta.plan_id} is unusable (${plan.reason}); ${units} audio minute(s) served and ` +
            "not charged",
          account.id,
        );
        return;
      }
      const modelEntry = findModel(meta.model_id);
      if (!modelEntry || !entitlesTier(plan.plan, modelEntry.tier)) {
        await recordUnmetered(
          `model ${meta.model_id} is no longer entitled under plan ${plan.plan.id}; ${units} ` +
            "audio minute(s) served and not charged",
          account.id,
        );
        return;
      }

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
        account_id: account.id,
        client_id: client.id,
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
        gateway_log_id: meta.gateway_log_id,
      });
    } catch (err) {
      console.error("stt finalize meter failed", {
        requestId: meta.request_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
