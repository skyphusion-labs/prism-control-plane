// The gateway log feed: the privacy guard, the money conversion, and the parse.
//
// Three things are worth a test here and they are not equally obvious. The guard is the one a future edit
// has to delete deliberately. The conversion is where a decimal USD float from someone else's API stops
// being a float, and it is asserted on the exact values Cloudflare actually returns. The parse is where an
// absent cost becomes UNKNOWN rather than zero, which is the difference between "we could not tell" and
// "it was free" -- and the second one hands out a refund.

import { describe, expect, it, vi } from "vitest";
import {
  GatewayPayloadRefused,
  MAX_PER_PAGE,
  PAYLOAD_ENDPOINT_SUFFIXES,
  gatewayLogSource,
  guardLogPath,
  metadataOf,
  microUsdFromUsd,
  parseGatewayLogRow,
} from "../src/aig-logs";

const LOGS_PATH = "/accounts/acct/ai-gateway/gateways/prism-proxy/logs";

describe("guardLogPath", () => {
  it("refuses every stored-payload endpoint shape", () => {
    // Iterated from the exported list rather than hand-copied, so adding a payload endpoint to the
    // constant without teaching the guard about it fails here.
    for (const suffix of PAYLOAD_ENDPOINT_SUFFIXES) {
      expect(() => guardLogPath(`${LOGS_PATH}/log_1/${suffix}`)).toThrow(GatewayPayloadRefused);
      expect(() => guardLogPath(`${LOGS_PATH}/log_1/${suffix}/`)).toThrow(GatewayPayloadRefused);
    }
  });

  it("allows the metadata feed and returns the path so it cannot be forgotten", () => {
    expect(guardLogPath(LOGS_PATH)).toBe(LOGS_PATH);
    expect(guardLogPath(`${LOGS_PATH}/log_1`)).toBe(`${LOGS_PATH}/log_1`);
  });

  it("says why in the message, not just that it refused", () => {
    // The message is the only thing a future reader of a stack trace has. It has to name the invariant.
    expect(() => guardLogPath(`${LOGS_PATH}/log_1/request`)).toThrow(/cf-aig-collect-log-payload/);
  });
});

describe("microUsdFromUsd", () => {
  it("converts the values Cloudflare actually reports, exactly", () => {
    // 0.0000043 USD is 4.3 micro-USD. `Math.round(0.0000043 * 1e6)` is 4 and `toFixed(6)` truncates to 4;
    // both lose a third of a micro-USD on a single request, and rounding a real cost down to a smaller
    // number is the direction a cost-recovery product cannot afford.
    expect(microUsdFromUsd(0.0000043)).toBe(5);
    expect(microUsdFromUsd(0.01719325)).toBe(17194);
    expect(microUsdFromUsd("0.01719325")).toBe(17194);
  });

  it("rounds up, matching the meter", () => {
    expect(microUsdFromUsd(0.0000001)).toBe(1);
    expect(microUsdFromUsd("0.0000000001")).toBe(1);
    expect(microUsdFromUsd(1)).toBe(1_000_000);
    expect(microUsdFromUsd("0.000001")).toBe(1);
  });

  it("keeps an exact zero at zero rather than rounding it up to a charge", () => {
    expect(microUsdFromUsd(0)).toBe(0);
    expect(microUsdFromUsd("0.000000")).toBe(0);
  });

  it("handles exponent notation, which is how small costs stringify", () => {
    // Number.prototype.toString switches to exponent form below 1e-6, squarely inside real per-request
    // costs on cheap models, so a parser that only understood decimal points would fail on live data.
    expect((0.0000001).toString()).toBe("1e-7");
    expect(microUsdFromUsd(0.0000001)).toBe(1);
    expect(microUsdFromUsd("1e-7")).toBe(1);
    expect(microUsdFromUsd("1.5E-3")).toBe(1500);
  });

  it("returns null for anything that is not a usable non-negative decimal", () => {
    // A NEGATIVE COST IS REFUSED, not absolute-valued: the biller reporting a negative is not a refund
    // this plane knows how to reason about, and turning it positive would invent one.
    expect(microUsdFromUsd(-0.5)).toBeNull();
    expect(microUsdFromUsd("-0.5")).toBeNull();
    expect(microUsdFromUsd(undefined)).toBeNull();
    expect(microUsdFromUsd(null)).toBeNull();
    expect(microUsdFromUsd("")).toBeNull();
    expect(microUsdFromUsd("free")).toBeNull();
    expect(microUsdFromUsd(Number.NaN)).toBeNull();
    expect(microUsdFromUsd(Number.POSITIVE_INFINITY)).toBeNull();
    expect(microUsdFromUsd({})).toBeNull();
    // Above Number.MAX_SAFE_INTEGER micro-USD is a corrupt feed, and a lossy Number for it would put an
    // unrepresentable amount into the money path.
    expect(microUsdFromUsd("1e30")).toBeNull();
  });
});

describe("metadataOf", () => {
  it("reads both shapes, because both are real", () => {
    // Cloudflare's published schema types this as a string; the live API on this account returns an
    // object. Handling one and not the other makes the join silently find nothing, which looks exactly
    // like "no drift".
    expect(metadataOf({ request_id: "req_1" })).toEqual({ request_id: "req_1" });
    expect(metadataOf('{"request_id":"req_1"}')).toEqual({ request_id: "req_1" });
  });

  it("treats absent or unusable metadata as empty rather than throwing", () => {
    expect(metadataOf(null)).toEqual({});
    expect(metadataOf(undefined)).toEqual({});
    expect(metadataOf("")).toEqual({});
    expect(metadataOf("not json")).toEqual({});
    expect(metadataOf("[1,2]")).toEqual({});
    expect(metadataOf(["a"])).toEqual({});
  });
});

describe("parseGatewayLogRow", () => {
  const raw = {
    id: "log_1",
    created_at: "2026-08-05T00:00:00Z",
    model: "@cf/meta/llama-3.1-8b-instruct",
    provider: "workers-ai",
    status_code: 200,
    success: true,
    cached: false,
    tokens_in: 12,
    tokens_out: 34,
    cost: 0.0000043,
    metadata: { request_id: "req_1", account_id: "acct_1" },
  };

  it("maps a live row into this plane's units", () => {
    expect(parseGatewayLogRow(raw)).toEqual({
      id: "log_1",
      createdAt: "2026-08-05T00:00:00Z",
      model: "@cf/meta/llama-3.1-8b-instruct",
      provider: "workers-ai",
      statusCode: 200,
      success: true,
      cached: false,
      tokensIn: 12,
      tokensOut: 34,
      costMicroUsd: 5,
      requestId: "req_1",
      accountId: "acct_1",
    });
  });

  it("carries an absent cost as null, never as zero", () => {
    // `cost` is optional in Cloudflare's own schema. Reading absent as free would create a credit refund
    // out of a gap in someone else's telemetry.
    expect(parseGatewayLogRow({ ...raw, cost: undefined })?.costMicroUsd).toBeNull();
    expect(parseGatewayLogRow({ ...raw, cost: null })?.costMicroUsd).toBeNull();
    expect(parseGatewayLogRow({ ...raw, cost: 0 })?.costMicroUsd).toBe(0);
  });

  it("refuses a row with no identity or no timestamp", () => {
    // Those two are the row's identity and the watermark's only source. Without either there is nothing
    // to be idempotent on and nothing to advance from.
    expect(parseGatewayLogRow({ ...raw, id: undefined })).toBeNull();
    expect(parseGatewayLogRow({ ...raw, created_at: undefined })).toBeNull();
    expect(parseGatewayLogRow({ ...raw, created_at: "not a date" })).toBeNull();
    expect(parseGatewayLogRow(null)).toBeNull();
    expect(parseGatewayLogRow("log_1")).toBeNull();
  });

  it("reads everything else as null when absent instead of guessing", () => {
    const sparse = parseGatewayLogRow({ id: "log_1", created_at: "2026-08-05T00:00:00Z" });
    expect(sparse).toMatchObject({
      model: null,
      provider: null,
      statusCode: null,
      success: null,
      cached: false,
      tokensIn: null,
      tokensOut: null,
      costMicroUsd: null,
      requestId: null,
      accountId: null,
    });
  });
});

describe("gatewayLogSource", () => {
  function envelope(result: unknown, info: unknown = { total_count: 1 }): Response {
    return new Response(JSON.stringify({ success: true, result, result_info: info }), {
      headers: { "content-type": "application/json" },
    });
  }

  it("asks for an ascending, filtered, capped page and carries the bearer", async () => {
    const fetchImpl = vi.fn(async () => envelope([]));
    const source = gatewayLogSource({
      accountId: "acct",
      gatewayId: "prism-proxy",
      token: "cf-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await source.listSince({ sinceIso: "2026-08-05T00:00:00.000Z", page: 1, perPage: 500 });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const query = new URL(url).searchParams;
    expect(init.method).toBe("GET");
    // ASCENDING IS LOAD-BEARING: the watermark advances to the newest row actually processed, so a
    // descending feed would let a partial run step over rows it never looked at.
    expect(query.get("order_by")).toBe("created_at");
    expect(query.get("order_by_direction")).toBe("asc");
    // Clamped to Cloudflare's own ceiling. Asking for more is a 400, not a bigger page.
    expect(query.get("per_page")).toBe(String(MAX_PER_PAGE));
    expect(JSON.parse(query.get("filters") ?? "null")).toEqual([
      { key: "created_at", operator: "gt", value: ["2026-08-05T00:00:00.000Z"] },
    ]);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer cf-token");
  });

  it("counts unreadable rows instead of dropping them", async () => {
    // A page half of which could not be read is not an empty page, and the difference is the whole point:
    // silently dropping rows would report a clean reconciliation of traffic nobody looked at.
    const source = gatewayLogSource({
      accountId: "acct",
      gatewayId: "prism-proxy",
      token: "t",
      fetchImpl: (async () =>
        envelope([{ id: "log_1", created_at: "2026-08-05T00:00:00Z" }, { nope: true }, null], {
          total_count: 3,
        })) as unknown as typeof fetch,
    });
    const page = await source.listSince({ sinceIso: "2026-08-01T00:00:00Z", page: 1, perPage: 50 });
    expect(page.rows).toHaveLength(1);
    expect(page.malformed).toBe(2);
    expect(page.totalCount).toBe(3);
  });

  it("preserves Cloudflare's own error code, which is the operator's next action", async () => {
    // 9109 (the token lacks AI Gateway Read) and a 400 (bad filter) need completely different fixes, and
    // "reconcile failed" costs an afternoon.
    const source = gatewayLogSource({
      accountId: "acct",
      gatewayId: "prism-proxy",
      token: "t",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] }),
          { status: 403, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    await expect(
      source.listSince({ sinceIso: "2026-08-01T00:00:00Z", page: 1, perPage: 50 }),
    ).rejects.toThrow(/9109/);
  });

  it("throws on an unreadable body rather than reporting an empty page", async () => {
    const source = gatewayLogSource({
      accountId: "acct",
      gatewayId: "prism-proxy",
      token: "t",
      fetchImpl: (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch,
    });
    await expect(
      source.listSince({ sinceIso: "2026-08-01T00:00:00Z", page: 1, perPage: 50 }),
    ).rejects.toThrow(/502/);
  });

  it("never builds a payload URL, whatever the gateway id looks like", async () => {
    // The gateway id is interpolated into the path, so a slug carrying a slash is the one input that
    // could smuggle a payload endpoint past the guard. It is encoded, so it cannot.
    const fetchImpl = vi.fn(async () => envelope([]));
    const source = gatewayLogSource({
      accountId: "acct",
      gatewayId: "gw/log_1/request",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await source.listSince({ sinceIso: "2026-08-01T00:00:00Z", page: 1, perPage: 50 });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(new URL(url).pathname.endsWith("/logs")).toBe(true);
  });
});
