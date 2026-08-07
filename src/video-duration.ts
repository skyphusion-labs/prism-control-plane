// Per-model video duration limits from Cloudflare AI model docs (2026-08-06).
// Clients may send `duration` (seconds) or Veo-style `"8s"`; we clamp to the model.

export type VideoDurationWire = number | string;

export interface VideoDurationSpec {
  /** Inclusive lower bound in seconds (for continuous ranges). */
  min: number;
  /** Inclusive upper bound in seconds. */
  max: number;
  /** Default when client omits duration. */
  defaultSec: number;
  /**
   * When set, only these second values are legal (discrete oneOf / enum).
   * Continuous models leave this undefined and use min..max.
   */
  allowedSec?: readonly number[];
  /** How the upstream body wants duration (Veo uses "4s"/"6s"/"8s"). */
  wire: "int" | "veo_string";
}

/**
 * Resolve duration policy for a catalog model id.
 * Unknown models get a conservative 1–15 continuous range, default 5.
 */
export function videoDurationSpec(modelId: string): VideoDurationSpec {
  // xAI Grok: integer 1–15
  if (modelId.startsWith("xai/grok-imagine-video")) {
    return { min: 1, max: 15, defaultSec: 5, wire: "int" };
  }
  // ByteDance Seedance: integer 4–12, default 5
  if (modelId.startsWith("bytedance/seedance")) {
    return { min: 4, max: 12, defaultSec: 5, wire: "int" };
  }
  // Google Veo: string enum 4s | 6s | 8s
  if (modelId.startsWith("google/veo")) {
    return {
      min: 4,
      max: 8,
      defaultSec: 8,
      allowedSec: [4, 6, 8],
      wire: "veo_string",
    };
  }
  // MiniMax Hailuo: CF oneOf; docs/examples use 6 (and historically 6|10)
  if (modelId.startsWith("minimax/hailuo")) {
    return { min: 6, max: 10, defaultSec: 6, allowedSec: [6, 10], wire: "int" };
  }
  // Runway Gen-4.5: integer 2–10, default 5
  if (modelId.startsWith("runwayml/")) {
    return { min: 2, max: 10, defaultSec: 5, wire: "int" };
  }
  // Alibaba HappyHorse: 3–15
  if (
    modelId === "alibaba/hh1-t2v" ||
    modelId === "alibaba/hh1-i2v" ||
    modelId === "alibaba/hh1.1-t2v" ||
    modelId === "alibaba/hh1.1-i2v"
  ) {
    return { min: 3, max: 15, defaultSec: 5, wire: "int" };
  }
  // Alibaba Wan 2.7 i2v: 2–15
  if (modelId === "alibaba/wan-2.7-i2v" || modelId.startsWith("alibaba/wan")) {
    return { min: 2, max: 15, defaultSec: 5, wire: "int" };
  }
  // PixVerse v6: 1–15; v5.6 is discrete 5|8
  if (modelId === "pixverse/v6") {
    return { min: 1, max: 15, defaultSec: 5, wire: "int" };
  }
  if (modelId.startsWith("pixverse/")) {
    return { min: 5, max: 8, defaultSec: 5, allowedSec: [5, 8], wire: "int" };
  }
  // Vidu Q3: 1–16
  if (modelId.startsWith("vidu/")) {
    return { min: 1, max: 16, defaultSec: 5, wire: "int" };
  }
  return { min: 1, max: 15, defaultSec: 5, wire: "int" };
}

/**
 * Parse client duration: number seconds, or Veo-style "8s" / "8".
 * Returns null when absent or unparsable (caller uses model default).
 */
export function parseClientDuration(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.round(raw);
  }
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase();
    if (!t) return null;
    const m = /^(\d+)\s*s?$/.exec(t);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Clamp requested seconds to the model policy.
 * Discrete models snap to the nearest allowed value.
 */
export function clampVideoDurationSec(modelId: string, requestedSec: number | null): number {
  const spec = videoDurationSpec(modelId);
  const base =
    requestedSec === null || !Number.isFinite(requestedSec) ? spec.defaultSec : requestedSec;
  if (spec.allowedSec && spec.allowedSec.length > 0) {
    let best = spec.allowedSec[0]!;
    let bestDist = Math.abs(best - base);
    for (const a of spec.allowedSec) {
      const d = Math.abs(a - base);
      if (d < bestDist) {
        best = a;
        bestDist = d;
      }
    }
    return best;
  }
  const n = Math.round(base);
  return Math.min(spec.max, Math.max(spec.min, n));
}

/** Upstream wire value for buildVideoParams. */
export function wireVideoDuration(modelId: string, seconds: number): VideoDurationWire {
  const spec = videoDurationSpec(modelId);
  if (spec.wire === "veo_string") {
    return `${seconds}s`;
  }
  return seconds;
}

/**
 * Full resolve: client raw → clamped seconds + wire form.
 */
export function resolveVideoDuration(
  modelId: string,
  clientRaw: unknown,
): { seconds: number; wire: VideoDurationWire } {
  const seconds = clampVideoDurationSec(modelId, parseClientDuration(clientRaw));
  return { seconds, wire: wireVideoDuration(modelId, seconds) };
}

/** Public shape for clients / OpenAPI (seconds). */
export function videoDurationLimitsPublic(modelId: string): {
  min: number;
  max: number;
  default: number;
  allowed?: number[];
} {
  const s = videoDurationSpec(modelId);
  return {
    min: s.min,
    max: s.max,
    default: s.defaultSec,
    ...(s.allowedSec ? { allowed: [...s.allowedSec] } : {}),
  };
}
