import { describe, expect, it } from "vitest";
import {
  decodeAppleTransactionJws,
  isProductionStoreEnvironment,
  isSandboxStoreEnvironment,
  isXcodeStoreEnvironment,
  jwsHasCertChain,
  spkiFromX509Der,
  tryVerifyJwsEs256,
} from "../src/apple-jws";
import {
  creditMicroUsdForProduct,
  isKnownStoreProduct,
  STORE_PRODUCT_CREDIT_USD,
} from "../src/store-products";

function b64url(obj: unknown): string {
  const s = JSON.stringify(obj);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeJws(payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  return `${b64url({ alg: "ES256", typ: "JWT", ...header })}.${b64url(payload)}.${b64urlBytes(new Uint8Array(64))}`;
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

  it("classifies Production vs Sandbox", () => {
    expect(isProductionStoreEnvironment("Production")).toBe(true);
    expect(isSandboxStoreEnvironment("Sandbox")).toBe(true);
    expect(isProductionStoreEnvironment("Sandbox")).toBe(false);
  });

  it("requires x5c chain shape for jwsHasCertChain", () => {
    const noChain = fakeJws({ transactionId: "1", productId: "p", bundleId: "b" });
    expect(jwsHasCertChain(noChain)).toBe(false);
    const withChain = fakeJws(
      { transactionId: "1", productId: "p", bundleId: "b" },
      { x5c: ["YQ==", "Yg=="] },
    );
    expect(jwsHasCertChain(withChain)).toBe(true);
  });

  it("tryVerifyJwsEs256 returns null without x5c", async () => {
    const jws = fakeJws({
      transactionId: "1",
      productId: "org.skyphusion.prism.credit.5",
      bundleId: "org.skyphusion.prism",
    });
    expect(await tryVerifyJwsEs256(jws)).toBeNull();
  });

  it("spkiFromX509Der rejects garbage", () => {
    expect(spkiFromX509Der(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("android package", () => {
  it("shares product map with Apple and names the Android package", async () => {
    const { ANDROID_PACKAGE_NAME } = await import("../src/store-products");
    expect(ANDROID_PACKAGE_NAME).toBe("org.skyphusion.prism");
  });
});
