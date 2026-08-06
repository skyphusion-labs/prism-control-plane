import { describe, expect, it } from "vitest";
import {
  AnthropicSseToOpenAI,
  anthropicPayloadToOpenAIFrames,
  anthropicSseToOpenAIStream,
  newAnthropicToOpenAIState,
} from "../src/anthropic-sse-to-openai";
import { SseUsageScanner } from "../src/stream";

const MODEL = "anthropic/claude-fable-5";

function framesFromPayloads(payloads: unknown[]): string {
  const state = newAnthropicToOpenAIState({ model: MODEL, id: "chatcmpl-test", created: 1_700_000_000 });
  let out = "";
  for (const p of payloads) out += anthropicPayloadToOpenAIFrames(state, p);
  return out;
}

describe("anthropicPayloadToOpenAIFrames", () => {
  it("maps text_delta to OpenAI choices[].delta.content", () => {
    const out = framesFromPayloads([
      {
        type: "message_start",
        message: {
          id: "msg_abc",
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Hello" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: " world" },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 8 },
      },
      { type: "message_stop" },
    ]);

    expect(out).toContain('"delta":{"content":"Hello"}');
    expect(out).toContain('"delta":{"content":" world"}');
    expect(out).not.toContain("thinking_delta");
    expect(out).not.toContain("hmm");
    expect(out).toContain("data: [DONE]");
    expect(out).toContain('"prompt_tokens":12');
    expect(out).toContain('"completion_tokens":8');
    expect(out).toContain('"finish_reason":"stop"');
  });

  it("drops thinking-only stream content but still finishes with [DONE]", () => {
    const out = framesFromPayloads([
      {
        type: "message_start",
        message: { usage: { input_tokens: 3, output_tokens: 1 } },
      },
      {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "only thoughts" },
      },
      { type: "message_delta", usage: { output_tokens: 40 } },
      { type: "message_stop" },
    ]);
    expect(out).toContain("data: [DONE]");
    expect(out).toContain('"role":"assistant"');
    expect(out).not.toContain("only thoughts");
  });
});

describe("AnthropicSseToOpenAI incremental", () => {
  it("handles a usage object split across chunks", () => {
    const t = new AnthropicSseToOpenAI({ model: MODEL, id: "chatcmpl-split", created: 1 });
    const part1 = new TextEncoder().encode(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n' +
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n' +
        'data: {"type":"message_delta","usage":{"output_tok',
    );
    const part2 = new TextEncoder().encode(
      'ens":4}}\n\ndata: {"type":"message_stop"}\n\n',
    );
    const a = new TextDecoder().decode(t.push(part1));
    const b = new TextDecoder().decode(t.push(part2));
    const c = new TextDecoder().decode(t.end());
    const all = a + b + c;
    expect(all).toContain('"content":"ok"');
    expect(all).toContain('"completion_tokens":4');
    expect(all).toContain("data: [DONE]");
  });
});

describe("anthropicSseToOpenAIStream + SseUsageScanner", () => {
  it("produces meterable trailing usage for the stream scanner", async () => {
    const anthropic = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ].join("");

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(anthropic));
        controller.close();
      },
    });

    const transformed = anthropicSseToOpenAIStream(source, { model: MODEL });
    const scanner = new SseUsageScanner();
    const reader = transformed.getReader();
    let body = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        scanner.push(value);
        body += new TextDecoder().decode(value);
      }
    }
    scanner.end();

    expect(body).toContain('"content":"Hi"');
    expect(body).toContain("data: [DONE]");
    expect(scanner.usage()).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 2,
    });
  });
});
