/**
 * The desk, pushed.
 *
 * The screen used to ask three times a second -- status, price, and the
 * board every five -- and every answer was the same as the one before it far
 * more often than not. Server-Sent Events turn that round: one connection per
 * tab, and the server writes when something changes.
 *
 * SSE rather than a WebSocket, deliberately. Everything on this desk flows one
 * way -- the server tells, the browser acts through ordinary POSTs that carry
 * the session and the origin check like any other -- so a two-way socket would
 * be a second way in that needs its own authentication and its own
 * cross-origin rules. An EventSource is a GET with a cookie: the gate in
 * `app.ts` applies to it unchanged, the browser reconnects on its own, and it
 * passes through nginx as HTTP.
 *
 * The hub knows nothing about Fastify. It holds sinks, remembers the last
 * frame of each event so a tab that connects (or reconnects) sees the current
 * picture at once, and sends only what changed. A tick that repeats the last
 * answer is not sent, which is the whole saving.
 */

export type Sink = { write(chunk: string): void };

/** One SSE frame. `data` is one line of JSON, so no line splitting is needed. */
export const sseFrame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class StreamHub {
  private readonly sinks = new Set<Sink>();
  private readonly last = new Map<string, string>();

  get size(): number { return this.sinks.size; }

  /** A new listener, given the current picture at once. Returns its leave. */
  add(sink: Sink): () => void {
    this.sinks.add(sink);
    for (const frame of this.last.values()) this.write(sink, frame);
    return () => { this.sinks.delete(sink); };
  }

  /** True when this was news: the frame differed from the last one sent. */
  publish(event: string, data: unknown): boolean {
    const frame = sseFrame(event, data);
    if (this.last.get(event) === frame) return false;
    this.last.set(event, frame);
    for (const sink of this.sinks) this.write(sink, frame);
    return true;
  }

  /** A keep-alive comment: the proxy's read timeout and the phone's radio both count silence. */
  ping(): void {
    for (const sink of this.sinks) this.write(sink, ': ping\n\n');
  }

  private write(sink: Sink, chunk: string): void {
    // A sink that throws is a socket that has gone; it leaves rather than
    // taking the tick down with it.
    try { sink.write(chunk); } catch { this.sinks.delete(sink); }
  }
}
