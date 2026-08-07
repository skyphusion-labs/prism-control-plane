import { describe, expect, it } from "vitest";
import {
  clampVideoDurationSec,
  parseClientDuration,
  resolveVideoDuration,
  videoDurationSpec,
} from "../src/video-duration";
import { buildVideoParams } from "../src/nonchat-upstream";

describe("parseClientDuration", () => {
  it("accepts numbers and Veo-style strings", () => {
    expect(parseClientDuration(12)).toBe(12);
    expect(parseClientDuration(12.7)).toBe(13);
    expect(parseClientDuration("8s")).toBe(8);
    expect(parseClientDuration("10")).toBe(10);
    expect(parseClientDuration(null)).toBeNull();
    expect(parseClientDuration("nope")).toBeNull();
  });
});

describe("clampVideoDurationSec", () => {
  it("Grok 1–15", () => {
    expect(clampVideoDurationSec("xai/grok-imagine-video", null)).toBe(5);
    expect(clampVideoDurationSec("xai/grok-imagine-video", 15)).toBe(15);
    expect(clampVideoDurationSec("xai/grok-imagine-video", 99)).toBe(15);
    expect(clampVideoDurationSec("xai/grok-imagine-video", 0)).toBe(1);
  });

  it("Seedance 4–12", () => {
    expect(clampVideoDurationSec("bytedance/seedance-2.0-mini", 3)).toBe(4);
    expect(clampVideoDurationSec("bytedance/seedance-2.0", 12)).toBe(12);
    expect(clampVideoDurationSec("bytedance/seedance-2.0-fast", 20)).toBe(12);
  });

  it("Veo snaps to 4|6|8", () => {
    expect(clampVideoDurationSec("google/veo-3.1-fast", 5)).toBe(4);
    expect(clampVideoDurationSec("google/veo-3.1", 7)).toBe(6);
    expect(clampVideoDurationSec("google/veo-3.1", 8)).toBe(8);
    expect(clampVideoDurationSec("google/veo-3.1", null)).toBe(8);
  });

  it("Hailuo snaps to 6|10", () => {
    expect(clampVideoDurationSec("minimax/hailuo-2.3", 5)).toBe(6);
    expect(clampVideoDurationSec("minimax/hailuo-2.3", 9)).toBe(10);
  });

  it("Vidu 1–16", () => {
    expect(clampVideoDurationSec("vidu/q3-turbo", 16)).toBe(16);
    expect(clampVideoDurationSec("vidu/q3-pro", 20)).toBe(16);
  });
});

describe("resolveVideoDuration wire", () => {
  it("Veo wires string seconds", () => {
    expect(resolveVideoDuration("google/veo-3.1", 8).wire).toBe("8s");
    expect(resolveVideoDuration("xai/grok-imagine-video", 12).wire).toBe(12);
  });
});

describe("buildVideoParams respects durationSec", () => {
  it("Grok uses client duration", () => {
    const p = buildVideoParams("xai/grok-imagine-video", "a dog", undefined, {
      durationSec: 12,
    });
    expect(p.duration).toBe(12);
  });

  it("Veo uses string wire", () => {
    const p = buildVideoParams("google/veo-3.1-fast", "ocean", undefined, {
      durationSec: 6,
    });
    expect(p.duration).toBe("6s");
  });

  it("defaults without durationSec", () => {
    expect(buildVideoParams("xai/grok-imagine-video", "x").duration).toBe(5);
    expect(buildVideoParams("google/veo-3.1", "x").duration).toBe("8s");
  });
});

describe("videoDurationSpec coverage", () => {
  it("has specs for catalog video families", () => {
    for (const id of [
      "xai/grok-imagine-video-1.5-preview",
      "bytedance/seedance-2.0",
      "runwayml/gen-4.5",
      "alibaba/hh1-t2v",
      "alibaba/wan-2.7-i2v",
      "pixverse/v6",
      "pixverse/v5.6",
    ]) {
      const s = videoDurationSpec(id);
      expect(s.max).toBeGreaterThanOrEqual(s.min);
      expect(s.defaultSec).toBeGreaterThanOrEqual(s.min);
      expect(s.defaultSec).toBeLessThanOrEqual(s.max);
    }
  });
});
