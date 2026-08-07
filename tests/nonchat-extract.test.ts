import { describe, expect, it } from "vitest";
import {
  buildSttParams,
  extractAudioBase64,
  extractDeepgramTranscript,
  extractImageAsset,
  extractMusicAsset,
  extractTranscript,
  extractVideoAsset,
  isClassicWhisperUint8Model,
  isDeepgramBatchStt,
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

describe("buildSttParams", () => {
  // "AQID" = bytes 0x01 0x02 0x03
  const b64 = "AQID";

  it("classic whisper uses uint8 array (not base64 string)", () => {
    expect(isClassicWhisperUint8Model("@cf/openai/whisper")).toBe(true);
    expect(isClassicWhisperUint8Model("@cf/openai/whisper-tiny-en")).toBe(true);
    expect(isClassicWhisperUint8Model("@cf/openai/whisper-large-v3-turbo")).toBe(false);
    const p = buildSttParams("@cf/openai/whisper", b64);
    expect(Array.isArray(p.audio)).toBe(true);
    expect(p.audio).toEqual([1, 2, 3]);
  });

  it("whisper-large-v3-turbo uses base64 string", () => {
    const p = buildSttParams("@cf/openai/whisper-large-v3-turbo", b64);
    expect(p.audio).toBe(b64);
  });

  it("flags deepgram batch for binding path", () => {
    expect(isDeepgramBatchStt("@cf/deepgram/nova-3")).toBe(true);
    expect(isDeepgramBatchStt("@cf/deepgram/flux")).toBe(false);
  });
});

describe("extractDeepgramTranscript", () => {
  it("reads channels alternatives", () => {
    expect(
      extractDeepgramTranscript({
        results: { channels: [{ alternatives: [{ transcript: " hello " }] }] },
      }),
    ).toBe("hello");
    expect(extractTranscript({ text: "from whisper" })).toBe("from whisper");
  });

  it("returns empty string for silent Deepgram (not null)", () => {
    expect(
      extractDeepgramTranscript({
        results: { channels: [{ alternatives: [{ transcript: "" }] }] },
      }),
    ).toBe("");
    expect(
      extractDeepgramTranscript({
        results: { channels: [{ alternatives: [] }] },
      }),
    ).toBe("");
    // Missing envelope still null so the handler can 502 only when structure is wrong.
    expect(extractDeepgramTranscript({ state: "Completed" })).toBeNull();
  });

  it("extractTranscript allows empty text field", () => {
    expect(extractTranscript({ text: "" })).toBe("");
    expect(extractTranscript({ result: { text: "" } })).toBe("");
  });
});
