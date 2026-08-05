// AI Gateway OpenAI-compatible model list (rate card).
//
// GET gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat/models
// with cf-aig-authorization. Returns cost_in / cost_out as USD per token for
// Unified Billing and Workers AI models. This plane converts those into
// integer micro-USD per MTok and writes them to model_prices (see catalog-refresh.ts).
//
// SEPARATE from aig-logs.ts (log feed) and cf-api.ts (token mint). Same credential
// (CF_AIG_TOKEN), different surface: this file cannot read payloads or mint tokens.

/** One row from GET .../compat/models. */
export interface GatewayModelRate {
  /** Gateway model id, e.g. workers-ai/@cf/meta/llama-3.2-3b-instruct or openai/gpt-5.5. */
  id: string;
  /** USD per input token (may be 0). */
  costInUsdPerToken: number;
  /** USD per output token (may be 0). */
  costOutUsdPerToken: number;
  ownedBy: string | null;
}

export interface GatewayModelsPage {
  models: GatewayModelRate[];
  /** Rows that could not be parsed. Counted, never silently dropped. */
  malformed: number;
}

export interface GatewayModelSource {
  listRates(): Promise<GatewayModelsPage>;
}

export interface GatewayModelSourceDeps {
  accountId: string;
  gatewayId: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * Parse one compat/models data element.
 *
 * cost_in / cost_out are required numbers (>= 0). Absent or non-finite is malformed.
 */
export function parseGatewayModelRate(raw: unknown): GatewayModelRate | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id || id.length > 256) return null;
  const costIn = row.cost_in;
  const costOut = row.cost_out;
  if (typeof costIn !== "number" || !Number.isFinite(costIn) || costIn < 0) return null;
  if (typeof costOut !== "number" || !Number.isFinite(costOut) || costOut < 0) return null;
  const ownedBy =
    typeof row.owned_by === "string" && row.owned_by.trim() ? row.owned_by.trim() : null;
  return {
    id,
    costInUsdPerToken: costIn,
    costOutUsdPerToken: costOut,
    ownedBy,
  };
}

/**
 * USD-per-token → integer micro-USD per million tokens.
 *
 * cost_in from compat/models is ~1e-8..1e-5 USD/token. That is far below 1 micro-USD per token, so
 * composing with aig-logs' microUsdFromUsd (USD→micro, scale 1e6) collapses every cheap rate to 1
 * micro then * 1e6 = wrong. Scale by 1e12 in one BigInt step instead (USD/token → micro/MTok).
 *
 * Rounds UP on any fractional remainder (cost-recovery; same posture as meter.ts / aig-logs).
 */
export function microUsdPerMTokFromUsdPerToken(usdPerToken: number): number | null {
  if (typeof usdPerToken !== "number" || !Number.isFinite(usdPerToken) || usdPerToken < 0) {
    return null;
  }
  if (usdPerToken === 0) return 0;

  const text = usdPerToken.toString();
  const match = /^\+?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const intPart = match[1] ?? "";
  const fracPart = match[2] ?? "";
  if (!intPart && !fracPart) return null;
  const expAdj = match[3] ? Number(match[3]) : 0;
  if (!Number.isInteger(expAdj) || Math.abs(expAdj) > 60) return null;

  const digits = BigInt(`${intPart || "0"}${fracPart}`);
  // digits * 10^(expAdj - fracLen + 12)
  const exponent = expAdj - fracPart.length + 12;
  let scaled: bigint;
  if (exponent >= 0) {
    scaled = digits * 10n ** BigInt(exponent);
  } else {
    const divisor = 10n ** BigInt(-exponent);
    const whole = digits / divisor;
    const remainder = digits % divisor;
    scaled = remainder === 0n ? whole : whole + 1n;
  }
  if (scaled < 0n || scaled > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(scaled);
}

/**
 * Live gateway model rate source.
 *
 * Auth: cf-aig-authorization on the gateway host (same as spend), not Authorization alone.
 */
export function gatewayModelSource(deps: GatewayModelSourceDeps): GatewayModelSource {
  const doFetch = deps.fetchImpl ?? fetch;
  const accountId = deps.accountId.trim();
  const gatewayId = deps.gatewayId.trim();
  return {
    async listRates() {
      const url =
        `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/` +
        `${encodeURIComponent(gatewayId)}/compat/models`;
      const res = await doFetch(url, {
        method: "GET",
        headers: {
          "cf-aig-authorization": `Bearer ${deps.token}`,
          accept: "application/json",
        },
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 400);
        throw new Error(`compat/models: HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new Error("compat/models: unparseable JSON body");
      }
      if (!body || typeof body !== "object") {
        throw new Error("compat/models: body is not an object");
      }
      const data = (body as { data?: unknown }).data;
      if (!Array.isArray(data)) {
        throw new Error("compat/models: missing data array");
      }
      const models: GatewayModelRate[] = [];
      let malformed = 0;
      for (const row of data) {
        const parsed = parseGatewayModelRate(row);
        if (parsed) models.push(parsed);
        else malformed += 1;
      }
      return { models, malformed };
    },
  };
}
