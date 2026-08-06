// App Store product id → prepaid credit (micro-USD).
// Keep in lockstep with prism-ios StoreProducts.packs.

export const APPLE_BUNDLE_ID = "org.skyphusion.prism";

/** Whole USD credit per product id. */
export const STORE_PRODUCT_CREDIT_USD: Record<string, number> = {
  "org.skyphusion.prism.credit.5": 5,
  "org.skyphusion.prism.credit.20": 20,
  "org.skyphusion.prism.credit.50": 50,
};

export function creditMicroUsdForProduct(productId: string): number | null {
  const usd = STORE_PRODUCT_CREDIT_USD[productId];
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return null;
  return Math.round(usd * 1_000_000);
}

export function isKnownStoreProduct(productId: string): boolean {
  return productId in STORE_PRODUCT_CREDIT_USD;
}
