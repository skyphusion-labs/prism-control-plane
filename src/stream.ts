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

/** SSE data payloads that are not JSON. `[DONE]` is the OpenAI sentinel. */
const SENTINELS = new Set(["[DONE]", "[done]"]);

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
    const usage = (parsed as { usage?: unknown }).usage;
    // LAST ONE WINS. Some providers repeat a partial usage on intermediate frames and only the final frame
    // is complete, so overwriting is correct and taking the first would under-report.
    if (usage !== undefined && usage !== null) this.lastUsage = usage;
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
}

export interface StreamSettlement {
  /** The trailing usage object, or null. */
  usage: unknown;
  /** Whether any frame was recognized. */
  sawFrames: boolean;
  /** True when the stream ended by error or client disconnect rather than cleanly. */
  aborted: boolean;
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
  const settleOnce = (aborted: boolean): void => {
    if (settled) return;
    settled = true;
    scanner.end();
    try {
      settle({ usage: scanner.usage(), sawFrames: scanner.sawFrames(), aborted });
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
          settleOnce(false);
          controller.close();
          return;
        }
        if (value) {
          scanner.push(value);
          controller.enqueue(value);
        }
      } catch (err) {
        settleOnce(true);
        controller.error(err);
      }
    },
    cancel(reason) {
      // The client hung up. Settle with what we have: a half-consumed stream was still generated and
      // billed upstream, so it belongs in the ledger as an unmetered row rather than vanishing.
      settleOnce(true);
      return reader.cancel(reason);
    },
  });
}
