// Metering a stream you are also relaying, without buffering it.
//
// THE PROBLEM. A streamed completion's token counts arrive LAST, in a trailing usage frame, long after the
// response headers have gone out. So a streamed request cannot carry its price in a header, and the ledger
// row for it cannot be written before the client is answered. Either the plane buffers the whole stream to
// meter it -- which defeats the point of streaming and holds a Worker open on the full response -- or it
// watches the bytes go past and settles up at the end. This file does the second.
//
// WHAT IT IS NOT. It is not a parser of the client's stream. The bytes are relayed UNCHANGED from
// whatever the runner already produced (OpenAI-shaped upstreams, or Anthropic binding streams after
// anthropic-sse-to-openai). The scanner is a passive reader: if it understands nothing, the client
// still gets a correct stream and the request lands in the ledger unmetered. A metering bug must
// never be able to corrupt a paid-for answer.
//
// THE UNMETERED CASE IS FIRST-CLASS, not an error. `stream_options: { include_usage: true }` is sent on
// every streamed call, but a provider that ignores it, a client that disconnects mid-stream, or a frame
// shape nobody has seen yet all end the same way: no usage, so an unmetered ledger row saying exactly that.
// Silently charging zero would be a lie in the direction that costs the host money invisibly.

// WHY THE SCANNER ALSO COUNTS BYTES (issue #99). A client that hangs up mid-stream leaves no usage
// frame, and until #99 that request was recorded unmetered. Conrad ruled on 2026-10-08 that it is
// charged from an estimate instead. An estimate needs a quantity, and the only honest one available
// is how much assistant text actually came past before the cut. So the scanner keeps a running total
// of received output bytes. It still never changes a byte of the relay, and it still cannot fail the
// stream: the counter is only read when the stream has already ended.

/** SSE data payloads that are not JSON. `[DONE]` is the OpenAI sentinel. */
const SENTINELS = new Set(["[DONE]", "[done]"]);

/** One shared encoder. Used only to size received text, never to produce output. */
const SIZER = new TextEncoder();

/**
 * A line-oriented, incremental reader for `data:` payloads in an SSE byte stream.
 *
 * Written as a class over `push(chunk)` rather than as a stream transform so that the frame handling can
 * be tested against hand-built byte sequences -- including a usage object split across two chunks, which
 * is the case that a naive per-chunk JSON.parse gets wrong.
 */
export class SseUsageScanner {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private lastUsage: unknown = null;
  private sawAnyFrame = false;
  private outputBytes = 0;

  /** Feed the next chunk of the relayed stream. Never throws: see the header. */
  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    // Frames are separated by a blank line, but providers differ on \n vs \r\n and on whether a heartbeat
    // comment appears between frames. Splitting on single newlines and reading only `data:` lines is
    // tolerant of all of that, and a JSON payload never contains a raw newline.
    const lines = this.buffer.split("\n");
    // Keep the last element: it may be a partial line whose remainder is in the next chunk.
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.consumeLine(line);
  }

  /** Flush the decoder and the final partial line. Call once when the stream ends. */
  end(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer);
      this.buffer = "";
    }
  }

  private consumeLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0 || SENTINELS.has(payload)) return;
    this.sawAnyFrame = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A payload we cannot parse is not a failure of the response, only of our understanding of it.
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    // Chat-completions frames carry usage at the top level; the Responses API reports it on the terminal
    // response.completed event as response.usage. Reading only the first shape would leave a completed
    // Responses stream unmetered.
    const frame = parsed as { usage?: unknown; response?: { usage?: unknown } | null };
    const usage = frame.usage ?? frame.response?.usage;
    // LAST ONE WINS. Some providers repeat a partial usage on intermediate frames and only the final frame
    // is complete, so overwriting is correct and taking the first would under-report.
    if (usage !== undefined && usage !== null) this.lastUsage = usage;
    this.countOutputText(parsed);
  }

  /**
   * Add this frame's assistant text to the received-output total.
   *
   * BOTH WIRE SHAPES, for the same reason `usage` reads both: chat-completions carries the text at
   * `choices[].delta.content`, the Responses API carries it on `response.output_text.delta` events.
   * Counting only the first shape would silently estimate every cancelled Responses stream at zero.
   *
   * WHAT IS DELIBERATELY NOT COUNTED: streamed reasoning text, tool-call arguments, and any other
   * field a provider may bill as output. Each of those would RAISE the estimate, and an estimate must
   * not overshoot, so leaving them out keeps the error on the customer's side. Reconcile is what
   * recovers the difference.
   */
  private countOutputText(parsed: unknown): void {
    const frame = parsed as { choices?: unknown; type?: unknown; delta?: unknown };
    if (Array.isArray(frame.choices)) {
      for (const choice of frame.choices) {
        if (typeof choice !== "object" || choice === null) continue;
        const delta = (choice as { delta?: unknown }).delta;
        if (typeof delta !== "object" || delta === null) continue;
        const content = (delta as { content?: unknown }).content;
        if (typeof content === "string") this.outputBytes += SIZER.encode(content).byteLength;
      }
    }
    if (frame.type === "response.output_text.delta" && typeof frame.delta === "string") {
      this.outputBytes += SIZER.encode(frame.delta).byteLength;
    }
  }

  /** The trailing usage object, or null when none arrived. */
  usage(): unknown {
    return this.lastUsage;
  }

  /**
   * Whether any JSON frame was seen at all.
   *
   * This separates "the provider streamed but told us no usage" from "we received nothing recognizable",
   * which are different operator problems and get different unmetered reasons in the ledger.
   */
  sawFrames(): boolean {
    return this.sawAnyFrame;
  }

  /**
   * UTF-8 bytes of assistant text seen so far.
   *
   * A LOWER BOUND, never a total. It counts what reached us, which on a cancelled stream is less than
   * what the upstream generated and billed. That is exactly why it may only feed an estimate that
   * rounds down.
   */
  outputTextBytes(): number {
    return this.outputBytes;
  }
}

export interface StreamSettlement {
  /** The trailing usage object, or null. */
  usage: unknown;
  /** Whether any frame was recognized. */
  sawFrames: boolean;
  /**
   * How the stream ended.
   *
   * THREE STATES AND NOT A BOOLEAN, because issue #99 made the difference pay money. `cancelled` is
   * the client hanging up on a stream the upstream was still generating, and it is the ONE case that
   * is charged from an estimate. `error` is the upstream or the transport failing: the customer got a
   * broken stream, so it stays unmetered rather than being charged a guess. An earlier `aborted`
   * boolean could not tell those two apart.
   */
  termination: "complete" | "cancelled" | "error";
  /** UTF-8 bytes of assistant text received. A lower bound on what was generated. */
  outputTextBytes: number;
}

/**
 * Relay `source` unchanged while scanning it, and settle up exactly once when it ends.
 *
 * `settle` is invoked on EVERY termination -- clean end, upstream error, client disconnect -- because all
 * three are spend that happened. It is invoked at most once. It is called with whatever the scanner
 * managed to see, which on an early disconnect is usually nothing, and that is the honest answer.
 *
 * The returned stream is what goes to the client. Errors on the source are propagated rather than
 * swallowed: a client that received half an answer must see the stream fail, not see it end normally and
 * conclude the model stopped talking.
 */
export function meteredRelay(
  source: ReadableStream<Uint8Array>,
  settle: (settlement: StreamSettlement) => void,
): ReadableStream<Uint8Array> {
  const scanner = new SseUsageScanner();
  let settled = false;
  const settleOnce = (termination: StreamSettlement["termination"]): void => {
    if (settled) return;
    settled = true;
    scanner.end();
    try {
      settle({
        usage: scanner.usage(),
        sawFrames: scanner.sawFrames(),
        termination,
        outputTextBytes: scanner.outputTextBytes(),
      });
    } catch (err) {
      // The settlement is bookkeeping. If it throws, the client's stream has already been delivered and
      // must not be retroactively broken by our accounting.
      console.error("stream settlement failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settleOnce("complete");
          controller.close();
          return;
        }
        if (value) {
          scanner.push(value);
          controller.enqueue(value);
        }
      } catch (err) {
        settleOnce("error");
        controller.error(err);
      }
    },
    cancel(reason) {
      // The client hung up. Settle with what we have: a half-consumed stream was still generated and
      // billed upstream, so it belongs in the ledger. Since #99 it lands as an ESTIMATED charge built
      // from the bytes counted above, not as an unmetered row, because a cancel is not a gap in our
      // knowledge of the price so much as a gap in the stream.
      settleOnce("cancelled");
      return reader.cancel(reason);
    },
  });
}
