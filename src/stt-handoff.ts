// HMAC handoff from the Worker to the STT Durable Object.
//
// The DO is only reachable via the Worker's STT_SESSION binding in normal deploys, but the
// adversarial audit correctly wants a cryptographic fence so plain x-prism-* headers alone cannot
// attribute spend if anything ever proxies to the DO without auth. Payload is signed with a key
// derived from CF_AIG_TOKEN (already required for inference on this plane).

const TE = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  const dig = await crypto.subtle.digest("SHA-256", TE.encode(`prism-stt-handoff-v1:${secret}`));
  return crypto.subtle.importKey("raw", dig, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

export interface SttHandoff {
  accountId: string;
  clientId: string;
  planId: string;
  requestId: string;
  modelId: string;
  /** Unix seconds expiry. */
  exp: number;
}

export function handoffPayload(h: SttHandoff): string {
  return [h.accountId, h.clientId, h.planId, h.requestId, h.modelId, String(h.exp)].join("\n");
}

/** Sign a handoff. `secret` is CF_AIG_TOKEN (or another high-entropy Worker secret). */
export async function signSttHandoff(secret: string, h: SttHandoff): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, TE.encode(handoffPayload(h)));
  return b64url(sig);
}

/**
 * Verify signature and expiry. Returns the handoff fields on success.
 * Constant-time compare is provided by crypto.subtle.verify.
 */
export async function verifySttHandoff(
  secret: string,
  h: SttHandoff,
  signatureB64url: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!Number.isInteger(h.exp) || h.exp < nowSec) return false;
  const sigBytes = b64urlToBytes(signatureB64url);
  if (!sigBytes) return false;
  const key = await hmacKey(secret);
  return crypto.subtle.verify("HMAC", key, sigBytes, TE.encode(handoffPayload(h)));
}

/** Handoff lifetime: long enough for upgrade + DO accept, short enough to limit replay. */
export const STT_HANDOFF_TTL_SEC = 60;
