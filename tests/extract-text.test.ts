import { describe, expect, it } from "vitest";
import { extractText } from "../src/inference";

describe("extractText", () => {
  it("reads OpenAI chat choices message content", () => {
    expect(
      extractText({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }),
    ).toBe("ok");
  });

  it("falls back to reasoning_content when content is null", () => {
    // Measured: @cf/qwen/qwen3-30b-a3b-fp8, @cf/zai-org/glm-4.7-flash with max_tokens small.
    expect(
      extractText({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "thinking then ok",
            },
          },
        ],
      }),
    ).toBe("thinking then ok");
  });

  it("falls back to reasoning when content is null", () => {
    expect(
      extractText({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              reasoning: "step 1",
            },
          },
        ],
      }),
    ).toBe("step 1");
  });

  it("treats empty string content as empty completion not unreadable", () => {
    expect(
      extractText({
        choices: [{ message: { role: "assistant", content: "" } }],
      }),
    ).toBe("");
  });

  it("reads Anthropic content text blocks", () => {
    expect(
      extractText({
        content: [
          { type: "thinking", thinking: "nope" },
          { type: "text", text: "hello" },
        ],
      }),
    ).toBe("hello");
  });

  it("falls back to Anthropic thinking when no text block", () => {
    // Fable can burn max_tokens on thinking and omit type:text; prefer 200 + text over unreadable.
    expect(
      extractText({
        content: [{ type: "thinking", thinking: "only reasoning left" }],
        stop_reason: "max_tokens",
      }),
    ).toBe("only reasoning left");
  });

  it("reads OpenAI Responses API output_text blocks", () => {
    expect(
      extractText({
        output: [
          { type: "reasoning", content: [] },
          {
            type: "message",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
      }),
    ).toBe("ok");
  });

  it("reads Gemini candidates parts", () => {
    expect(
      extractText({
        candidates: [{ content: { parts: [{ text: "Ok" }] } }],
      }),
    ).toBe("Ok");
  });

  it("returns null when nothing extractable", () => {
    expect(extractText({ choices: [{ message: { role: "assistant" } }] })).toBeNull();
    expect(extractText({})).toBeNull();
  });
});
