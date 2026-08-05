import { describe, expect, it } from "vitest";
import { parseClientKey } from "../src/auth";
import {
  handoffPayload,
  requireHandoffSecret,
  signSttHandoff,
  verifySttHandoff,
  STT_HANDOFF_TTL_SEC,
} from "../src/stt-handoff";
import { assertCatalogUpstream, safeCfRunPath } from "../src/nonchat-upstream";
import {
  authFromSttUpgrade,
  bearerFromSttUpgrade,
  parseSttTicket,
  STT_TICKET_PREFIX,
  STT_WS_PROTOCOL,
} from "../src/routes/stt-stream";

describe("stt handoff HMAC", () => {
  const secret = "test-cf-aig-token-not-real";
  const handoff = {
    accountId: "acct_1",
    clientId: "cli_1",
    planId: "dev",
    requestId: "req_abc",
    modelId: "@cf/deepgram/flux",
    exp: Math.floor(Date.now() / 1000) + STT_HANDOFF_TTL_SEC,
  };

  it("round-trips sign and verify", async () => {
    const sig = await signSttHandoff(secret, handoff);
    expect(sig.length).toBeGreaterThan(20);
    expect(await verifySttHandoff(secret, handoff, sig)).toBe(true);
  });

  it("rejects wrong secret, tampered payload, and expiry", async () => {
    const sig = await signSttHandoff(secret, handoff);
    expect(await verifySttHandoff("other-secret", handoff, sig)).toBe(false);
    expect(
      await verifySttHandoff(secret, { ...handoff, accountId: "acct_evil" }, sig),
    ).toBe(false);
    expect(
      await verifySttHandoff(secret, { ...handoff, exp: Math.floor(Date.now() / 1000) - 10 }, sig),
    ).toBe(false);
  });

  it("payload is deterministic", () => {
    expect(handoffPayload(handoff)).toContain("acct_1");
    expect(handoffPayload(handoff)).toContain(String(handoff.exp));
  });
});

describe("assertCatalogUpstream", () => {
  it("accepts catalog models and rejects unknown", () => {
    expect(assertCatalogUpstream("@cf/black-forest-labs/flux-1-schnell")).toBe(true);
    expect(assertCatalogUpstream("@cf/deepgram/flux")).toBe(true);
    expect(assertCatalogUpstream("google/nano-banana-2")).toBe(true);
    expect(assertCatalogUpstream("@cf/evil/not-in-catalog")).toBe(false);
    expect(assertCatalogUpstream("nope")).toBe(false);
  });

  it("safeCfRunPath still rejects traversal even for @cf-looking ids", () => {
    expect(safeCfRunPath("@cf/../admin")).toBeNull();
  });
});

describe("requireHandoffSecret", () => {
  it("refuses empty, short, and non-string", () => {
    expect(requireHandoffSecret(undefined)).toBeNull();
    expect(requireHandoffSecret("")).toBeNull();
    expect(requireHandoffSecret("   ")).toBeNull();
    expect(requireHandoffSecret("short")).toBeNull();
    expect(requireHandoffSecret("a".repeat(16))).toBe("a".repeat(16));
  });
});

describe("parseClientKey on WS candidates", () => {
  it("rejects junk pcp_ prefixes", () => {
    expect(parseClientKey("pcp_foo")).toBeNull();
    expect(parseClientKey("pcp_short_x")).toBeNull();
    // 16 hex key id + 43 base64url secret
    const good = `pcp_${"a".repeat(16)}_${"A".repeat(43)}`;
    expect(parseClientKey(good)).not.toBeNull();
  });
});

describe("authFromSttUpgrade grammar", () => {
  it("rejects junk protocol tokens", () => {
    const req = new Request("https://example.invalid/v1/stt/stream", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${STT_WS_PROTOCOL}, pcp_foo`,
      },
    });
    expect(authFromSttUpgrade(req).kind).toBeNull();
    expect(bearerFromSttUpgrade(req).bearer).toBeNull();
  });

  it("rejects well-formed pcp keys in the protocol list", () => {
    const key = `pcp_${"b".repeat(16)}_${"B".repeat(43)}`;
    const req = new Request("https://example.invalid/v1/stt/stream", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${STT_WS_PROTOCOL}, ${key}`,
      },
    });
    expect(authFromSttUpgrade(req).kind).toBeNull();
    expect(bearerFromSttUpgrade(req).bearer).toBeNull();
  });

  it("accepts a well-formed stt_ ticket in the protocol list", () => {
    const ticket = `${STT_TICKET_PREFIX}_${"C".repeat(43)}`;
    const req = new Request("https://example.invalid/v1/stt/stream", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${STT_WS_PROTOCOL}, ${ticket}`,
      },
    });
    const auth = authFromSttUpgrade(req);
    expect(auth.kind).toBe("stt_ticket");
    if (auth.kind === "stt_ticket") expect(auth.ticket).toBe(ticket);
    expect(parseSttTicket(ticket)).toBe(ticket);
  });
});
