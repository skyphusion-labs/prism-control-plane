import { describe, expect, it } from "vitest";
import { safeCfRunPath } from "../src/nonchat-upstream";
import { bearerFromSttUpgrade, STT_WS_PROTOCOL } from "../src/routes/stt-stream";

describe("safeCfRunPath", () => {
  it("accepts catalog-shaped Workers AI ids", () => {
    expect(safeCfRunPath("@cf/black-forest-labs/flux-1-schnell")).toBe(
      "%40cf/black-forest-labs/flux-1-schnell",
    );
    expect(safeCfRunPath("@cf/myshell-ai/melotts")).toContain("melotts");
  });

  it("rejects path traversal and non-@cf ids", () => {
    expect(safeCfRunPath("@cf/../admin")).toBeNull();
    expect(safeCfRunPath("@cf//evil")).toBeNull();
    expect(safeCfRunPath("google/nano-banana-2")).toBeNull();
    expect(safeCfRunPath("@cf/foo/bar?x=1")).toBeNull();
    expect(safeCfRunPath("@cf/foo/bar#frag")).toBeNull();
  });
});

describe("bearerFromSttUpgrade", () => {
  // Grammar: pcp_ + 16 hex key_id + _ + 43 base64url secret
  const validKey = `pcp_${"a".repeat(16)}_${"A".repeat(43)}`;

  it("reads Authorization Bearer when well-formed", () => {
    const req = new Request("https://example.invalid/v1/stt/stream", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${validKey}`,
      },
    });
    const r = bearerFromSttUpgrade(req);
    expect(r.bearer).toBe(validKey);
    expect(r.acceptProtocol).toBeNull();
  });

  it("reads Sec-WebSocket-Protocol prism.v1 + key", () => {
    const req = new Request("https://example.invalid/v1/stt/stream", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${STT_WS_PROTOCOL}, ${validKey}`,
      },
    });
    const r = bearerFromSttUpgrade(req);
    expect(r.bearer).toBe(validKey);
    expect(r.acceptProtocol).toBe(STT_WS_PROTOCOL);
  });

  it("does not accept query tokens", () => {
    const req = new Request(
      `https://example.invalid/v1/stt/stream?access_token=${validKey}`,
      { headers: { upgrade: "websocket" } },
    );
    expect(bearerFromSttUpgrade(req).bearer).toBeNull();
  });
});
