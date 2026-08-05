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
]);

const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

/** Contract limits. Mirrored in docs/openapi.yaml. */
export const MAX_MESSAGES = 200;
export const MAX_CONTENT_CHARS = 200_000;

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
          "temperature, top_p, and stream; unknown fields are refused rather than dropped so a " +
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

  return { ok: true, value: { model: raw.model.trim(), messages, maxTokens, temperature, topP, stream } };
}
