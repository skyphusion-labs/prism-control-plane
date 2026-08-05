import { describe, expect, it } from "vitest";
import { buildVideoParams } from "../src/nonchat-upstream";

describe("buildVideoParams t2v", () => {
  it("uses minimal integer-duration body for xAI Grok video t2v", () => {
    const p = buildVideoParams("xai/grok-imagine-video", "a dog runs");
    expect(p).toEqual({
      prompt: "a dog runs",
      duration: 5,
    });
    expect(typeof p.duration).toBe("number");
  });

  it("uses CF-required seedance t2v fields", () => {
    const p = buildVideoParams("bytedance/seedance-2.0-mini", "waves");
    expect(p).toMatchObject({
      prompt: "waves",
      duration: 5,
      resolution: "720p",
      aspect_ratio: "16:9",
      fps: 24,
      camera_fixed: false,
      watermark: false,
    });
    expect(p).not.toHaveProperty("generate_audio");
  });

  it("uses Veo-style string duration for google/veo", () => {
    const p = buildVideoParams("google/veo-3.1-fast", "ocean");
    expect(p.duration).toBe("8s");
    expect(p.generate_audio).toBe(true);
  });
});

describe("buildVideoParams i2v", () => {
  it("wraps xAI image as { url }", () => {
    const p = buildVideoParams(
      "xai/grok-imagine-video",
      "motion",
      "https://example.com/frame.png",
    );
    expect(p.image).toEqual({ url: "https://example.com/frame.png" });
    expect(p.duration).toBe(5);
  });
});

import { nonChatUpstreamTimeoutMs, DEFAULT_NONCHAT_UPSTREAM_TIMEOUT_MS } from "../src/env";

describe("nonChatUpstreamTimeoutMs", () => {
  it("does not inherit UPSTREAM_TIMEOUT_MS (chat 60s must not clamp video)", () => {
    const env = {
      UPSTREAM_TIMEOUT_MS: "60000",
    } as import("../src/env").Env;
    expect(nonChatUpstreamTimeoutMs(env)).toBe(DEFAULT_NONCHAT_UPSTREAM_TIMEOUT_MS);
    expect(nonChatUpstreamTimeoutMs(env)).toBe(180_000);
  });

  it("honors NONCHAT_UPSTREAM_TIMEOUT_MS", () => {
    const env = {
      UPSTREAM_TIMEOUT_MS: "60000",
      NONCHAT_UPSTREAM_TIMEOUT_MS: "150000",
    } as import("../src/env").Env;
    expect(nonChatUpstreamTimeoutMs(env)).toBe(150_000);
  });
});
