// Media ingress for ZDR-constrained video (Grok on CF Unified Billing).
//
// CF-managed xAI credentials are a ZDR team at xAI: video generation refuses
// unless the request includes output.upload_url, and xAI PUTs the mp4 there
// instead of hosting a URL. This module mints short-lived HMAC tokens for:
//   PUT  /v1/media/ingress/{token}  -- xAI writes bytes into R2
//   GET  /v1/media/{token}          -- client reads the object (signed, no pcp_)
//
// Signing secret is CF_AIG_TOKEN (same posture as STT handoff). No client ever
// sees a raw R2 credential or a long-lived write URL.

const TE = new TextEncoder();

const UPLOAD_TTL_SEC = 20 * 60; // video gen can take several minutes
const DOWNLOAD_TTL_SEC = 24 * 60 * 60;
/** Hard cap for a single ingress PUT (15s 720p is well under this). */
export const MEDIA_MAX_BYTES = 80 * 1024 * 1024;

async function hmacKey(secret: string): Promise<CryptoKey> {
  const dig = await crypto.subtle.digest("SHA-256", TE.encode(`prism-media-v1:${secret}`));
  return crypto.subtle.importKey("raw", dig, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
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

function b64urlUtf8(s: string): string {
  return b64url(TE.encode(s));
}

function utf8FromB64url(s: string): string | null {
  const bytes = b64urlToBytes(s);
  if (!bytes) return null;
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export type MediaTokenKind = "u" | "d";

export interface MediaToken {
  kind: MediaTokenKind;
  objectKey: string;
  exp: number;
}

function payload(kind: MediaTokenKind, exp: number, objectKey: string): string {
  return `${kind}\n${exp}\n${objectKey}`;
}

async function sign(
  secret: string,
  kind: MediaTokenKind,
  exp: number,
  objectKey: string,
): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, TE.encode(payload(kind, exp, objectKey)));
  return `${kind}.${exp}.${b64urlUtf8(objectKey)}.${b64url(sig)}`;
}

/**
 * Verify and parse a media token. Returns null on bad shape, bad sig, or expiry.
 */
export async function verifyMediaToken(
  secret: string,
  token: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<MediaToken | null> {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [kindRaw, expRaw, keyB64, sigB64] = parts;
  if (kindRaw !== "u" && kindRaw !== "d") return null;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp < nowSec) return null;
  const objectKey = utf8FromB64url(keyB64);
  if (!objectKey || !isSafeObjectKey(objectKey)) return null;
  const sigBytes = b64urlToBytes(sigB64);
  if (!sigBytes) return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    TE.encode(payload(kindRaw, exp, objectKey)),
  );
  if (!ok) return null;
  return { kind: kindRaw, objectKey, exp };
}

/** Object keys must be path-safe under video/ (ZDR), music/ (audio), or image/ (async gens). */
export function isSafeObjectKey(key: string): boolean {
  if (key.length < 8 || key.length > 200) return false;
  if (key.includes("..") || key.includes("//") || key.includes("\\")) return false;
  if (key.startsWith("video/")) {
    return /^video\/[A-Za-z0-9._/-]+$/.test(key);
  }
  if (key.startsWith("music/")) {
    return /^music\/[A-Za-z0-9._/-]+$/.test(key);
  }
  if (key.startsWith("image/")) {
    return /^image\/[A-Za-z0-9._/-]+$/.test(key);
  }
  return false;
}

function mediaKeyParts(accountId: string, requestId: string): { acct: string; req: string; rand: string } {
  const acct = accountId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "acct";
  const req = requestId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "req";
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return { acct, req, rand };
}

export function newVideoObjectKey(accountId: string, requestId: string): string {
  // Keep key short; both ids are already uuid-ish.
  const { acct, req, rand } = mediaKeyParts(accountId, requestId);
  return `video/${acct}/${req}-${rand}.mp4`;
}

/** R2 object key for rehosted MiniMax (or other) music assets. */
export function newMusicObjectKey(accountId: string, requestId: string): string {
  const { acct, req, rand } = mediaKeyParts(accountId, requestId);
  return `music/${acct}/${req}-${rand}.mp3`;
}

/** R2 object key for async image generation results (gpt-image-2, etc.). */
export function newImageObjectKey(accountId: string, requestId: string): string {
  const { acct, req, rand } = mediaKeyParts(accountId, requestId);
  return `image/${acct}/${req}-${rand}.png`;
}

export async function mintUploadToken(
  secret: string,
  objectKey: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; exp: number }> {
  const exp = nowSec + UPLOAD_TTL_SEC;
  return { token: await sign(secret, "u", exp, objectKey), exp };
}

export async function mintDownloadToken(
  secret: string,
  objectKey: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; exp: number }> {
  const exp = nowSec + DOWNLOAD_TTL_SEC;
  return { token: await sign(secret, "d", exp, objectKey), exp };
}

export function mediaPublicUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${path}`;
}

export function mediaSigningSecret(env: { CF_AIG_TOKEN?: string }): string | null {
  const s = env.CF_AIG_TOKEN;
  return typeof s === "string" && s.length >= 16 ? s : null;
}
