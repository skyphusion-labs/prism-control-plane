// Shared constants for Deepgram Flux live STT (no cloudflare:workers import).

export const FLUX_STT_MODEL = "@cf/deepgram/flux";

/** Published $0.0077 per audio minute (websocket) -> micro-USD. */
export const FLUX_DEFAULT_UNIT_MICRO = 7700;
