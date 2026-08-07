// Decode + verify App Store / StoreKit 2 signed transaction JWS (compact form).
//
// Production path (1.0):
//   1. Decode payload (transactionId, productId, bundleId, environment).
//   2. Extract ECDSA P-256 public key from the leaf cert in header.x5c[0].
//   3. Verify ES256 signature over header.payload.
//   4. Optionally require x5c chain length >= 2 (Apple intermediate present).
//
// Local Configuration.storekit uses environment "Xcode" and a non-Apple test
// chain; the plane accepts those after decode only (xcode verified mode).
// Sandbox TestFlight uses real Apple-signed JWS when verify succeeds; optional
// STORE_REDEEM_ALLOW_SANDBOX_TRUST for lab decode-only sandbox (off by default
// for production deploys).

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
    const b64 = s.replace(/-/g, "+").replace(/\//g, "_") + pad;
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
 * Extract SubjectPublicKeyInfo (SPKI) DER from an X.509 certificate DER.
 * Walks SEQUENCE tags to the bit string that holds the public key.
 * Works for Apple leaf certs used in StoreKit transaction JWS (ECDSA P-256).
 */
export function spkiFromX509Der(cert: Uint8Array): Uint8Array | null {
  // Minimal TLV reader for DER.
  let off = 0;
  const readLen = (): number | null => {
    if (off >= cert.length) return null;
    const b = cert[off++];
    if (b < 0x80) return b;
    const n = b & 0x7f;
    if (n === 0 || n > 3 || off + n > cert.length) return null;
    let len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | cert[off++];
    return len;
  };
  const expectTag = (tag: number): number | null => {
    if (off >= cert.length || cert[off++] !== tag) return null;
    return readLen();
  };

  // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
  const certLen = expectTag(0x30);
  if (certLen == null) return null;
  const certEnd = off + certLen;

  // tbsCertificate ::= SEQUENCE
  const tbsLen = expectTag(0x30);
  if (tbsLen == null) return null;
  const tbsEnd = off + tbsLen;

  // Optional version [0]
  if (off < tbsEnd && cert[off] === 0xa0) {
    off++;
    const vLen = readLen();
    if (vLen == null) return null;
    off += vLen;
  }
  // serialNumber INTEGER
  const serialLen = expectTag(0x02);
  if (serialLen == null) return null;
  off += serialLen;
  // signature AlgorithmIdentifier SEQUENCE
  const sigAlgLen = expectTag(0x30);
  if (sigAlgLen == null) return null;
  off += sigAlgLen;
  // issuer Name SEQUENCE
  const issuerLen = expectTag(0x30);
  if (issuerLen == null) return null;
  off += issuerLen;
  // validity SEQUENCE
  const validityLen = expectTag(0x30);
  if (validityLen == null) return null;
  off += validityLen;
  // subject Name SEQUENCE
  const subjectLen = expectTag(0x30);
  if (subjectLen == null) return null;
  off += subjectLen;
  // subjectPublicKeyInfo SEQUENCE -- this is SPKI
  if (off >= cert.length || cert[off] !== 0x30) return null;
  const spkiStart = off;
  off++;
  const spkiLen = readLen();
  if (spkiLen == null) return null;
  const spkiEnd = off + spkiLen;
  if (spkiEnd > cert.length) return null;
  return cert.subarray(spkiStart, spkiEnd);
}

/**
 * Verify ES256 JWS using the leaf certificate in header.x5c[0].
 * Returns true / false / null (null = could not attempt: no x5c or import failure).
 */
export async function tryVerifyJwsEs256(jws: string): Promise<boolean | null> {
  const parts = jws.split(".");
  if (parts.length !== 3) return false;
  const header = b64urlToJson(parts[0]);
  if (!header) return false;
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || typeof x5c[0] !== "string") return null;

  try {
    const leafDer = Uint8Array.from(atob(x5c[0] as string), (c) => c.charCodeAt(0));
    // Prefer SPKI extracted from the X.509 leaf (correct path).
    let spki = spkiFromX509Der(leafDer);
    if (!spki) {
      // Some runtimes may already hand us SPKI; try the raw DER as SPKI last.
      spki = leafDer;
    }
    // Copy into a plain ArrayBuffer for importKey (SharedArrayBuffer-safe).
    const spkiBuf = new ArrayBuffer(spki.byteLength);
    new Uint8Array(spkiBuf).set(spki);

    const key = await crypto.subtle.importKey(
      "spki",
      spkiBuf,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const sig = b64urlToBytes(parts[2]);
    if (!sig) return false;
    // JWS ES256: raw r||s (64 bytes for P-256). WebCrypto ECDSA expects IEEE P1363 same shape.
    if (sig.byteLength !== 64) {
      // Some stacks wrap DER ECDSA; reject unknown shapes rather than false-accept.
      return false;
    }
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sigBuf = new ArrayBuffer(sig.byteLength);
    new Uint8Array(sigBuf).set(sig);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sigBuf, data);
  } catch {
    return null;
  }
}

/** True when header.x5c has at least leaf + one intermediate (Apple chain shape). */
export function jwsHasCertChain(jws: string): boolean {
  const parts = jws.split(".");
  if (parts.length !== 3) return false;
  const header = b64urlToJson(parts[0]);
  if (!header) return false;
  const x5c = header.x5c;
  return Array.isArray(x5c) && x5c.length >= 2 && typeof x5c[0] === "string";
}

export function isXcodeStoreEnvironment(env: string | undefined): boolean {
  if (!env) return false;
  const e = env.toLowerCase();
  return e === "xcode" || e === "localtesting" || e === "xcode.storekit";
}

export function isProductionStoreEnvironment(env: string | undefined): boolean {
  if (!env) return false;
  return env.toLowerCase() === "production";
}

export function isSandboxStoreEnvironment(env: string | undefined): boolean {
  if (!env) return false;
  return env.toLowerCase() === "sandbox";
}
