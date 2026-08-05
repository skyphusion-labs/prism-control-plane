import { describe, expect, it } from "vitest";
import { periodBounds, periodKey } from "../src/period";

describe("periodKey", () => {
  it("keys on the UTC calendar month", () => {
    expect(periodKey(new Date("2026-08-04T22:48:00.000Z"))).toBe("2026-08");
    expect(periodKey(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
  });

  it("uses UTC, not local time", () => {
    // 2026-09-01T00:30Z is still August in US Central. A local-time period would put this request in the
    // wrong month for some accounts and the right one for others.
    expect(periodKey(new Date("2026-09-01T00:30:00.000Z"))).toBe("2026-09");
  });
});

describe("periodBounds", () => {
  it("returns a half-open interval so consecutive periods tile exactly", () => {
    const august = periodBounds(new Date("2026-08-15T12:00:00.000Z"));
    expect(august).toEqual({
      key: "2026-08",
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-09-01T00:00:00.000Z",
    });
    // August's exclusive end IS September's inclusive start: no shared instant, no gap.
    expect(periodBounds(new Date("2026-09-02T00:00:00.000Z")).start).toBe(august.end);
  });

  it("rolls December into the next January", () => {
    expect(periodBounds(new Date("2026-12-31T23:59:59.999Z"))).toEqual({
      key: "2026-12",
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    });
  });

  it("handles a February in a leap year", () => {
    expect(periodBounds(new Date("2028-02-29T06:00:00.000Z"))).toEqual({
      key: "2028-02",
      start: "2028-02-01T00:00:00.000Z",
      end: "2028-03-01T00:00:00.000Z",
    });
  });
});
