import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, readJsonBody } from "../src/http";

function requestWithBody(
  body: BodyInit | null,
  headers: Record<string, string> = {},
  init: RequestInit = {},
): Request {
  return new Request("https://example.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    // Node undici requires duplex when body is a stream.
    ...(body instanceof ReadableStream ? { duplex: "half" as "half" } : {}),
    ...init,
  });
}

describe("readJsonBody", () => {
  it("parses a small JSON body", async () => {
    const result = await readJsonBody(requestWithBody(JSON.stringify({ a: 1 })));
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("refuses when Content-Length exceeds the cap before reading", async () => {
    const result = await readJsonBody(
      requestWithBody("{}", { "content-length": String(MAX_BODY_BYTES + 1) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("payload_too_large");
  });

  it("refuses a streamed body that crosses the cap without requiring Content-Length", async () => {
    // Chunked-style body: no content-length, stream delivers past the cap mid-read.
    const oversize = new Uint8Array(MAX_BODY_BYTES + 64);
    oversize.fill(0x61); // 'a'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // deliver in two chunks so the running total crosses the cap on the second read
        controller.enqueue(oversize.subarray(0, MAX_BODY_BYTES - 10));
        controller.enqueue(oversize.subarray(MAX_BODY_BYTES - 10));
        controller.close();
      },
    });
    const result = await readJsonBody(requestWithBody(stream));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("payload_too_large");
  });

  it("rejects empty bodies", async () => {
    const result = await readJsonBody(requestWithBody("   "));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_request");
  });

  it("rejects non-JSON", async () => {
    const result = await readJsonBody(requestWithBody("not-json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_request");
  });
});
