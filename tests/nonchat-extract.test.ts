import { describe, expect, it } from "vitest";
import {
  extractMusicAsset,
  extractVideoAsset,
  providerStateFailed,
} from "../src/nonchat-upstream";

describe("providerStateFailed", () => {
  it("rejects Failed state and error strings", () => {
    expect(providerStateFailed({ state: "Failed", error: "boom" })).toMatch(/Failed|boom/);
    expect(providerStateFailed({ success: false })).toBeTruthy();
    expect(providerStateFailed({ state: "Completed", result: { video: "https://x" } })).toBeNull();
  });
});

describe("extractVideoAsset", () => {
  it("requires a video URL and Completed-ish envelope", () => {
    expect(
      extractVideoAsset({ state: "Completed", result: { video: "https://example.com/v.mp4" } }),
    ).toBe("https://example.com/v.mp4");
    expect(extractVideoAsset({ state: "Failed", result: { video: "https://x" } })).toBeNull();
    expect(extractVideoAsset({ state: "Completed", result: {} })).toBeNull();
    expect(extractVideoAsset({ error: "nope" })).toBeNull();
  });
});

describe("extractMusicAsset", () => {
  it("accepts nested or flat audio", () => {
    expect(extractMusicAsset({ state: "Completed", result: { audio: "https://a/m.mp3" } })).toBe(
      "https://a/m.mp3",
    );
    expect(extractMusicAsset({ audio: "base64blob" })).toBe("base64blob");
    expect(extractMusicAsset({ state: "Completed", result: {} })).toBeNull();
  });
});
