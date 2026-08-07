// Decode and verify App Store / StoreKit 2 signed transaction JWS (compact form).
//
// WHAT VERIFICATION MEANS HERE
//
// A JWS carries its own certificate chain in header.x5c. Verifying the signature
// with the key from that chain proves only that whoever built the JWS holds the
// matching private key -- it says nothing about who they are. The identity claim
// comes entirely from the chain terminating at a root we pinned in advance, so the
// chain check is the authentication and the signature check is not.
//
// Accordingly this module exposes NO function that checks a JWS signature without
// first validating the chain. That is structural rather than advisory: there is no
// unsafe primitive left to reach for.
//
// THE ACCEPTED SHAPE, which follows Apple's own published verification procedure
// (apple/app-store-server-library-node, jws_verification.ts):
//
//   x5c[0]  leaf         must carry Apple's App Store signing marker extension
//                        (1.2.840.113635.100.6.11.1), be P-256, and be signed by
//   x5c[1]  intermediate which must be a CA, carry Apple's WWDR marker extension
//                        (1.2.840.113635.100.6.2.1), and be signed by
//           root         the PINNED Apple Root CA G3 in src/apple-root-ca.ts.
//
// Any root supplied in x5c is IGNORED. Presenting a root cannot make it trusted;
// the intermediate is always re-verified against the pinned anchor. Both marker
// extensions are load-bearing: without the leaf marker, any certificate issued by
// Apple WWDR -- which includes every Apple Developer Program member's own signing
// certificate, whose private key that member holds -- would chain to the pinned
// root and be accepted.
//
// Validity windows are checked on all three certificates at the time of the call.
//
// Lab paths (Xcode Configuration.storekit, optionally Sandbox) are decided by
// src/routes/store.ts on the environment claim AFTER this returns a refusal, and
// are never reachable for environment "Production".

import { APPLE_ROOT_CA_G3_DER_B64 } from "./apple-root-ca";
import {
  certValidAt,
  derEcdsaToP1363,
  importEcPublicKey,
  parseCertificate,
  verifyCertificateSignedBy,
  verifyEcdsa,
  type ParsedCertificate,
} from "./x509";

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

/**
 * DER of Apple's marker extensions, as lowercase hex of the complete OID TLV.
 * Verified against the real Apple certificates, with negative controls, in
 * tests/apple-jws-chain.test.ts.
 */
const APPLE_APP_STORE_LEAF_MARKER_OID = "060a2a864886f76364060b01"; // 1.2.840.113635.100.6.11.1
const APPLE_WWDR_INTERMEDIATE_MARKER_OID = "060a2a864886f76364060201"; // 1.2.840.113635.100.6.2.1

/** Every way the chain check can refuse. Named so a caller can assert WHICH fired. */
export type AppleJwsRefusal =
  | "malformed_jws"
  | "unsupported_alg"
  | "missing_x5c"
  | "x5c_too_short"
  | "leaf_parse_failed"
  | "intermediate_parse_failed"
  | "pinned_anchor_unusable"
  | "intermediate_not_ca"
  | "intermediate_missing_apple_wwdr_marker"
  | "leaf_missing_app_store_marker"
  | "intermediate_not_issued_by_pinned_root"
  | "leaf_not_issued_by_intermediate"
  | "certificate_outside_validity_window"
  | "leaf_key_not_p256"
  | "signature_malformed"
  | "signature_invalid";

export type AppleJwsVerdict =
  | { ok: true }
  | { ok: false; reason: AppleJwsRefusal };

function b64ToBytes(s: string, urlSafe: boolean): Uint8Array | null {
  // Reject anything outside the expected alphabet rather than letting the platform
  // decoder decide. A silent mis-decode here would be indistinguishable from a
  // genuine signature mismatch.
  const expected = urlSafe ? /^[A-Za-z0-9_-]*$/ : /^[A-Za-z0-9+/]*={0,2}$/;
  if (!expected.test(s)) return null;
  let std = urlSafe ? s.replace(/-/g, "+").replace(/_/g, "/") : s;
  if (urlSafe) {
    const rem = std.length % 4;
    if (rem === 1) return null;
    if (rem !== 0) std += "=".repeat(4 - rem);
  }
  try {
    const bin = atob(std);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Decode a base64url segment of a JWS. */
function b64urlToBytes(s: string): Uint8Array | null {
  return b64ToBytes(s, true);
}

function b64urlToJson(s: string): Record<string, unknown> | null {
  const bytes = b64urlToBytes(s);
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Decode a compact JWS without verifying anything.
 * Returns null if the shape is wrong. The result is UNAUTHENTICATED: it is only
 * safe to act on after verifyAppleTransactionJws returns ok, or on a lab path that
 * has deliberately opted out of verification.
 */
export function decodeAppleTransactionJws(jws: string): AppleTransactionPayload | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  const payload = b64urlToJson(parts[1]);
  if (!payload) return null;
  const str = (a: string, b: string): string | null => {
    if (typeof payload[a] === "string") return payload[a] as string;
    if (typeof payload[b] === "string") return payload[b] as string;
    return null;
  };
  const transactionId = str("transactionId", "transaction_id");
  const productId = str("productId", "product_id");
  const bundleId = str("bundleId", "bundle_id");
  if (!transactionId || !productId || !bundleId) return null;
  return {
    transactionId,
    originalTransactionId:
      typeof payload.originalTransactionId === "string" ? payload.originalTransactionId : undefined,
    productId,
    bundleId,
    environment: typeof payload.environment === "string" ? payload.environment : undefined,
    type: typeof payload.type === "string" ? payload.type : undefined,
    purchaseDate: typeof payload.purchaseDate === "number" ? payload.purchaseDate : undefined,
    raw: payload,
  };
}

let cachedAnchor: ParsedCertificate | null | undefined;

/** The pinned Apple Root CA G3, parsed once. Returns null only if the constant is unusable. */
export function pinnedAppleRoot(): ParsedCertificate | null {
  if (cachedAnchor === undefined) {
    const der = b64ToBytes(APPLE_ROOT_CA_G3_DER_B64, false);
    cachedAnchor = der ? parseCertificate(der) : null;
  }
  return cachedAnchor;
}

/**
 * Validate leaf + intermediate against a trust anchor, applying Apple's policy.
 *
 * The trust anchor is the ONLY injectable input, and the production entry point does
 * not expose it. Tests supply a purpose-built hierarchy because that is the only way
 * to observe a POSITIVE result at all: we hold no Apple-issued leaf key, so under the
 * real pin this function can only ever be watched refusing. Apple's policy -- both
 * marker OIDs, the CA constraint, the issuance links and the validity windows -- is
 * fixed here and is NOT a parameter, so a test cannot weaken it, only re-anchor it.
 */
export async function verifyAppleCertChain(
  leafDer: Uint8Array,
  intermediateDer: Uint8Array,
  anchor: ParsedCertificate,
  nowMs: number,
): Promise<{ ok: true; leaf: ParsedCertificate } | { ok: false; reason: AppleJwsRefusal }> {
  const leaf = parseCertificate(leafDer);
  if (!leaf) return { ok: false, reason: "leaf_parse_failed" };
  const intermediate = parseCertificate(intermediateDer);
  if (!intermediate) return { ok: false, reason: "intermediate_parse_failed" };

  if (!intermediate.isCa) return { ok: false, reason: "intermediate_not_ca" };
  if (!intermediate.extensionOids.includes(APPLE_WWDR_INTERMEDIATE_MARKER_OID)) {
    return { ok: false, reason: "intermediate_missing_apple_wwdr_marker" };
  }
  if (!leaf.extensionOids.includes(APPLE_APP_STORE_LEAF_MARKER_OID)) {
    return { ok: false, reason: "leaf_missing_app_store_marker" };
  }
  if (!(await verifyCertificateSignedBy(intermediate, anchor))) {
    return { ok: false, reason: "intermediate_not_issued_by_pinned_root" };
  }
  if (!(await verifyCertificateSignedBy(leaf, intermediate))) {
    return { ok: false, reason: "leaf_not_issued_by_intermediate" };
  }
  for (const cert of [leaf, intermediate, anchor]) {
    if (!certValidAt(cert, nowMs)) {
      return { ok: false, reason: "certificate_outside_validity_window" };
    }
  }
  return { ok: true, leaf };
}

/**
 * THE production entry point, and the only one src/routes/store.ts calls. Verifies a
 * signed transaction JWS against the pinned Apple Root CA G3.
 *
 * It takes no trust anchor, by design: the anchor is not a parameter any caller can
 * influence, and there is no flag, env var or option that changes it.
 *
 * `nowMs` exists so validity windows can be driven from both sides in tests. It is
 * not reachable from request input.
 */
export async function verifyAppleTransactionJws(
  jws: string,
  nowMs: number = Date.now(),
): Promise<AppleJwsVerdict> {
  const anchor = pinnedAppleRoot();
  if (!anchor) return { ok: false, reason: "pinned_anchor_unusable" };
  return verifyAppleTransactionJwsAgainstAnchor(jws, anchor, nowMs);
}

/**
 * The whole pipeline -- header, chain, and signature -- against a caller-supplied
 * anchor. The trust anchor is the ONE injected value, so tests can drive every step
 * production runs, including a genuine ACCEPT, which the pinned anchor can never
 * produce for us: we hold no Apple-issued leaf key.
 *
 * Policy is NOT injectable. Both marker OIDs, the CA constraint, the issuance links,
 * the validity windows and the signature check are fixed here, so a test can
 * re-anchor this function but cannot weaken it.
 *
 * Callers outside tests should use verifyAppleTransactionJws.
 */
export async function verifyAppleTransactionJwsAgainstAnchor(
  jws: string,
  anchor: ParsedCertificate,
  nowMs: number,
): Promise<AppleJwsVerdict> {
  const parts = jws.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_jws" };
  const header = b64urlToJson(parts[0]);
  if (!header) return { ok: false, reason: "malformed_jws" };
  if (header.alg !== "ES256") return { ok: false, reason: "unsupported_alg" };

  const x5c = header.x5c;
  if (!Array.isArray(x5c)) return { ok: false, reason: "missing_x5c" };
  if (x5c.length < 2 || typeof x5c[0] !== "string" || typeof x5c[1] !== "string") {
    return { ok: false, reason: "x5c_too_short" };
  }

  const leafDer = b64ToBytes(x5c[0] as string, false);
  if (!leafDer) return { ok: false, reason: "leaf_parse_failed" };
  const intermediateDer = b64ToBytes(x5c[1] as string, false);
  if (!intermediateDer) return { ok: false, reason: "intermediate_parse_failed" };

  const chain = await verifyAppleCertChain(leafDer, intermediateDer, anchor, nowMs);
  if (!chain.ok) return chain;

  return verifyJwsSignatureWithLeaf(parts, chain.leaf);
}

/**
 * Check the ES256 signature over "<header>.<payload>" with an ALREADY CHAIN-VALIDATED
 * leaf. Deliberately not exported: a signature check alone authenticates nobody, so
 * it must not be reachable without the chain validation that precedes it here.
 */
async function verifyJwsSignatureWithLeaf(
  parts: string[],
  leaf: ParsedCertificate,
): Promise<AppleJwsVerdict> {
  // ES256 is defined over P-256. A chain-valid leaf on another curve is a shape we
  // do not accept rather than one we adapt to.
  if (leaf.curve !== "P-256") return { ok: false, reason: "leaf_key_not_p256" };

  const sig = b64urlToBytes(parts[2]);
  if (!sig) return { ok: false, reason: "signature_malformed" };
  // JWS ES256 signatures are raw r||s. Some stacks emit DER instead; accept that
  // shape explicitly rather than letting it fall through as a verification failure,
  // which would make an encoding mismatch indistinguishable from a bad signature.
  let raw: Uint8Array | null = null;
  if (sig.byteLength === 64) {
    raw = sig;
  } else {
    raw = derEcdsaToP1363(sig, 32);
  }
  if (!raw) return { ok: false, reason: "signature_malformed" };

  const key = await importEcPublicKey(leaf);
  if (!key) return { ok: false, reason: "signature_malformed" };
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await verifyEcdsa(key, "SHA-256", raw, data);
  return ok ? { ok: true } : { ok: false, reason: "signature_invalid" };
}

/** Exposed for the anchor-identity assertion in tests. */
export const APPLE_MARKER_OIDS = {
  leaf: APPLE_APP_STORE_LEAF_MARKER_OID,
  intermediate: APPLE_WWDR_INTERMEDIATE_MARKER_OID,
} as const;


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
