import { describe, expect, it } from "vitest";
import {
  extractAudioBase64,
  extractImageAsset,
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

describe("extractAudioBase64", () => {
  it("reads flat or nested audio strings", () => {
    expect(extractAudioBase64({ audio: "YmFzZTY0" })).toBe("YmFzZTY0");
    expect(extractAudioBase64({ result: { audio: "abc" } })).toBe("abc");
    expect(extractAudioBase64({ state: "Completed" })).toBeNull();
  });
});

describe("extractImageAsset", () => {
  it("puts https URLs in url, not b64_json", () => {
    expect(
      extractImageAsset({
        state: "Completed",
        result: { image: "https://cdn.example/out.png" },
      }),
    ).toEqual({ url: "https://cdn.example/out.png" });
  });

  it("puts bare base64 in b64_json", () => {
    expect(extractImageAsset({ image: "abc123base64" })).toEqual({ b64_json: "abc123base64" });
  });
});
