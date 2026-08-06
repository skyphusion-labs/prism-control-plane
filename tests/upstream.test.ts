// The spend path's shape: where the request goes, what it carries, and what it refuses to carry.
//
// These tests exist because of issue #15. The plane shipped believing it was behind its AI Gateway while
// naming the gateway only in a request header, and the header turned out to be unverifiable from the
// response: no `cf-aig-log-id` came back, and a deliberately invalid gateway credential was answered 200.
// Nothing in the suite could have caught that, because nothing asserted where the request went.
//
// So the first test is the anti-bypass test. It pins the HOST, not the header. If a future edit moves this
// file back to `api.cloudflare.com`, or reaches for the `env.AI` binding, it fails here and has to argue
// with the comment at the top of src/upstream.ts rather than land quietly.

import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_HOST,
  bindingChatBody,
  endpointFor,
  isAllowedBindingChatModel,
  responsesBody,
  responsesUrl,
  runnerFor,
  upstreamBody,
  upstreamHeaders,
  upstreamUrl,
  type GatewayRunnerDeps,
} from "../src/upstream";
import type { InferenceRequest } from "../src/inference";

const DEPS: GatewayRunnerDeps = {
  accountId: "acct_1",
  gatewayId: "prism-proxy",
  timeoutMs: 5_000,
  collectLog: true,
};

function request(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    upstreamModel: "@cf/meta/llama-3.2-1b-instruct",
    billing: "workers-ai",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 16,
    stream: false,
    auth: { tokenId: "tok_1", value: "secret-token-value" },
    metadata: { account_id: "acc_1", request_id: "req_1" },
    ...overrides,
  };
}

/** A fetch that records the one call it was given and answers with a canned response. */
function fakeFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe("where the request goes", () => {
  it("always addresses the AI Gateway host, never the AI REST API", () => {
    // The invariant issue #15 cost us. `api.cloudflare.com` routes and logs but returns no transit
    // receipt and does not enforce the gateway's own authentication, so it cannot be the spend path.
    for (const billing of ["workers-ai", "unified-billing"] as const) {
      const url = upstreamUrl(DEPS, billing);
      expect(url.startsWith(`${GATEWAY_HOST}/v1/acct_1/prism-proxy/`)).toBe(true);
      expect(url).not.toContain("api.cloudflare.com");
    }
  });

  it("sends Workers AI models to the provider-native endpoint", () => {
    expect(upstreamUrl(DEPS, "workers-ai")).toBe(
      `${GATEWAY_HOST}/v1/acct_1/prism-proxy/workers-ai/v1/chat/completions`,
    );
  });

  it("sends third-party Unified Billing models to the OpenAI-compatible endpoint", () => {
    // The other half of the catalog. Every third-party entry is `provider/model`, which is the id the
    // compat endpoint routes on, so the body needs no transform to reach a Claude or a Gemini.
    expect(upstreamUrl(DEPS, "unified-billing")).toBe(
      `${GATEWAY_HOST}/v1/acct_1/prism-proxy/compat/chat/completions`,
    );
  });

  it("encodes the gateway slug, so deployer config cannot rewrite the endpoint path", () => {
    expect(upstreamUrl({ ...DEPS, gatewayId: "a/b" }, "workers-ai")).toBe(
      `${GATEWAY_HOST}/v1/acct_1/a%2Fb/workers-ai/v1/chat/completions`,
    );
  });

  it("has an endpoint for every billing surface", () => {
    expect(endpointFor("workers-ai")).toContain("chat/completions");
    expect(endpointFor("unified-billing")).toContain("chat/completions");
  });
});

describe("upstreamHeaders", () => {
  it("puts the credential in cf-aig-authorization and NOWHERE else", () => {
    // On /compat the plain `authorization` header is the provider key slot. A Cloudflare API token there
    // would be forwarded to Anthropic or OpenAI as BYOK: a credential disclosure that also switches the
    // request off Unified Billing. Keyless is sufficient on both endpoints.
    const headers = upstreamHeaders(request(), DEPS);
    expect(headers["cf-aig-authorization"]).toBe("Bearer secret-token-value");
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("x-api-key");
  });

  it("does not name the gateway in a header, because the URL already does", () => {
    // `cf-aig-gateway-id` is meaningful only on the REST API. Carrying it here would suggest the routing
    // decision lives in two places.
    expect(upstreamHeaders(request(), DEPS)["cf-aig-gateway-id"]).toBeUndefined();
  });

  it("hard-wires payload collection off, on both switch positions of the other header", () => {
    // The privacy invariant. `collectLog` decides whether the METADATA row exists; it must never be able
    // to turn payload storage back on.
    expect(upstreamHeaders(request(), DEPS)["cf-aig-collect-log-payload"]).toBe("false");
    expect(
      upstreamHeaders(request(), { ...DEPS, collectLog: false })["cf-aig-collect-log-payload"],
    ).toBe("false");
  });

  it("passes the metadata row switch through", () => {
    expect(upstreamHeaders(request(), DEPS)["cf-aig-collect-log"]).toBe("true");
    expect(upstreamHeaders(request(), { ...DEPS, collectLog: false })["cf-aig-collect-log"]).toBe(
      "false",
    );
  });

  it("carries the attribution ids as JSON and nothing else", () => {
    const parsed = JSON.parse(upstreamHeaders(request(), DEPS)["cf-aig-metadata"] ?? "{}");
    expect(parsed).toEqual({ account_id: "acc_1", request_id: "req_1" });
  });

  it("asks for SSE only when streaming", () => {
    expect(upstreamHeaders(request(), DEPS).accept).toBe("application/json");
    expect(upstreamHeaders(request({ stream: true }), DEPS).accept).toBe("text/event-stream");
  });
});

describe("upstreamBody", () => {
  it("asks for the trailing usage frame on a stream", () => {
    // Without this a streamed request cannot be priced at all: the counts only arrive in that frame.
    expect(upstreamBody(request({ stream: true }))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("omits stream fields and unset sampling params entirely", () => {
    const body = upstreamBody(request());
    expect(body.stream).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body).toMatchObject({ model: "@cf/meta/llama-3.2-1b-instruct", max_tokens: 16 });
  });

  it("uses max_completion_tokens for openai/* , xai/* , and grok/* models", () => {
    // Issue #10: 5.6 family and o4-mini reject max_tokens; Grok expects max_completion_tokens.
    // Compat upstream for Grok is grok/* (provider slug); xai/* remains for binding ids.
    expect(
      upstreamBody(request({ upstreamModel: "openai/gpt-5.6-terra", billing: "unified-billing" })),
    ).toMatchObject({ max_completion_tokens: 16 });
    expect(
      upstreamBody(request({ upstreamModel: "openai/gpt-5.6-terra", billing: "unified-billing" })),
    ).not.toHaveProperty("max_tokens");
    expect(
      upstreamBody(request({ upstreamModel: "xai/grok-4.3", billing: "unified-billing" })),
    ).toMatchObject({ max_completion_tokens: 16 });
    expect(
      upstreamBody(request({ upstreamModel: "grok/grok-4.3", billing: "unified-billing" })),
    ).toMatchObject({ max_completion_tokens: 16 });
    expect(
      upstreamBody(request({ upstreamModel: "anthropic/claude-haiku-4-5", billing: "unified-billing" })),
    ).toMatchObject({ max_tokens: 16 });
  });

  it("passes sampling params through when the client set them", () => {
    expect(upstreamBody(request({ temperature: 0, topP: 0.5 }))).toMatchObject({
      temperature: 0,
      top_p: 0.5,
    });
  });
});

describe("bindingChatBody", () => {
  it("builds Anthropic Messages shape for anthropic/* binding models", () => {
    const body = bindingChatBody(
      request({
        bindingModel: "anthropic/claude-fable-5",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
        maxTokens: 64,
      }),
    );
    expect(body).toMatchObject({
      max_tokens: 64,
      system: "be brief",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("builds Chat Completions shape for xai/* binding models", () => {
    const body = bindingChatBody(
      request({
        bindingModel: "xai/grok-4.5",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 32,
        stream: true,
      }),
    );
    expect(body).toMatchObject({
      max_completion_tokens: 32,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }],
    });
  });
});

describe("runnerFor binding path", () => {
  it("uses env.AI.run with gateway id and does not fetch HTTP when bindingModel is set", async () => {
    const run = vi.fn(async () => ({
      choices: [{ message: { content: "bound" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { impl, calls } = fakeFetch(new Response("should-not-fetch"));
    const result = await runnerFor({
      ...DEPS,
      fetchImpl: impl,
      ai: { run } as unknown as Ai,
    }).run(
      request({
        bindingModel: "xai/grok-4.5",
        upstreamModel: "grok/grok-4.5",
        billing: "unified-billing",
      }),
    );
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(extractOkText(result.body)).toBe("bound");
    }
    expect(calls).toHaveLength(0);
    expect(run).toHaveBeenCalledWith(
      "xai/grok-4.5",
      expect.objectContaining({ max_completion_tokens: 16 }),
      { gateway: { id: "prism-proxy" } },
    );
  });

  it("fails closed when bindingModel is set but AI binding is missing", async () => {
    const result = await runnerFor({ ...DEPS, fetchImpl: fakeFetch(new Response("{}")).impl }).run(
      request({ bindingModel: "anthropic/claude-fable-5" }),
    );
    expect(result.outcome).toBe("upstream_error");
    if (result.outcome === "upstream_error") {
      expect(result.detail).toMatch(/AI binding/i);
    }
  });

  it("refuses bindingModel ids that are not catalog binding:true", async () => {
    const run = vi.fn(async () => ({ choices: [{ message: { content: "nope" } }] }));
    const result = await runnerFor({
      ...DEPS,
      ai: { run } as unknown as Ai,
    }).run(request({ bindingModel: "anthropic/claude-sonnet-5" }));
    expect(result.outcome).toBe("upstream_error");
    if (result.outcome === "upstream_error") {
      expect(result.detail).toMatch(/not allowlisted/i);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("allowlists only catalog binding:true chat ids", () => {
    expect(isAllowedBindingChatModel("anthropic/claude-fable-5")).toBe(true);
    expect(isAllowedBindingChatModel("xai/grok-4.5")).toBe(true);
    expect(isAllowedBindingChatModel("google/gemini-3.1-pro")).toBe(true);
    // multi-agent: Responses body via env.AI.run (HTTP responses is 401 keyless)
    expect(isAllowedBindingChatModel("xai/grok-4.20-multi-agent-0309")).toBe(true);
    expect(isAllowedBindingChatModel("anthropic/claude-sonnet-5")).toBe(false);
    expect(isAllowedBindingChatModel("xai/grok-4.3")).toBe(false);
    expect(isAllowedBindingChatModel("evil/model")).toBe(false);
  });

  it("buffers anthropic binding stream:true via non-stream AI.run then OpenAI SSE", async () => {
    // Device path: native Anthropic SSE is flaky; non-stream body is reliable.
    const run = vi.fn(async () => ({
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "pong" },
      ],
      usage: { input_tokens: 9, output_tokens: 4 },
    }));
    const result = await runnerFor({
      ...DEPS,
      ai: { run } as unknown as Ai,
    }).run(
      request({
        bindingModel: "anthropic/claude-fable-5",
        stream: true,
      }),
    );
    expect(result.outcome).toBe("stream");
    if (result.outcome !== "stream") return;
    const text = await new Response(result.stream).text();
    expect(text).toContain('"content":"pong"');
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("data: [DONE]");
    expect(text).toContain('"prompt_tokens":9');
    expect(text).toContain('"completion_tokens":4');
    expect(text).not.toContain("content_block_delta");
    // Non-stream body: no stream:true on the binding call.
    expect(run).toHaveBeenCalledWith(
      "anthropic/claude-fable-5",
      expect.not.objectContaining({ stream: true }),
      { gateway: { id: "prism-proxy" } },
    );
  });
});

describe("responsesBody / responsesUrl", () => {
  it("targets the OpenAI Responses path on the gateway host", () => {
    expect(responsesUrl(DEPS)).toBe(
      `${GATEWAY_HOST}/v1/acct_1/prism-proxy/openai/v1/responses`,
    );
  });

  it("targets grok/v1/responses for multi-agent models", () => {
    expect(
      responsesUrl(
        DEPS,
        request({ upstreamModel: "grok/grok-4.20-multi-agent-0309", api: "responses" }),
      ),
    ).toBe(`${GATEWAY_HOST}/v1/acct_1/prism-proxy/grok/v1/responses`);
  });

  it("strips openai/ prefix and maps system to instructions", () => {
    const body = responsesBody(
      request({
        upstreamModel: "openai/gpt-5.5-pro",
        api: "responses",
        billing: "unified-billing",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
        maxTokens: 64,
      }),
    );
    expect(body).toMatchObject({
      model: "gpt-5.5-pro",
      instructions: "be brief",
      max_output_tokens: 64,
      input: [{ role: "user", content: "hi" }],
    });
  });

  it("builds multi-agent Responses body without max_output_tokens", () => {
    const body = responsesBody(
      request({
        upstreamModel: "grok/grok-4.20-multi-agent-0309",
        api: "responses",
        billing: "unified-billing",
        messages: [{ role: "user", content: "research ok" }],
        maxTokens: 64,
      }),
    );
    expect(body).toMatchObject({
      model: "grok-4.20-multi-agent-0309",
      input: [{ role: "user", content: "research ok" }],
      reasoning: { effort: "low" },
    });
    expect(body).not.toHaveProperty("max_output_tokens");
  });

  it("POSTs to responses URL when api is responses", async () => {
    const { impl, calls } = fakeFetch(
      new Response(
        JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        }),
        { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": "01R" } },
      ),
    );
    const result = await runnerFor({ ...DEPS, fetchImpl: impl }).run(
      request({
        upstreamModel: "openai/gpt-5.5-pro",
        api: "responses",
        billing: "unified-billing",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(result.outcome).toBe("ok");
    expect(calls[0]?.url).toBe(`${GATEWAY_HOST}/v1/acct_1/prism-proxy/openai/v1/responses`);
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent.model).toBe("gpt-5.5-pro");
    expect(sent.max_output_tokens).toBe(16);
  });

  it("POSTs multi-agent to grok/v1/responses", async () => {
    const { impl, calls } = fakeFetch(
      new Response(
        JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        }),
        { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": "01M" } },
      ),
    );
    await runnerFor({ ...DEPS, fetchImpl: impl }).run(
      request({
        upstreamModel: "grok/grok-4.20-multi-agent-0309",
        api: "responses",
        billing: "unified-billing",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(calls[0]?.url).toBe(`${GATEWAY_HOST}/v1/acct_1/prism-proxy/grok/v1/responses`);
  });
});

function extractOkText(body: unknown): string {
  const c = (body as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]
    ?.message?.content;
  return typeof c === "string" ? c : "";
}

describe("runnerFor", () => {
  it("reads the transit receipt off the response", () => {
    // `cf-aig-log-id` is the proof this call went through the gateway, and the join key onto the log row
    // reconciliation reads.
    const { impl, calls } = fakeFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
        headers: { "content-type": "application/json", "cf-aig-log-id": "01LOG" },
      }),
    );
    return runnerFor({ ...DEPS, fetchImpl: impl })
      .run(request())
      .then((result) => {
        expect(result).toMatchObject({ outcome: "ok", gatewayLogId: "01LOG" });
        expect(calls[0]?.url).toBe(
          `${GATEWAY_HOST}/v1/acct_1/prism-proxy/workers-ai/v1/chat/completions`,
        );
        expect(headersOf(calls[0]?.init ?? {})["cf-aig-authorization"]).toBe(
          "Bearer secret-token-value",
        );
      });
  });

  it("routes a third-party model to the compat endpoint", async () => {
    const { impl, calls } = fakeFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
        headers: { "content-type": "application/json", "cf-aig-log-id": "01LOG" },
      }),
    );
    await runnerFor({ ...DEPS, fetchImpl: impl }).run(
      request({ upstreamModel: "anthropic/claude-haiku-4-5", billing: "unified-billing" }),
    );
    expect(calls[0]?.url).toBe(`${GATEWAY_HOST}/v1/acct_1/prism-proxy/compat/chat/completions`);
  });

  it("carries the log id on a stream too", async () => {
    // Measured 2026-08-05: unlike the legacy provider paths, this endpoint DOES return the log id on SSE,
    // so a streamed turn no longer has to land in the ledger with a null gateway_log_id.
    const { impl } = fakeFetch(
      new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream", "cf-aig-log-id": "01STREAM" },
      }),
    );
    const result = await runnerFor({ ...DEPS, fetchImpl: impl }).run(request({ stream: true }));
    expect(result).toMatchObject({ outcome: "stream", gatewayLogId: "01STREAM" });
  });

  it("says so loudly when the gateway serves a request it did not log", async () => {
    // This is the shape of the failure issue #15 was: served, billed, and invisible to reconciliation.
    // It is not turned into a client error -- the completion is already paid for -- but it must not be
    // silent, because silence is indistinguishable from a clean window.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { impl } = fakeFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await runnerFor({ ...DEPS, fetchImpl: impl }).run(request());
    expect(result).toMatchObject({ outcome: "ok", gatewayLogId: null });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("no cf-aig-log-id"),
      expect.objectContaining({ gatewayId: "prism-proxy", requestId: "req_1" }),
    );
    error.mockRestore();
  });

  it("stays quiet about a missing log id when logging is deliberately off", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { impl } = fakeFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await runnerFor({ ...DEPS, collectLog: false, fetchImpl: impl }).run(request());
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("preserves the gateway's own status and body on a refusal", async () => {
    // A 401 here is the gateway rejecting OUR credential (authentication is ON), which is a completely
    // different operator action from a provider 429. Both have to survive to the operator log.
    const { impl } = fakeFetch(
      new Response(JSON.stringify({ errors: [{ code: 2009, message: "AiGatewayError" }] }), {
        status: 401,
      }),
    );
    const result = await runnerFor({ ...DEPS, fetchImpl: impl }).run(request());
    expect(result).toMatchObject({ outcome: "upstream_error", status: 401 });
    expect(result).toMatchObject({ detail: expect.stringContaining("2009") });
  });

  it("reports a timeout as a timeout, not as an upstream error", async () => {
    const impl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const result = await runnerFor({ ...DEPS, timeoutMs: 1_234, fetchImpl: impl }).run(request());
    expect(result).toEqual({ outcome: "timeout", waitedMs: 1_234 });
  });

  it("reports an unparseable success body as an upstream error", async () => {
    const { impl } = fakeFetch(
      new Response("not json", { status: 200, headers: { "cf-aig-log-id": "01LOG" } }),
    );
    const result = await runnerFor({ ...DEPS, fetchImpl: impl }).run(request());
    expect(result).toMatchObject({ outcome: "upstream_error", status: 200 });
  });
});
