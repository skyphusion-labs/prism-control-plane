// Shared constants for Deepgram Flux live STT (no cloudflare:workers import).

export const FLUX_STT_MODEL = "@cf/deepgram/flux";

/** Published $0.0077 per audio minute (websocket) -> micro-USD. */
export const FLUX_DEFAULT_UNIT_MICRO = 7700;

/** Sec-WebSocket-Protocol name for browser auth (never put the key in the URL). */
export const STT_WS_PROTOCOL = "prism.v1";

/**
 * Ticket prefix for browser WebSocket auth.
 * Shape: `stt_<43-char base64url secret>` (same secret entropy as enrollment tokens).
 * Long-lived client keys (`pcp_...`) are never accepted in Sec-WebSocket-Protocol.
 */
export const STT_TICKET_PREFIX = "stt";

/** Default ticket lifetime: long enough to open the socket after mint; short enough to limit replay. */
export const STT_TICKET_TTL_SEC = 60;
