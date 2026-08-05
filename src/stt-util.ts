// Pure helpers for the conversational STT (Flux) session. No cloudflare:workers import.

/** WebSocket.close only accepts 1000 or 3000-4999. */
export function sanitizeCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011;
}

/** Integer audio minutes to bill: at least 1, ceil of wall-clock seconds / 60. */
export function billableAudioMinutes(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 1;
  return Math.max(1, Math.ceil(durationSec / 60));
}
