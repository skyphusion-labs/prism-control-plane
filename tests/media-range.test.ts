import { describe, expect, it } from "vitest";
import { parseBytesRange } from "../src/routes/media";
import { wantsAsync } from "../src/routes/jobs";

describe("parseBytesRange", () => {
  it("parses open-ended and closed ranges", () => {
    expect(parseBytesRange("bytes=0-99", 1000)).toEqual({
      offset: 0,
      length: 100,
      start: 0,
      end: 99,
    });
    expect(parseBytesRange("bytes=500-", 1000)).toEqual({
      offset: 500,
      length: 500,
      start: 500,
      end: 999,
    });
  });

  it("parses suffix ranges", () => {
    expect(parseBytesRange("bytes=-100", 1000)).toEqual({
      offset: 900,
      length: 100,
      start: 900,
      end: 999,
    });
  });

  it("returns unsatisfiable past EOF", () => {
    expect(parseBytesRange("bytes=1000-", 1000)).toBe("unsatisfiable");
  });

  it("returns null without Range", () => {
    expect(parseBytesRange(null, 100)).toBeNull();
  });
});

describe("wantsAsync", () => {
  it("reads body.async and Prefer header", () => {
    const base = new Request("https://example.com/", { method: "POST" });
    expect(wantsAsync(base, {})).toBe(false);
    expect(wantsAsync(base, { async: true })).toBe(true);
    expect(wantsAsync(base, { async: false })).toBe(false);
    const prefer = new Request("https://example.com/", {
      method: "POST",
      headers: { Prefer: "respond-async" },
    });
    expect(wantsAsync(prefer, {})).toBe(true);
  });
});
