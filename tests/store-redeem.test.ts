import { describe, expect, it } from "vitest";
import { decodeAppleTransactionJws, isXcodeStoreEnvironment } from "../src/apple-jws";
import {
  creditMicroUsdForProduct,
  isKnownStoreProduct,
  STORE_PRODUCT_CREDIT_USD,
} from "../src/store-products";

function b64url(obj: unknown): string {
  const s = JSON.stringify(obj);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeJws(payload: Record<string, unknown>): string {
  return `${b64url({ alg: "ES256", typ: "JWT" })}.${b64url(payload)}.${b64url({ sig: "x" })}`;
}

describe("store products", () => {
  it("maps the three credit packs", () => {
    expect(creditMicroUsdForProduct("org.skyphusion.prism.credit.5")).toBe(5_000_000);
    expect(creditMicroUsdForProduct("org.skyphusion.prism.credit.20")).toBe(20_000_000);
    expect(creditMicroUsdForProduct("org.skyphusion.prism.credit.50")).toBe(50_000_000);
    expect(isKnownStoreProduct("org.skyphusion.prism.credit.99")).toBe(false);
    expect(Object.keys(STORE_PRODUCT_CREDIT_USD)).toHaveLength(3);
  });
});

describe("apple JWS decode", () => {
  it("decodes a compact JWS payload", () => {
    const jws = fakeJws({
      transactionId: "2000000123456789",
      productId: "org.skyphusion.prism.credit.5",
      bundleId: "org.skyphusion.prism",
      environment: "Xcode",
      type: "Consumable",
    });
    const d = decodeAppleTransactionJws(jws);
    expect(d).toMatchObject({
      transactionId: "2000000123456789",
      productId: "org.skyphusion.prism.credit.5",
      bundleId: "org.skyphusion.prism",
      environment: "Xcode",
    });
  });

  it("rejects garbage", () => {
    expect(decodeAppleTransactionJws("not.a.jws.extra")).toBeNull();
    expect(decodeAppleTransactionJws("a.b")).toBeNull();
  });

  it("detects Xcode store environment", () => {
    expect(isXcodeStoreEnvironment("Xcode")).toBe(true);
    expect(isXcodeStoreEnvironment("Sandbox")).toBe(false);
  });
});

describe("android package", () => {
  it("shares product map with Apple and names the Android package", async () => {
    const { ANDROID_PACKAGE_NAME } = await import("../src/store-products");
    expect(ANDROID_PACKAGE_NAME).toBe("org.skyphusion.prism");
  });
});
