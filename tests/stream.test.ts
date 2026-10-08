import { describe, expect, it } from "vitest";
import { SseUsageScanner } from "../src/stream";
import { extractUsage } from "../src/meter";

const enc = new TextEncoder();

describe("SseUsageScanner", () => {
  it("reads top-level usage from a chat-completions trailing frame", () => {
    const s = new SseUsageScanner();
    s.push(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n'));
    s.end();
    expect(s.usage()).toEqual({ prompt_tokens: 7, completion_tokens: 3 });
  });

  it("reads usage nested in a Responses API response.completed frame", () => {
    const s = new SseUsageScanner();
    s.push(enc.encode('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'));
    s.push(
      enc.encode(
        'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":12,"output_tokens":34}}}\n\n',
      ),
    );
    s.end();
    expect(s.usage()).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(extractUsage({ usage: s.usage() })).toMatchObject({ inputTokens: 12, outputTokens: 34 });
  });

  it("ignores a null response.usage on an in-progress Responses frame", () => {
    const s = new SseUsageScanner();
    s.push(enc.encode('data: {"type":"response.created","response":{"id":"resp_1","usage":null}}\n\n'));
    s.end();
    expect(s.usage()).toBeNull();
  });

  it("counts received output bytes on both wire shapes and nothing else", () => {
    // The quantity the cancelled-stream estimate is built from (issue #99). It must count the
    // ASSISTANT TEXT and not the SSE framing: the framing is most of the bytes on small deltas, so
    // counting raw stream bytes would over-charge a cancel by roughly an order of magnitude.
    const s = new SseUsageScanner();
    s.push(enc.encode('data: {"choices":[{"delta":{"content":"abcd"}}]}\n\n'));
    s.push(enc.encode('data: {"type":"response.output_text.delta","delta":"efgh"}\n\n'));
    s.push(enc.encode("data: [DONE]\n\n"));
    s.end();
    expect(s.outputTextBytes()).toBe(8);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // A multi-byte character costs more tokens than an ASCII one, so sizing in characters would
    // under-count CJK and emoji. Bytes is the honest unit for a bytes-per-token rule.
    const s = new SseUsageScanner();
    s.push(enc.encode('data: {"choices":[{"delta":{"content":"\u6f22"}}]}\n\n'));
    s.end();
    expect(s.outputTextBytes()).toBe(3);
  });

  it("does not count a usage frame or an unparseable frame as output", () => {
    const s = new SseUsageScanner();
    s.push(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n'));
    s.push(enc.encode("data: not json at all\n\n"));
    s.end();
    expect(s.outputTextBytes()).toBe(0);
  });

  it("reads a Responses usage object split across two chunks", () => {
    const s = new SseUsageScanner();
    const frame =
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":6}}}\n\n';
    s.push(enc.encode(frame.slice(0, 60)));
    s.push(enc.encode(frame.slice(60)));
    s.end();
    expect(s.usage()).toEqual({ input_tokens: 5, output_tokens: 6 });
  });
});
