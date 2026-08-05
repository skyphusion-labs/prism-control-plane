import { describe, expect, it } from "vitest";
import { MAX_CONTENT_CHARS, MAX_MESSAGES, parseChatRequest } from "../src/chat-request";

const valid = {
  model: "@cf/meta/llama-3.2-3b-instruct",
  messages: [{ role: "user", content: "hi" }],
};

describe("parseChatRequest", () => {
  it("accepts the minimal valid body", () => {
    const result = parseChatRequest(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stream).toBe(false);
  });

  it("accepts the full forwarded parameter set", () => {
    expect(
      parseChatRequest({ ...valid, max_tokens: 64, temperature: 0.7, top_p: 0.9, stream: true }),
    ).toMatchObject({ ok: true });
  });

  it("rejects unknown fields rather than dropping them", () => {
    // The contract promise. Silently dropping `tools` would let a client ship a feature it believes works.
    const result = parseChatRequest({ ...valid, tools: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Unknown field "tools"');
  });

  it("rejects unknown message fields", () => {
    expect(
      parseChatRequest({ ...valid, messages: [{ role: "user", content: "hi", name: "x" }] }),
    ).toMatchObject({ ok: false });
  });

  it("requires a model and a non-empty message list", () => {
    expect(parseChatRequest({ messages: valid.messages })).toMatchObject({ ok: false });
    expect(parseChatRequest({ model: "m", messages: [] })).toMatchObject({ ok: false });
    expect(parseChatRequest({ model: "   ", messages: valid.messages })).toMatchObject({ ok: false });
  });

  it("rejects an unknown role", () => {
    expect(
      parseChatRequest({ ...valid, messages: [{ role: "tool", content: "hi" }] }),
    ).toMatchObject({ ok: false });
  });

  it("rejects multi-part content arrays instead of forwarding a shape it drops", () => {
    expect(
      parseChatRequest({
        ...valid,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    ).toMatchObject({ ok: false });
  });

  it("enforces the message and content caps", () => {
    const many = Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: "user", content: "x" }));
    expect(parseChatRequest({ ...valid, messages: many })).toMatchObject({ ok: false });
    expect(
      parseChatRequest({
        ...valid,
        messages: [{ role: "user", content: "x".repeat(MAX_CONTENT_CHARS + 1) }],
      }),
    ).toMatchObject({ ok: false });
  });

  it("enforces the documented numeric ranges", () => {
    expect(parseChatRequest({ ...valid, max_tokens: 0 })).toMatchObject({ ok: false });
    expect(parseChatRequest({ ...valid, max_tokens: 1.5 })).toMatchObject({ ok: false });
    expect(parseChatRequest({ ...valid, temperature: -0.1 })).toMatchObject({ ok: false });
    // 2 is the published ceiling even though some Workers AI models accept up to 5: one portable rule
    // across the catalog beats a per-model range a client would have to look up.
    expect(parseChatRequest({ ...valid, temperature: 2.1 })).toMatchObject({ ok: false });
    expect(parseChatRequest({ ...valid, temperature: 2 })).toMatchObject({ ok: true });
    expect(parseChatRequest({ ...valid, top_p: 0 })).toMatchObject({ ok: false });
    expect(parseChatRequest({ ...valid, top_p: 1 })).toMatchObject({ ok: true });
    expect(parseChatRequest({ ...valid, top_p: 1.1 })).toMatchObject({ ok: false });
    expect(parseChatRequest({ ...valid, stream: "yes" })).toMatchObject({ ok: false });
  });

  it("rejects non-object bodies", () => {
    expect(parseChatRequest(null)).toMatchObject({ ok: false });
    expect(parseChatRequest([])).toMatchObject({ ok: false });
    expect(parseChatRequest("hi")).toMatchObject({ ok: false });
  });
});
