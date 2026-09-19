import { SOCKET_URL, type SocketLike } from './delta-socket.js';

/**
 * The perpetual's public feed: every BTCUSD trade as it prints, and the perp
 * ticker (funding, open interest, turnover) as it changes.
 *
 * This is the order-flow data docs/test.md names as the desk's biggest gap:
 * who is hitting the tape. Delta's REST `trades` call hands back the last 50
 * prints, about forty seconds' worth on an ordinary day and far less in a
 * burst, so polling it would drop exactly the trades that matter. The socket
 * carries every one.
 *
 * Same habits as the ticker socket, same reasons: silence is failure, the
 * connection is remade on its own, and nothing here can place an order --
 * public channels, no key.
 *
 * What is held: the last `HOLD_MS` of trades in memory, so the hour's flow can
 * be summed the moment it is asked for, and the latest perp ticker. The
 * minute-by-minute record on disk is `flow.ts`'s job.
 */

export const HOLD_MS = 65 * 60_000;
/** No message for this long and the feed is dead. Trades print every few seconds; the ticker every second. */
export const FLOW_STALE_MS = 30_000;
const RECONNECT_MAX_MS = 30_000;
export const PERP_SYMBOL = 'BTCUSD';

export type Print = {
  /** Epoch ms. */
  at: number;
  price: number;
  /** Contracts (0.001 BTC each). */
  size: number;
  /** Which side crossed the spread: the aggressor. */
  side: 'buy' | 'sell';
};

export type PerpTicker = {
  at: number;
  mark: number | null;
  spot: number | null;
  last: number | null;
  /** Delta's current funding rate, as a fraction per funding period. */
  fundingRate: number | null;
  oiContracts: number | null;
  oiUsd: number | null;
  turnoverUsd24h: number | null;
  volume24h: number | null;
  change24hPct: number | null;
  high24h: number | null;
  low24h: number | null;
};

export type FlowHealth = {
  source: 'socket' | 'none';
  connected: boolean;
  lastMessageAt: number | null;
  /** Prints held in memory. */
  prints: number;
  reconnects: number;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One trade message as a print. Null unless it is a BTCUSD trade with a price and a size. */
export function printOf(m: Record<string, unknown>): Print | null {
  if (m.symbol !== PERP_SYMBOL) return null;
  const price = num(m.price);
  const size = num(m.size);
  const ts = num(m.timestamp);
  if (price === null || size === null || ts === null || !(size > 0)) return null;
  // The buyer is the taker when the buy crossed the spread.
  const side = m.buyer_role === 'taker' ? 'buy' : m.seller_role === 'taker' ? 'sell' : null;
  if (!side) return null;
  // Delta stamps in microseconds.
  return { at: Math.floor(ts / 1000), price, size, side };
}

export function perpTickerOf(m: Record<string, unknown>, at: number): PerpTicker | null {
  if (m.symbol !== PERP_SYMBOL) return null;
  return {
    at,
    mark: num(m.mark_price),
    spot: num(m.spot_price),
    last: num(m.close),
    fundingRate: num(m.funding_rate),
    oiContracts: num(m.oi_contracts),
    oiUsd: num(m.oi_value_usd),
    turnoverUsd24h: num(m.turnover_usd),
    volume24h: num(m.volume),
    change24hPct: num(m.mark_change_24h),
    high24h: num(m.high),
    low24h: num(m.low),
  };
}

export class FlowSocket {
  private prints: Print[] = [];
  private perp: PerpTicker | null = null;
  private socket: SocketLike | null = null;
  private stopped = true;
  private lastMessageAt: number | null = null;
  private reconnects = 0;
  private backoffMs = 1_000;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: {
    connect?: () => SocketLike;
    now?: () => number;
    log?: (line: string) => void;
    staleMs?: number;
    holdMs?: number;
  } = {}) {}

  private now() { return this.o.now?.() ?? Date.now(); }
  private log(line: string) { this.o.log?.(line); }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
    this.watchTimer = setInterval(() => this.watch(), 5_000);
    this.watchTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watchTimer = null;
    this.reconnectTimer = null;
    this.drop();
  }

  health(): FlowHealth {
    return {
      source: this.fresh() ? 'socket' : 'none',
      connected: this.socket !== null,
      lastMessageAt: this.lastMessageAt,
      prints: this.prints.length,
      reconnects: this.reconnects,
    };
  }

  fresh(now = this.now()): boolean {
    return this.socket !== null && this.lastMessageAt !== null && now - this.lastMessageAt < (this.o.staleMs ?? FLOW_STALE_MS);
  }

  /** Prints at or after `sinceMs`, oldest first. */
  printsSince(sinceMs: number): Print[] {
    return this.prints.filter((p) => p.at >= sinceMs);
  }

  perpTicker(): PerpTicker | null { return this.perp; }

  /** One raw message from the wire. Public so a test can feed the parser directly. */
  receive(raw: unknown): void {
    this.lastMessageAt = this.now();
    if (typeof raw !== 'string' || !raw.includes(PERP_SYMBOL)) return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    switch (m.type) {
      case 'all_trades': {
        const p = printOf(m);
        if (p) this.add(p);
        return;
      }
      case 'all_trades_snapshot': {
        // The recent tape, on subscribe: whatever printed while the socket was
        // away. Delta sends it newest first.
        const list = Array.isArray(m.trades) ? m.trades as Record<string, unknown>[] : [];
        for (const t of list) { const p = printOf({ ...t, symbol: m.symbol }); if (p) this.add(p); }
        return;
      }
      case 'v2/ticker': {
        const t = perpTickerOf(m, this.lastMessageAt);
        if (t) this.perp = t;
        return;
      }
      default:
    }
  }

  private add(p: Print): void {
    // A snapshot repeats prints the stream already delivered; the same instant,
    // price, size and side is the same print.
    if (this.prints.some((q) => q.at === p.at && q.price === p.price && q.size === p.size && q.side === p.side)) return;
    this.prints.push(p);
    if (this.prints.length > 1 && p.at < this.prints[this.prints.length - 2]!.at) this.prints.sort((a, b) => a.at - b.at);
  }

  private watch(): void {
    const cutoff = this.now() - (this.o.holdMs ?? HOLD_MS);
    if (this.prints.length && this.prints[0]!.at < cutoff) this.prints = this.prints.filter((p) => p.at >= cutoff);
    if (this.socket && this.lastMessageAt !== null && this.now() - this.lastMessageAt >= (this.o.staleMs ?? FLOW_STALE_MS)) {
      this.log('flow socket silent; reconnecting');
      this.drop();
      this.scheduleReconnect();
    }
  }

  private open(): void {
    if (this.stopped) return;
    let ws: SocketLike;
    try {
      ws = this.o.connect ? this.o.connect() : (new WebSocket(SOCKET_URL) as unknown as SocketLike);
    } catch (e) {
      this.log(`flow socket could not open: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      this.backoffMs = 1_000;
      this.lastMessageAt = this.now();
      ws.send(JSON.stringify({ type: 'enable_heartbeat' }));
      ws.send(JSON.stringify({
        type: 'subscribe',
        payload: { channels: [{ name: 'all_trades', symbols: [PERP_SYMBOL] }, { name: 'v2/ticker', symbols: [PERP_SYMBOL] }] },
      }));
      this.log('flow socket open');
    };
    ws.onmessage = (ev) => this.receive(ev.data);
    ws.onerror = () => { /* the close that follows carries the reconnect */ };
    ws.onclose = (ev) => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.log(`flow socket closed (${ev.code ?? '?'})`);
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
