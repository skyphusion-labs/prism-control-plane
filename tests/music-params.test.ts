import { describe, expect, it } from "vitest";
import { buildMusicParams } from "../src/nonchat-upstream";

describe("buildMusicParams (MiniMax music-2.6 CF schema)", () => {
  it("sends required booleans for style-only prompt (instrumental default)", () => {
    const p = buildMusicParams("upbeat lo-fi short instrumental");
    expect(p).toEqual({
      prompt: "upbeat lo-fi short instrumental",
      is_instrumental: true,
      lyrics_optimizer: false,
      format: "mp3",
    });
  });

  it("attaches lyrics and disables instrumental + optimizer", () => {
    const p = buildMusicParams("folk ballad", "Walking down a dusty road\nHome again");
    expect(p).toEqual({
      prompt: "folk ballad",
      is_instrumental: false,
      lyrics_optimizer: false,
      format: "mp3",
      lyrics: "Walking down a dusty road\nHome again",
    });
  });

  it("ignores blank lyrics (treat as no lyrics)", () => {
    const p = buildMusicParams("calm piano", "   ");
    expect(p.is_instrumental).toBe(true);
    expect(p.lyrics).toBeUndefined();
  });

  it("honors explicit is_instrumental false without lyrics (auto lyrics)", () => {
    const p = buildMusicParams("cheerful pop song", undefined, {
      isInstrumental: false,
    });
    expect(p).toMatchObject({
      prompt: "cheerful pop song",
      is_instrumental: false,
      lyrics_optimizer: true,
      format: "mp3",
    });
  });

  it("honors explicit lyrics_optimizer override", () => {
    const p = buildMusicParams("edm", undefined, {
      isInstrumental: true,
      lyricsOptimizer: true,
    });
    expect(p.is_instrumental).toBe(true);
    expect(p.lyrics_optimizer).toBe(true);
  });
});
