// Envelope encryption for the per-user Cloudflare API tokens this plane mints and then has to KEEP.
//
// WHY WE HOLD A USABLE SECRET AT ALL. Every other credential in this plane is stored as a hash, because
// nothing here ever needs to replay one. A per-user upstream token is different: it is presented on the
// user's NEXT request, and the one after that, so the plane must be able to read it back. Holding a
// usable secret is the exception, so it is encrypted at rest: AES-256-GCM under a KEK that lives only as
// a Worker secret and never in D1. A D1 dump without the KEK yields nothing spendable.
//
// Wire format: base64( iv[12] || ciphertext+tag ). A KEK is a base64-encoded 32-byte key.
//
// WHY A RING AND NOT A KEY. One binding and one key means the credential cannot be rotated without a
// window where live rows are unreadable, and a credential you cannot rotate calmly is one you rotate
// badly. The ring separates the two directions:
//
//   READ  tries BOTH installed keys, always, so a row is readable whether it was written before,
//         during, or after a rotation.
//   WRITE uses exactly ONE key, named explicitly by USER_TOKEN_KEK_ENCRYPT_SLOT.
//
// The write slot is config and not D1 state so that "which key are we writing?" is one fact with one
// home, reviewable in git, and so a re-encryption sweep and the live write path cannot chase each other
// forever. Naming a slot whose key is not installed is a HARD REFUSAL rather than a silent fallback to
// the primary: falling back would write live credentials under a key the operator believes is retired,
// and that failure stays invisible until someone deletes the wrong binding.
//
// This is the same shape vivijure-control-plane's token-crypto.ts settled on. Copied deliberately: the
// reasoning was paid for once and the failure modes are identical.

const IV_BYTES = 12;

/** Which installed key new ciphertext is written under. The read direction always tries both. */
export type KekSlot = "primary" | "next";

export interface KekRing {
  primary: string;
  next?: string;
  encryptSlot: KekSlot;
}

/** Raised when the ring cannot honour its own configuration. NEVER carries a key value. */
export class KekRingError extends Error {
  constructor(
    readonly code: "encrypt_slot_unavailable" | "no_key_installed",
    message: string,
  ) {
    super(message);
    this.name = "KekRingError";
  }
}

/**
 * Build a ring from raw config values.
 *
 * Trimmed, and empty means absent: a whitespace-only secret is a paste accident, and treating it as a
 * key would produce a ring that claims two keys and has one. An unrecognized slot value falls back to
 * `primary` (the pre-rotation behaviour) rather than guessing.
 */
export function kekRing(primary: string, next?: string, encryptSlot?: string): KekRing {
  const cleanedNext = next?.trim() || undefined;
  const slot: KekSlot = encryptSlot?.trim() === "next" ? "next" : "primary";
  return { primary: primary.trim(), next: cleanedNext, encryptSlot: slot };
}

/** True when a KEK is installed at all. A ring with no primary cannot mint or read tokens. */
export const ringUsable = (ring: KekRing): boolean => ring.primary.length > 0;

async function importKek(kekBase64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(kekBase64), (c) => c.charCodeAt(0));
  if (raw.byteLength !== 32) {
    throw new KekRingError("no_key_installed", "a user-token KEK must be a base64-encoded 32-byte key");
  }
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toB64(u8: Uint8Array): string {
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The key named by the write slot, or a NAMED refusal. Never returns the wrong key quietly. */
export function encryptionKey(ring: KekRing): string {
  if (!ring.primary) {
    throw new KekRingError("no_key_installed", "USER_TOKEN_KEK is not installed; refusing to encrypt.");
  }
  if (ring.encryptSlot === "primary") return ring.primary;
  if (ring.next) return ring.next;
  throw new KekRingError(
    "encrypt_slot_unavailable",
    "USER_TOKEN_KEK_ENCRYPT_SLOT names 'next' but USER_TOKEN_KEK_NEXT is not installed. Refusing to " +
      "encrypt: falling back to the primary would write live upstream credentials under a key the " +
      "operator believes is out of use. Install the next key or set the slot back to 'primary'.",
  );
}

async function encryptUnder(kekBase64: string, plaintext: string): Promise<string> {
  const key = await importKek(kekBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, iv.byteLength);
  return toB64(out);
}

async function decryptUnder(kekBase64: string, blob: string): Promise<string> {
  const key = await importKek(kekBase64);
  const raw = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const iv = raw.subarray(0, IV_BYTES);
  const ct = raw.subarray(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/** Encrypt a token value for at-rest storage, under the configured write slot. */
export async function encryptToken(ring: KekRing, plaintext: string): Promise<string> {
  return await encryptUnder(encryptionKey(ring), plaintext);
}

/**
 * Decrypt a stored token value, trying the write slot FIRST and the other key second.
 *
 * Write-slot-first is not cosmetic: after a sweep most rows are on the target key, so the common path is
 * one AES operation rather than two.
 *
 * AES-GCM cannot distinguish "wrong key" from "tampered ciphertext" -- both surface as an auth-tag
 * failure -- so a failure is carried, never interpreted. If every installed key fails, the FIRST error
 * is rethrown and the caller reports a row it could not read.
 */
export async function decryptToken(ring: KekRing, blob: string): Promise<string> {
  const order: KekSlot[] = ring.encryptSlot === "next" ? ["next", "primary"] : ["primary", "next"];
  let firstError: unknown;
  for (const slot of order) {
    const key = slot === "primary" ? ring.primary : ring.next;
    if (!key) continue;
    try {
      return await decryptUnder(key, blob);
    } catch (e) {
      firstError ??= e;
    }
  }
  throw firstError ?? new KekRingError("no_key_installed", "no user-token KEK is installed");
}
