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

  const obj = await env.MEDIA.get(parsed.objectKey);
  if (!obj) {
    return errorResponse(requestId, "not_found", "Media object not found.");
  }

  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType ?? "video/mp4");
  headers.set("cache-control", "private, max-age=3600");
  if (obj.size != null) headers.set("content-length", String(obj.size));
  headers.set("content-disposition", 'inline; filename="video.mp4"');

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}
