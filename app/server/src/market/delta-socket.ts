import type { Ticker } from './delta.js';

/**
 * Delta's public ticker feed, over a socket.
 *
 * The board used to be a REST call every eight seconds: a full download of
 * every option ticker, whether or not anything had changed, and a board that
 * was on average four seconds old. The exchange also publishes every ticker
 * the moment it changes, on `v2/ticker`, with the same fields the REST call
 * returns. So the feed is read from there, and the REST poll becomes what it
 * should have been -- the thing that runs when the socket is not delivering.
 *
 * The feed is *only* a way of filling the ticker cache faster. Nothing
 * downstream knows where a batch came from: `liveTickers()` still hands back
 * one array, `liveChain` still reads it, the probabilities are still worked
 * out from it. Public channel, no key, no authentication -- the desk's
 * credentials never go near this socket, and it can never place anything.
 *
 * Three habits, each for a reason:
 *
 * - **Batches, not messages.** Delta sends about 250 tickers a second across
 *   every product it lists. Each BTC option update lands in a map; the map
 *   becomes a new batch at most once a second, and only if something changed.
 *   The rest of the server sees a board that moves once a second, not a
 *   storm.
 * - **Non-BTC-option messages are dropped before they are parsed.** A
 *   substring check costs nothing; parsing a thousand perpetual-swap tickers a
 *   second to throw them away would not.
 * - **Silence is treated as failure.** A socket that is open and says nothing
 *   is worse than one that is closed, because nothing notices. No message for
 *   `STALE_MS` and the connection is dropped and remade, and the REST poll
 *   takes over until it is back.
 */

export const SOCKET_URL = 'wss://socket.india.delta.exchange';
/** The batch is rebuilt at most this often. */
export const SNAPSHOT_MS = 1_000;
/** No message for this long and the socket is not a feed. */
export const STALE_MS = 20_000;
/** A ticker that has not been updated for this long has been delisted. */
export const PRUNE_MS = 15 * 60_000;
const RECONNECT_MAX_MS = 30_000;

/** The subset of the WHATWG WebSocket a feed needs, so a test can hand in a fake. */
export type SocketLike = {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type FeedHealth = {
  /** Where the board is coming from right now. */
  source: 'socket' | 'rest' | 'none';
  connected: boolean;
  lastMessageAt: number | null;
  /** How many BTC option tickers the socket is holding. */
  symbols: number;
  reconnects: number;
};

/** Cheap pre-filter: is this message worth parsing at all? */
export const looksLikeBtcOption = (raw: string): boolean =>
  raw.includes('"underlying_asset_symbol":"BTC"')
  && (raw.includes('"call_options"') || raw.includes('"put_options"'));

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A socket ticker as the REST `Ticker` the rest of the server reads.
 *
 * Same field names, same string-typed numbers; only the fields the chain uses
 * are carried, so a shape the exchange adds tomorrow cannot change a batch.
 * Null when the message is not a BTC option or is missing the one thing a
 * ticker cannot do without.
 */
export function tickerOf(m: Record<string, unknown>): Ticker | null {
  if (m.type !== 'v2/ticker') return null;
  const symbol = str(m.symbol);
  const contractType = str(m.contract_type);
  if (!symbol || m.underlying_asset_symbol !== 'BTC') return null;
  if (contractType !== 'call_options' && contractType !== 'put_options') return null;
  const strike = str(m.strike_price);
  const mark = str(m.mark_price);
  const spot = str(m.spot_price);
  if (!strike || !mark || !spot) return null;
  const g = m.greeks as Record<string, unknown> | null | undefined;
  const q = m.quotes as Record<string, unknown> | null | undefined;
  return {
    symbol,
    contract_type: contractType,
    underlying_asset_symbol: 'BTC',
    strike_price: strike,
    close: numOrNull(m.close),
    mark_price: mark,
    spot_price: spot,
    oi: str(m.oi) ?? '0',
    oi_contracts: str(m.oi_contracts) ?? undefined,
    volume: numOrNull(m.volume) ?? 0,
    greeks: g
      ? {
          delta: str(g.delta) ?? '0', gamma: str(g.gamma) ?? '0', theta: str(g.theta) ?? '0',
          vega: str(g.vega) ?? '0', rho: str(g.rho) ?? '0', spot: str(g.spot) ?? spot,
        }
      : null,
    quotes: q
      ? {
          best_bid: str(q.best_bid), best_ask: str(q.best_ask),
          bid_size: str(q.bid_size), ask_size: str(q.ask_size),
          mark_iv: str(q.mark_iv), bid_iv: str(q.bid_iv), ask_iv: str(q.ask_iv),
        }
      : null,
  };
}

export class TickerSocket {
  private readonly held = new Map<string, { t: Ticker; at: number }>();
  private socket: SocketLike | null = null;
  private dirty = false;
  private stopped = true;
  private lastMessageAt: number | null = null;
  private reconnects = 0;
  private backoffMs = 1_000;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSpot: number | null = null;

  constructor(private readonly o: {
    /** A new batch: every BTC option ticker the socket holds, and the freshest spot. */
    onBatch: (data: Ticker[], at: number, spot: number | null) => void;
    connect?: () => SocketLike;
    now?: () => number;
    log?: (line: string) => void;
    snapshotMs?: number;
    staleMs?: number;
  }) {}

  private now() { return this.o.now?.() ?? Date.now(); }
  private log(line: string) { this.o.log?.(line); }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
    this.snapshotTimer = setInterval(() => this.snapshot(), this.o.snapshotMs ?? SNAPSHOT_MS);
    this.snapshotTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.snapshotTimer = null;
    this.reconnectTimer = null;
    this.drop();
  }

  /**
   * A REST batch, taken as the truth about which contracts exist.
   *
   * The socket only ever hears about tickers that change, so on a cold start
   * it knows nothing, and after settlement it would go on holding a contract
   * that no longer exists until the prune caught it. A REST batch answers
   * both: the map becomes exactly that batch, and the socket updates it from
   * there.
   */
  seed(data: Ticker[]): void {
    const at = this.now();
    this.held.clear();
    for (const t of data) this.held.set(t.symbol, { t, at });
  }

  health(): FeedHealth {
    const now = this.now();
    const fresh = this.lastMessageAt !== null && now - this.lastMessageAt < (this.o.staleMs ?? STALE_MS);
    return {
      source: fresh && this.socket ? 'socket' : this.held.size ? 'rest' : 'none',
      connected: this.socket !== null,
      lastMessageAt: this.lastMessageAt,
      symbols: this.held.size,
      reconnects: this.reconnects,
    };
  }

  /** True while the socket has spoken recently: the REST poll can stand down. */
  fresh(now = this.now()): boolean {
    return this.socket !== null && this.lastMessageAt !== null && now - this.lastMessageAt < (this.o.staleMs ?? STALE_MS);
  }

  /** One raw message from the wire. Public so a test can feed the parser directly. */
  receive(raw: unknown): void {
    this.lastMessageAt = this.now();
    if (typeof raw !== 'string' || !looksLikeBtcOption(raw)) return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    const t = tickerOf(m);
    if (!t) return;
    this.held.set(t.symbol, { t, at: this.lastMessageAt });
    const spot = Number(t.spot_price);
    if (Number.isFinite(spot) && spot > 0) this.lastSpot = spot;
    this.dirty = true;
  }

  /** Hand the batch on if anything changed since the last one. */
  snapshot(): void {
    // A silent open socket is a dead one; say so by dropping it, which is
    // what starts the reconnect and lets the REST poll notice.
    if (this.socket && this.lastMessageAt !== null && this.now() - this.lastMessageAt >= (this.o.staleMs ?? STALE_MS)) {
      this.log('ticker socket silent; reconnecting');
      this.drop();
      this.scheduleReconnect();
    }
    if (!this.dirty) return;
    this.dirty = false;
    const now = this.now();
    for (const [symbol, h] of this.held) {
      if (now - h.at > PRUNE_MS) this.held.delete(symbol);
    }
    this.o.onBatch([...this.held.values()].map((h) => h.t), now, this.lastSpot);
  }

  private open(): void {
    if (this.stopped) return;
    let ws: SocketLike;
    try {
      ws = this.o.connect ? this.o.connect() : (new WebSocket(SOCKET_URL) as unknown as SocketLike);
    } catch (e) {
      this.log(`ticker socket could not open: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      this.backoffMs = 1_000;
      this.lastMessageAt = this.now();
      ws.send(JSON.stringify({ type: 'enable_heartbeat' }));
      ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [{ name: 'v2/ticker', symbols: ['all'] }] } }));
      this.log('ticker socket open');
    };
    ws.onmessage = (ev) => this.receive(ev.data);
    ws.onerror = () => { /* the close that follows carries the reconnect */ };
    ws.onclose = (ev) => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.log(`ticker socket closed (${ev.code ?? '?'})`);
      this.scheduleReconnect();
    };
  }

  private drop(): void {
    const ws = this.socket;
    this.socket = null;
    if (!ws) return;
    ws.onclose = null;
    try { ws.close(); } catch { /* already gone */ }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(RECONNECT_MAX_MS, this.backoffMs * 2);
    this.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, wait);
    this.reconnectTimer.unref?.();
  }
}
