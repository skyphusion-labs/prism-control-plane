import { describe, expect, it } from "vitest";
import { buildTtsParams, defaultTtsVoice } from "../src/nonchat-upstream";

describe("buildTtsParams", () => {
  it("sends speaker + voice for Aura-2 English (default luna)", () => {
    const p = buildTtsParams("@cf/deepgram/aura-2-en", "Hello world");
    expect(p).toEqual({
      text: "Hello world",
      speaker: "luna",
      voice: "luna",
      encoding: "mp3",
    });
  });

  it("defaults Spanish Aura-2 to sirio (luna is not in the ES enum)", () => {
    expect(defaultTtsVoice("@cf/deepgram/aura-2-es")).toBe("sirio");
    const p = buildTtsParams("@cf/deepgram/aura-2-es", "Hola prueba");
    expect(p.speaker).toBe("sirio");
    expect(p.voice).toBe("sirio");
  });

  it("honors explicit voice override", () => {
    const p = buildTtsParams("@cf/deepgram/aura-2-en", "Hi", { voice: "Athena" });
    expect(p.speaker).toBe("athena");
    expect(p.voice).toBe("athena");
  });

  it("uses melotts prompt/lang shape", () => {
    const p = buildTtsParams("@cf/myshell-ai/melotts", "hola");
    expect(p).toEqual({ prompt: "hola", lang: "en" });
  });
});
