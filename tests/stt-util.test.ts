import { describe, expect, it } from "vitest";
import { billableAudioMinutes, sanitizeCloseCode } from "../src/stt-util";
import { findModel, spendable } from "../src/catalog";

describe("billableAudioMinutes", () => {
  it("bills at least one minute", () => {
    expect(billableAudioMinutes(0)).toBe(1);
    expect(billableAudioMinutes(1)).toBe(1);
    expect(billableAudioMinutes(60)).toBe(1);
    expect(billableAudioMinutes(61)).toBe(2);
  });
});

describe("sanitizeCloseCode", () => {
  it("maps illegal codes to 1011", () => {
    expect(sanitizeCloseCode(1000)).toBe(1000);
    expect(sanitizeCloseCode(1006)).toBe(1011);
    expect(sanitizeCloseCode(4000)).toBe(4000);
  });
});

describe("flux catalog", () => {
  it("is spendable with unit audio_minute rate", () => {
    const entry = findModel("@cf/deepgram/flux");
    expect(entry?.modality).toBe("voice");
    expect(entry?.unitPrice?.unit).toBe("audio_minute");
    expect(spendable(entry!, null, null)).toBe(true);
  });
});
