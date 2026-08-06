// Unauthenticated media ingress (xAI PUT) and signed download (client GET).
// Auth is the HMAC token in the path, not a pcp_ bearer.

import type { Env } from "../env";
import { errorResponse } from "../http";
import {
  MEDIA_MAX_BYTES,
  mediaSigningSecret,
  verifyMediaToken,
} from "../media";

const INGRESS_PATH = /^\/v1\/media\/ingress\/([A-Za-z0-9._-]+)$/;
const DOWNLOAD_PATH = /^\/v1\/media\/([A-Za-z0-9._-]+)$/;

export function matchMediaIngress(path: string): string | null {
  const m = INGRESS_PATH.exec(path);
  return m ? m[1] : null;
}

export function matchMediaDownload(path: string): string | null {
  // Do not steal /v1/media/ingress/*
  if (path.startsWith("/v1/media/ingress/")) return null;
  const m = DOWNLOAD_PATH.exec(path);
  return m ? m[1] : null;
}

export async function handleMediaIngress(
  env: Env,
  request: Request,
  token: string,
  requestId: string,
): Promise<Response> {
  if (request.method !== "PUT" && request.method !== "POST") {
    return errorResponse(requestId, "invalid_request", "Media ingress accepts PUT (or POST).");
  }
  const secret = mediaSigningSecret(env);
  if (!secret) {
    return errorResponse(requestId, "unavailable", "Media signing is not configured.");
  }
  if (!env.MEDIA) {
    return errorResponse(requestId, "unavailable", "MEDIA R2 binding is not configured.");
  }
  const parsed = await verifyMediaToken(secret, token);
  if (!parsed || parsed.kind !== "u") {
    return errorResponse(requestId, "unauthenticated", "Invalid or expired media upload token.");
  }

  const lenHeader = request.headers.get("content-length");
  if (lenHeader) {
    const n = Number(lenHeader);
    if (Number.isFinite(n) && n > MEDIA_MAX_BYTES) {
      return errorResponse(
        requestId,
        "invalid_request",
        `Upload exceeds ${MEDIA_MAX_BYTES} byte limit.`,
      );
    }
  }

  const body = request.body;
  if (!body) {
    return errorResponse(requestId, "invalid_request", "Empty upload body.");
  }

  // Stream into R2 with a hard size guard via tee + count when content-length missing.
  let putBody: ReadableStream | ArrayBuffer = body;
  if (!lenHeader) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MEDIA_MAX_BYTES) {
      return errorResponse(
        requestId,
        "invalid_request",
        `Upload exceeds ${MEDIA_MAX_BYTES} byte limit.`,
      );
    }
    if (buf.byteLength === 0) {
      return errorResponse(requestId, "invalid_request", "Empty upload body.");
    }
    putBody = buf;
  }

  const contentType = request.headers.get("content-type") ?? "video/mp4";
  await env.MEDIA.put(parsed.objectKey, putBody, {
    httpMetadata: { contentType },
    customMetadata: { source: "xai-zdr-ingress" },
  });

  return new Response(null, { status: 204 });
}

/**
 * Poll R2 until the object appears or `maxMs` elapses.
 * Grok ZDR often Completes before the PUT to output.upload_url finishes;
 * returning the signed URL too early leaves clients with 404 / unplayable AVPlayer.
 */
export async function waitForMediaObject(
  bucket: R2Bucket,
  objectKey: string,
  maxMs: number = 45_000,
  stepMs: number = 1_000,
): Promise<R2Object | null> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const head = await bucket.head(objectKey);
    if (head) return head;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(stepMs, remaining)));
  }
  return bucket.head(objectKey);
}

/** Parse `Range: bytes=start-end` (single range only). */
export function parseBytesRange(
  header: string | null,
  size: number,
): { offset: number; length: number; start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m) return null;
  const startRaw = m[1];
  const endRaw = m[2];
  if (startRaw === "" && endRaw === "") return null;
  let start: number;
  let end: number;
  if (startRaw === "") {
    // suffix: last N bytes
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? size - 1 : Number(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) return "unsatisfiable";
    if (start >= size) return "unsatisfiable";
    end = Math.min(end, size - 1);
    if (end < start) return "unsatisfiable";
  }
  return { offset: start, length: end - start + 1, start, end };
}

export async function handleMediaDownload(
  env: Env,
  request: Request,
  token: string,
  requestId: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(requestId, "invalid_request", "Media download accepts GET or HEAD.");
  }
  const secret = mediaSigningSecret(env);
  if (!secret) {
    return errorResponse(requestId, "unavailable", "Media signing is not configured.");
  }
  if (!env.MEDIA) {
    return errorResponse(requestId, "unavailable", "MEDIA R2 binding is not configured.");
  }
  const parsed = await verifyMediaToken(secret, token);
  if (!parsed || parsed.kind !== "d") {
    return errorResponse(requestId, "unauthenticated", "Invalid or expired media download token.");
  }

  // Head first so we know size for Range (AVPlayer requires Accept-Ranges + 206).
  const head = await env.MEDIA.head(parsed.objectKey);
  if (!head) {
    return errorResponse(requestId, "not_found", "Media object not found.");
  }

  const size = head.size;
  const isMusic = parsed.objectKey.startsWith("music/");
  const contentType =
    head.httpMetadata?.contentType ?? (isMusic ? "audio/mpeg" : "video/mp4");
  const disposition = isMusic
    ? 'inline; filename="prism-music.mp3"'
    : 'inline; filename="video.mp4"';

  const baseHeaders = new Headers();
  baseHeaders.set("content-type", contentType);
  baseHeaders.set("cache-control", "private, max-age=3600");
  baseHeaders.set("accept-ranges", "bytes");
  baseHeaders.set("content-disposition", disposition);

  const range = parseBytesRange(request.headers.get("range"), size);

  if (range === "unsatisfiable") {
    baseHeaders.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers: baseHeaders });
  }

  if (range) {
    const obj = await env.MEDIA.get(parsed.objectKey, {
      range: { offset: range.offset, length: range.length },
    });
    if (!obj) {
      return errorResponse(requestId, "not_found", "Media object not found.");
    }
    baseHeaders.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    baseHeaders.set("content-length", String(range.length));
    if (request.method === "HEAD") {
      return new Response(null, { status: 206, headers: baseHeaders });
    }
    return new Response(obj.body, { status: 206, headers: baseHeaders });
  }

  baseHeaders.set("content-length", String(size));
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: baseHeaders });
  }
  const obj = await env.MEDIA.get(parsed.objectKey);
  if (!obj) {
    return errorResponse(requestId, "not_found", "Media object not found.");
  }
  return new Response(obj.body, { status: 200, headers: baseHeaders });
}
