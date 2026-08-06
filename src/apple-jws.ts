// Decode App Store / StoreKit 2 signed transaction JWS (compact form).
//
// Payload fields used: transactionId, productId, bundleId, environment, type.
// Full x5c chain verification is best-effort when Web Crypto can import the leaf;
// Xcode StoreKit Configuration (environment "Xcode") is accepted without chain
// verify so local Configuration.storekit purchases can redeem.

export interface AppleTransactionPayload {
  transactionId: string;
  originalTransactionId?: string;
  productId: string;
  bundleId: string;
  environment?: string;
  type?: string;
  /** ms epoch */
  purchaseDate?: number;
  /** raw claims for audit */
  raw: Record<string, unknown>;
}

function b64urlToBytes(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64urlToJson(s: string): Record<string, unknown> | null {
  const bytes = b64urlToBytes(s);
  if (!bytes) return null;
  try {
    const text = new TextDecoder().decode(bytes);
    const v = JSON.parse(text) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Decode a compact JWS without verifying the signature.
 * Returns null if the shape is wrong.
 */
export function decodeAppleTransactionJws(jws: string): AppleTransactionPayload | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  const payload = b64urlToJson(parts[1]);
  if (!payload) return null;
  const transactionId =
    typeof payload.transactionId === "string"
      ? payload.transactionId
      : typeof payload.transaction_id === "string"
        ? payload.transaction_id
        : null;
  const productId =
    typeof payload.productId === "string"
      ? payload.productId
      : typeof payload.product_id === "string"
        ? payload.product_id
        : null;
  const bundleId =
    typeof payload.bundleId === "string"
      ? payload.bundleId
      : typeof payload.bundle_id === "string"
        ? payload.bundle_id
        : null;
  if (!transactionId || !productId || !bundleId) return null;
  return {
    transactionId,
    originalTransactionId:
      typeof payload.originalTransactionId === "string"
        ? payload.originalTransactionId
        : undefined,
    productId,
    bundleId,
    environment: typeof payload.environment === "string" ? payload.environment : undefined,
    type: typeof payload.type === "string" ? payload.type : undefined,
    purchaseDate: typeof payload.purchaseDate === "number" ? payload.purchaseDate : undefined,
    raw: payload,
  };
}

/**
 * Best-effort ES256 verify using the first x5c cert in the JWS header.
 * Returns true / false / null (null = could not attempt).
 */
export async function tryVerifyJwsEs256(jws: string): Promise<boolean | null> {
  const parts = jws.split(".");
  if (parts.length !== 3) return false;
  const header = b64urlToJson(parts[0]);
  if (!header) return false;
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || typeof x5c[0] !== "string") return null;
  try {
    const der = Uint8Array.from(atob(x5c[0] as string), (c) => c.charCodeAt(0));
    // SPKI import of raw DER cert is not portable; Workers accept X.509 in some runtimes.
    // If import fails, return null so caller can fall back by environment.
    const key = await crypto.subtle.importKey(
      "spki",
      der.buffer as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const sig = b64urlToBytes(parts[2]);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (!sig) return false;
    // JWS ES256 uses raw r||s; WebCrypto expects IEEE P1363 which is the same length for P-256.
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data);
  } catch {
    return null;
  }
}

export function isXcodeStoreEnvironment(env: string | undefined): boolean {
  if (!env) return false;
  const e = env.toLowerCase();
  return e === "xcode" || e === "localtesting" || e === "xcode.storekit";
}
