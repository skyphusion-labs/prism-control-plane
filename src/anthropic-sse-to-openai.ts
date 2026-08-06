// Anthropic Messages SSE → OpenAI chat.completion.chunk SSE.
//
// WHY. Catalog `binding: true` Anthropic models (claude-fable-5) reach the provider via
// env.AI.run and return native Anthropic event frames (message_start, content_block_delta
// with text_delta / thinking_delta, message_delta, message_stop). The control-plane contract
// and every OpenAI-compatible client (prism-ios PrismKit SSEParser, SDKs) expect
// `choices[].delta.content` chunks plus a trailing usage object and `data: [DONE]`.
//
// Relaying Anthropic bytes unchanged produces a "successful" stream with zero text deltas
// on the client → Empty stream completion. This transform is the plane's job: clients must
// not need a per-provider SSE dialect for a door that advertises OpenAI compatibility.
//
// WHAT IT DOES NOT DO. It does not buffer the whole answer. Thinking / signature / tool
// deltas are dropped (same discipline as prism interpretAnthropicSSEFrame). Metering still
// rides the transformed trailing usage frame so SseUsageScanner + meterUsageObject stay one
// reader for all stream paths.

const SENTINELS = new Set(["[DONE]", "[done]"]);

export interface AnthropicToOpenAIState {
  id: string;
  model: string;
  created: number;
  inputTokens: number | null;
  outputTokens: number | null;
  opened: boolean;
  finished: boolean;
}

export function newAnthropicToOpenAIState(opts: {
  id?: string;
  model: string;
  created?: number;
}): AnthropicToOpenAIState {
  return {
    id: opts.id ?? `chatcmpl-${cryptoRandomId()}`,
    model: opts.model,
    created: opts.created ?? Math.floor(Date.now() / 1000),
    inputTokens: null,
    outputTokens: null,
    opened: false,
    finished: false,
  };
}

function cryptoRandomId(): string {
  // Workers and Node both have crypto.getRandomValues; avoid depending on crypto.randomUUID
  // so unit tests stay simple.
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function encodeFrame(payload: unknown | string): string {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `data: ${data}\n\n`;
}

function openChunk(state: AnthropicToOpenAIState): string {
  state.opened = true;
  return encodeFrame({
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });
}

function textChunk(state: AnthropicToOpenAIState, text: string): string {
  return encodeFrame({
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
}

function finishAndUsage(state: AnthropicToOpenAIState): string {
  state.finished = true;
  const finish = encodeFrame({
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  // Trailing usage-only frame: OpenAI stream_options.include_usage shape.
  // SseUsageScanner + meterUsageObject read top-level usage with prompt/completion tokens.
  let usageFrame = "";
  if (state.inputTokens !== null || state.outputTokens !== null) {
    usageFrame = encodeFrame({
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [],
      usage: {
        prompt_tokens: state.inputTokens ?? 0,
        completion_tokens: state.outputTokens ?? 0,
        total_tokens: (state.inputTokens ?? 0) + (state.outputTokens ?? 0),
      },
    });
  }
  return finish + usageFrame + encodeFrame("[DONE]");
}

/**
 * Interpret one Anthropic SSE JSON payload into zero or more OpenAI SSE frames.
 * Pure: only mutates `state` for role-open, usage accumulation, and finish once.
 */
export function anthropicPayloadToOpenAIFrames(
  state: AnthropicToOpenAIState,
  data: unknown,
): string {
  if (typeof data !== "object" || data === null) return "";
  const d = data as Record<string, unknown>;
  const evType = typeof d.type === "string" ? d.type : undefined;
  let out = "";

  if (evType === "message_start") {
    const msg = d.message as
      | { id?: string; usage?: { input_tokens?: number; output_tokens?: number } }
      | undefined;
    if (msg?.id && typeof msg.id === "string") {
      // Prefer provider message id when present (still OpenAI-shaped chunk ids).
      state.id = `chatcmpl-${msg.id.replace(/^msg_/, "")}`;
    }
    if (msg?.usage) {
      if (Number.isInteger(msg.usage.input_tokens)) {
        state.inputTokens = msg.usage.input_tokens as number;
      }
      if (Number.isInteger(msg.usage.output_tokens)) {
        state.outputTokens = msg.usage.output_tokens as number;
      }
    }
    if (!state.opened) out += openChunk(state);
    return out;
  }

  if (evType === "content_block_delta") {
    const delta = d.delta as { type?: string; text?: string } | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      if (!state.opened) out += openChunk(state);
      out += textChunk(state, delta.text);
    }
    // thinking_delta, signature_delta, input_json_delta: dropped
    return out;
  }

  if (evType === "message_delta") {
    const usage = d.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (usage) {
      // message_delta carries final output_tokens; input often only on message_start.
      if (Number.isInteger(usage.input_tokens)) {
        state.inputTokens = usage.input_tokens as number;
      }
      if (Number.isInteger(usage.output_tokens)) {
        state.outputTokens = usage.output_tokens as number;
      }
    }
    return out;
  }

  if (evType === "message_stop") {
    if (!state.finished) {
      if (!state.opened) out += openChunk(state);
      out += finishAndUsage(state);
    }
    return out;
  }

  // content_block_start/stop, ping, error (handled elsewhere), unknown: ignore
  return out;
}

/**
 * Incremental line buffer: feed Anthropic SSE bytes, emit OpenAI SSE bytes.
 */
export class AnthropicSseToOpenAI {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly state: AnthropicToOpenAIState;

  constructor(opts: { model: string; id?: string; created?: number }) {
    this.state = newAnthropicToOpenAIState(opts);
  }

  push(chunk: Uint8Array): Uint8Array {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    let out = "";
    for (const line of lines) out += this.consumeLine(line);
    return this.encoder.encode(out);
  }

  end(): Uint8Array {
    this.buffer += this.decoder.decode();
    let out = "";
    if (this.buffer.length > 0) {
      out += this.consumeLine(this.buffer);
      this.buffer = "";
    }
    // Stream ended without message_stop (client cancel, upstream drop). Still close
    // OpenAI-compat so the client does not hang waiting for [DONE]; usage may be partial.
    if (!this.state.finished) {
      if (!this.state.opened) out += openChunk(this.state);
      out += finishAndUsage(this.state);
    }
    return this.encoder.encode(out);
  }

  private consumeLine(rawLine: string): string {
    const line = rawLine.replace(/\r$/, "");
    // Named `event:` lines are informational; type lives in the JSON payload.
    if (!line.startsWith("data:")) return "";
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0 || SENTINELS.has(payload)) return "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return "";
    }
    return anthropicPayloadToOpenAIFrames(this.state, parsed);
  }
}

/**
 * Transform a ReadableStream of Anthropic SSE bytes into OpenAI chat.completion.chunk SSE.
 */
export function anthropicSseToOpenAIStream(
  source: ReadableStream<Uint8Array>,
  opts: { model: string },
): ReadableStream<Uint8Array> {
  const transformer = new AnthropicSseToOpenAI(opts);
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          const tail = transformer.end();
          if (tail.byteLength > 0) controller.enqueue(tail);
          controller.close();
          return;
        }
        if (value) {
          const out = transformer.push(value);
          if (out.byteLength > 0) controller.enqueue(out);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
