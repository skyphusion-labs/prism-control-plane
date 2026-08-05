import { describe, expect, it } from "vitest";
import { buildVideoParams } from "../src/nonchat-upstream";

describe("buildVideoParams t2v", () => {
  it("uses integer duration for xAI Grok video (not Veo string 8s)", () => {
    const p = buildVideoParams("xai/grok-imagine-video", "a dog runs");
    expect(p).toEqual({
      _operation: "generate",
      prompt: "a dog runs",
      duration: 5,
      aspect_ratio: "16:9",
      resolution: "720p",
    });
    expect(p).not.toHaveProperty("generate_audio");
    expect(typeof p.duration).toBe("number");
  });

  it("uses integer duration for seedance t2v", () => {
    const p = buildVideoParams("bytedance/seedance-2.0-mini", "waves");
    expect(p.duration).toBe(5);
    expect(typeof p.duration).toBe("number");
    expect(p.generate_audio).toBe(false);
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
