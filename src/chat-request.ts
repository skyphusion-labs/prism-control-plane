// Validating POST /v1/chat/completions bodies. PURE, so every rule in docs/CONTRACT.md is asserted in
// unit tests rather than only exercised by a live call.
//
// UNKNOWN FIELDS ARE REJECTED, not ignored. That is a contract promise and it is the less obvious
// choice, so here is the reasoning: OpenAI-compatible surfaces are full of parameters this plane does
// NOT forward (tools, response_format, logprobs, n, stop, seed). Silently dropping them would let a
// client ship a feature it believes is working -- a JSON schema it thinks is enforced, a tool it thinks
// is callable -- and discover otherwise in production. A 400 naming the field is a bug found in
// development.
//
// The cost accepted: adding a forwarded parameter later is a contract change that older clients cannot
// use. That is fine and additive; the reverse (a parameter that looks accepted and is not) is not.

const ALLOWED_FIELDS = new Set([
  "model",
  "messages",
  "max_tokens",
  "temperature",
  "top_p",
  "stream",
  // Single-shot vision (LLaVA): a data-URL image rides next to messages, not as multiparty content.
  "image",
]);

const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

/** Contract limits. Mirrored in docs/openapi.yaml. */
export const MAX_MESSAGES = 200;
export const MAX_CONTENT_CHARS = 200_000;
/** Max raw image payload once base64-decoded (4 MiB). Vision models are single-shot. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface ChatTurnInput {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ValidChatRequest {
  model: string;
  messages: ChatTurnInput[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stream: boolean;
  /**
   * Optional data-URL image (legacy LLaVA field). Retired with LLaVA 2026-08-05;
   * chat route refuses any image payload.
   */
  imageDataUrl?: string;
  /** Raw image bytes decoded from imageDataUrl, when present. */
  imageBytes?: Uint8Array;
}

export type ChatRequestResult =
  | { ok: true; value: ValidChatRequest }
  | { ok: false; message: string };

function bad(message: string): ChatRequestResult {
  return { ok: false, message };
}

export function parseChatRequest(body: unknown): ChatRequestResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return bad("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return bad(
        `Unknown field "${key}". This plane forwards only model, messages, max_tokens, ` +
          "temperature, top_p, stream, and image; unknown fields are refused rather than dropped so a " +
          "client never believes it sent a parameter that was ignored.",
      );
    }
  }

  if (typeof raw.model !== "string" || !raw.model.trim()) {
    return bad('"model" is required and must be a non-empty string.');
  }

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return bad('"messages" is required and must be a non-empty array.');
  }
  if (raw.messages.length > MAX_MESSAGES) {
    return bad(`"messages" has ${raw.messages.length} entries; the cap is ${MAX_MESSAGES}.`);
  }
  const messages: ChatTurnInput[] = [];
  for (let i = 0; i < raw.messages.length; i++) {
    const turn = raw.messages[i];
    if (typeof turn !== "object" || turn === null || Array.isArray(turn)) {
      return bad(`messages[${i}] must be an object.`);
    }
    const asRecord = turn as Record<string, unknown>;
    for (const key of Object.keys(asRecord)) {
      if (key !== "role" && key !== "content") {
        return bad(`messages[${i}] has unknown field "${key}"; only role and content are accepted.`);
      }
    }
    if (typeof asRecord.role !== "string" || !ALLOWED_ROLES.has(asRecord.role)) {
      return bad(`messages[${i}].role must be one of system, user, assistant.`);
    }
    // Content must be a STRING. The OpenAI multi-part content array (text plus image parts) is not
    // forwarded, so accepting it would be the exact silent-drop this validator refuses to do.
    if (typeof asRecord.content !== "string") {
      return bad(
        `messages[${i}].content must be a string. Multi-part content arrays are not forwarded by ` +
          "this plane.",
      );
    }
    if (asRecord.content.length > MAX_CONTENT_CHARS) {
      return bad(
        `messages[${i}].content is ${asRecord.content.length} characters; the cap is ${MAX_CONTENT_CHARS}.`,
      );
    }
    messages.push({ role: asRecord.role as ChatTurnInput["role"], content: asRecord.content });
  }

  let maxTokens: number | undefined;
  if (raw.max_tokens !== undefined) {
    if (!Number.isInteger(raw.max_tokens) || (raw.max_tokens as number) < 1) {
      return bad('"max_tokens" must be a positive integer when present.');
    }
    maxTokens = raw.max_tokens as number;
  }

  let temperature: number | undefined;
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature)) {
      return bad('"temperature" must be a finite number when present.');
    }
    // The contract's range is 0..2 (the OpenAI range), which is NARROWER than what some Workers AI
    // models accept (0..5). Publishing the narrower, portable range keeps one client-visible rule
    // across every catalog entry instead of a per-model range a client would have to look up.
    if (raw.temperature < 0 || raw.temperature > 2) {
      return bad('"temperature" must be between 0 and 2.');
    }
    temperature = raw.temperature;
  }

  let topP: number | undefined;
  if (raw.top_p !== undefined) {
    if (typeof raw.top_p !== "number" || !Number.isFinite(raw.top_p)) {
      return bad('"top_p" must be a finite number when present.');
    }
    if (raw.top_p <= 0 || raw.top_p > 1) {
      return bad('"top_p" must be greater than 0 and at most 1.');
    }
    topP = raw.top_p;
  }

  let stream = false;
  if (raw.stream !== undefined) {
    if (typeof raw.stream !== "boolean") return bad('"stream" must be a boolean when present.');
    stream = raw.stream;
  }

  let imageDataUrl: string | undefined;
  let imageBytes: Uint8Array | undefined;
  if (raw.image !== undefined) {
    if (typeof raw.image !== "string" || !raw.image.trim()) {
      return bad('"image" must be a non-empty data URL string when present.');
    }
    const parsed = parseImageDataUrl(raw.image.trim());
    if (!parsed.ok) return bad(parsed.message);
    imageDataUrl = raw.image.trim();
    imageBytes = parsed.bytes;
  }

  return {
    ok: true,
    value: {
      model: raw.model.trim(),
      messages,
      maxTokens,
      temperature,
      topP,
      stream,
      imageDataUrl,
      imageBytes,
    },
  };
}

/**
 * Decode a `data:image/...;base64,...` URL into raw bytes.
 * Refuses anything that is not a data URL or is over MAX_IMAGE_BYTES once decoded.
 */
export function parseImageDataUrl(
  dataUrl: string,
): { ok: true; bytes: Uint8Array; mime: string } | { ok: false; message: string } {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) {
    return {
      ok: false,
      message:
        '"image" must be a data URL of the form data:image/<type>;base64,... (https URLs and bare base64 are refused).',
    };
  }
  const mime = match[1].toLowerCase();
  const b64 = match[2].replace(/\s+/g, "");
  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return { ok: false, message: '"image" base64 payload could not be decoded.' };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, message: '"image" decoded to zero bytes.' };
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      message: `"image" is ${bytes.byteLength} bytes decoded; the cap is ${MAX_IMAGE_BYTES}.`,
    };
  }
  return { ok: true, bytes, mime };
}

