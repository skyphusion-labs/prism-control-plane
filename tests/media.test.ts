import { describe, expect, it } from "vitest";
import {
  isSafeObjectKey,
  mintDownloadToken,
  mintUploadToken,
  newMusicObjectKey,
  newVideoObjectKey,
  verifyMediaToken,
} from "../src/media";
import { buildVideoParams } from "../src/nonchat-upstream";

const SECRET = "test-media-signing-secret-at-least-16";

describe("media tokens", () => {
  it("round-trips upload and download tokens", async () => {
    const key = newVideoObjectKey("acct_abc", "req_xyz");
    expect(isSafeObjectKey(key)).toBe(true);
    const up = await mintUploadToken(SECRET, key, 1_700_000_000);
    const down = await mintDownloadToken(SECRET, key, 1_700_000_000);

    const vu = await verifyMediaToken(SECRET, up.token, 1_700_000_000);
    expect(vu).toEqual({ kind: "u", objectKey: key, exp: up.exp });

    const vd = await verifyMediaToken(SECRET, down.token, 1_700_000_000);
    expect(vd).toEqual({ kind: "d", objectKey: key, exp: down.exp });
  });

  it("rejects expired tokens", async () => {
    const key = newVideoObjectKey("a", "b");
    const up = await mintUploadToken(SECRET, key, 1_000);
    expect(await verifyMediaToken(SECRET, up.token, up.exp + 1)).toBeNull();
  });

  it("rejects tampered tokens", async () => {
    const key = newVideoObjectKey("a", "b");
    const up = await mintUploadToken(SECRET, key, 1_700_000_000);
    const bad = up.token.slice(0, -4) + "XXXX";
    expect(await verifyMediaToken(SECRET, bad, 1_700_000_000)).toBeNull();
  });

  it("rejects path-traversal object keys", () => {
    expect(isSafeObjectKey("video/../etc/passwd")).toBe(false);
    expect(isSafeObjectKey("notvideo/x")).toBe(false);
    expect(isSafeObjectKey("music/../etc/passwd")).toBe(false);
  });

  it("accepts music/ object keys and round-trips download tokens", async () => {
    const key = newMusicObjectKey("acct_music", "req_1");
    expect(key.startsWith("music/")).toBe(true);
    expect(key.endsWith(".mp3")).toBe(true);
    expect(isSafeObjectKey(key)).toBe(true);
    const down = await mintDownloadToken(SECRET, key, 1_700_000_000);
    const vd = await verifyMediaToken(SECRET, down.token, 1_700_000_000);
    expect(vd).toEqual({ kind: "d", objectKey: key, exp: down.exp });
  });
});

describe("buildVideoParams Grok ZDR", () => {
  it("includes output.upload_url when provided", () => {
    const p = buildVideoParams("xai/grok-imagine-video", "sunset over water", undefined, {
      uploadUrl: "https://play-proxy.skyphusion.org/v1/media/ingress/tok",
    });
    expect(p).toMatchObject({
      prompt: "sunset over water",
      duration: 5,
      aspect_ratio: "16:9",
      resolution: "720p",
      output: { upload_url: "https://play-proxy.skyphusion.org/v1/media/ingress/tok" },
    });
  });

  it("includes upload_url on i2v Grok too", () => {
    const p = buildVideoParams(
      "xai/grok-imagine-video",
      "pan",
      "https://example.com/frame.png",
      { uploadUrl: "https://play-proxy.example/v1/media/ingress/t" },
    );
    expect(p.output).toEqual({
      upload_url: "https://play-proxy.example/v1/media/ingress/t",
    });
    expect(p.image).toEqual({ url: "https://example.com/frame.png" });
  });

  it("does not attach output for non-Grok models", () => {
    const p = buildVideoParams("google/veo-3.1-fast", "ocean", undefined, {
      uploadUrl: "https://example.com/u",
    });
    expect(p).not.toHaveProperty("output");
  });
});
