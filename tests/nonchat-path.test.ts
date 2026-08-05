import { describe, expect, it } from "vitest";
import { safeCfRunPath } from "../src/nonchat-upstream";
import {
  authFromSttUpgrade,
  bearerFromSttUpgrade,
  parseSttTicket,
  STT_TICKET_PREFIX,
  STT_WS_PROTOCOL,
} from "../src/routes/stt-stream";

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

describe("authFromSttUpgrade", () => {
  // Grammar: pcp_ + 16 hex key_id + _ + 43 base64url secret
  const validKey = `pcp_${"a".repeat(16)}_${"A".repeat(43)}`;
  const validTicket = `${STT_TICKET_PREFIX}_${"B".repeat(43)}`;

  it("reads Authorization Bearer when well-formed pcp key", () => {
    const req = new Request("https://example.invalid/v1/stt/stream", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${validKey}`,
      },
    });
    const r = authFromSttUpgrade(req);
    expect(r.kind).toBe("client_key");
    if (r.kind === "client_key") expect(r.bearer).toBe(validKey);
    expect(r.acceptProtocol).toBeNull();
  });

  it("reads Sec-WebSocket-Protocol prism.v1 + stt_ ticket", () => {
    const req = new Request("https://example.invalid/v1/stt/stream", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${STT_WS_PROTOCOL}, ${validTicket}`,
      },
    });
    const r = authFromSttUpgrade(req);
    expect(r.kind).toBe("stt_ticket");
    if (r.kind === "stt_ticket") expect(r.ticket).toBe(validTicket);
    expect(r.acceptProtocol).toBe(STT_WS_PROTOCOL);
  });

  it("rejects long-lived pcp key in Sec-WebSocket-Protocol", () => {
    const req = new Request("https://example.invalid/v1/stt/stream", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${STT_WS_PROTOCOL}, ${validKey}`,
      },
    });
    expect(authFromSttUpgrade(req).kind).toBeNull();
    // Legacy helper also must not surface the key as a bearer.
    expect(bearerFromSttUpgrade(req).bearer).toBeNull();
  });

  it("does not accept query tokens", () => {
    const req = new Request(
      `https://example.invalid/v1/stt/stream?access_token=${validKey}`,
      { headers: { upgrade: "websocket" } },
    );
    expect(authFromSttUpgrade(req).kind).toBeNull();
  });
});

describe("parseSttTicket", () => {
  it("accepts stt_ + 43 base64url", () => {
    const t = `stt_${"A".repeat(43)}`;
    expect(parseSttTicket(t)).toBe(t);
  });

  it("rejects pcp keys and short junk", () => {
    expect(parseSttTicket(`pcp_${"a".repeat(16)}_${"A".repeat(43)}`)).toBeNull();
    expect(parseSttTicket("stt_short")).toBeNull();
    expect(parseSttTicket("stt_")).toBeNull();
  });
});
