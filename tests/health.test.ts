import { describe, it, expect } from "vitest";
import { health, CONTROL_PLANE_NAME } from "../src/index";

describe("health", () => {
  it("reports ok", () => {
    expect(health()).toEqual({ ok: true, service: CONTROL_PLANE_NAME });
  });
});
