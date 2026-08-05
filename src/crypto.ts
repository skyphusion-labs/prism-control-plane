// Id minting, token minting, hashing, constant-time compare. WebCrypto only, no dependencies.
//
// NOTE ON HASHING CHOICE: client secrets are hashed with a single SHA-256 pass, NOT a password KDF.
// That is correct here and it is worth being explicit about why, because the opposite choice is right
// one file over in prism (src/auth-kdf.ts, PBKDF2 at 600k iterations).
//
// A KDF's job is to make a LOW-ENTROPY human-chosen secret expensive to guess. These secrets are 32
// bytes from the platform CSPRNG: there is nothing to brute force, and iterating a hash 600,000 times
// on every single API call would buy zero security while adding latency to the hot path of the only
// paid route. What a single SHA-256 does buy is the property that actually matters: a leaked clients
// table is not a set of usable credentials.

/** Hex of SHA-256 over the UTF-8 bytes of `value`. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Prefixed opaque id, e.g. newId("acct") -> "acct_3f8a1c0d9b21". */
export function newId(prefix: string): string {
  return `${prefix}_${randomHex(6)}`;
}

/** The indexed, NON-secret half of a client key: 16 lowercase hex characters. */
export function newKeyId(): string {
  return randomHex(8);
}

/**
 * A URL-safe secret with 256 bits of entropy, rendered as 43 base64url characters.
 *
 * base64url rather than hex so the token stays short enough to be pasted and QR-encoded without the
 * 64-character bulk of hex, and without any character that needs escaping in a header, a URL, or a
 * mobile keystore entry.
 */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Length-independent-time equality over two strings.
 *
 * Length is compared first and returns early, which DOES leak whether two candidates differ in
 * length. That is deliberate and harmless here: every value compared through this function is a
 * fixed-width hex digest, so the length is a constant an attacker already knows. What must not leak is
 * WHERE the first differing byte is, and the loop below always reads every position.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
