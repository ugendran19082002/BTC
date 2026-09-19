/**
 * Delta Exchange India public market data.
 *
 * Everything this file touches is an unauthenticated endpoint. No API key is
 * read, stored or sent -- market data does not need one, and keeping keys out
 * of this process means a leak here cannot move money.
 */

import { TickerSocket, type FeedHealth } from './delta-socket.js';

const BASE = 'https://api.india.delta.exchange/v2';

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type Ticker = {
  symbol: string;
  contract_type: string;
  underlying_asset_symbol: string;
  strike_price: string;
  close: number | null;
  mark_price: string;
  spot_price: string;
  oi: string;
  oi_contracts?: string;
  volume: number;
  greeks: { delta: string; gamma: string; theta: string; vega: string; rho: string; spot: string } | null;
  quotes: {
    best_bid: string | null;
    best_ask: string | null;
    bid_size: string | null;
    ask_size: string | null;
    mark_iv: string | null;
    bid_iv: string | null;
    ask_iv: string | null;
  } | null;
};

/**
 * `null` means the endpoint answered and had nothing; a throw means the request
 * itself failed. Conflating the two is how a rate-limited minute turns into a
 * phantom "no data at that time", so keep them apart.
 */
export async function req<T>(path: string, tries = 5): Promise<T | null> {
  let last = 'unknown error';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + path, {
        headers: { Accept: 'application/json', 'User-Agent': 'btc-options-desk/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { success?: boolean; result?: T };
        return body.success === false ? null : ((body.result ?? null) as T | null);
      }
      if (![429, 500, 502, 503, 504].includes(res.status)) {
        if (res.status === 404) return null;
        throw new Error(`HTTP ${res.status}`);
      }
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    if (i < tries - 1) await sleep(2 ** i * 500 + Math.random() * 400);
  }
  throw new Error(`delta request failed after ${tries} tries (${last}): ${path}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Candles at any resolution. `symbol` may carry a MARK: or OI: prefix; the
 * resolution is a separate parameter, not part of the symbol.
 */
export async function candles(
  symbol: string,
  start: number,
  end: number,
  resolution = '1m',
): Promise<Candle[]> {
  const r = await req<Candle[]>(
    `/history/candles?resolution=${encodeURIComponent(resolution)}` +
      `&symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`,
  );
  return (r ?? []).sort((a, b) => a.time - b.time);
}

/** Last BTCUSD 1m close at or before `ts`, widening the lookback if the tape is thin. */
export async function spotAt(ts: number): Promise<number | null> {
  for (const back of [900, 7200, 86400]) {
    const c = await candles('BTCUSD', ts - back, ts + 60);
    const prior = c.filter((x) => x.time <= ts);
    if (prior.length) return prior[prior.length - 1]!.close;
  }
  return null;
}

/**
 * The whole option board in one request, cached briefly. Delta rate-limits by
 * account and the board only moves every few seconds, so serving several page
 * refreshes from one fetch keeps us well inside the limit.
 */
const TICKER_TTL_MS = 15_000;
let tickerCache: { at: number; data: Ticker[] } | null = null;
let tickerInflight: Promise<Ticker[]> | null = null;
let tickerPollerId: NodeJS.Timeout | null = null;
/** The socket feed, once started. Null in tests and tools that never start it. */
let tickerSocket: TickerSocket | null = null;
let spotCache: { value: number; at: number } | null = null;

async function fetchTickersFresh(): Promise<Ticker[]> {
  if (tickerInflight) return tickerInflight;
  tickerInflight = (async () => {
    try {
      const r = await req<Ticker[]>('/tickers?contract_types=call_options,put_options');
      const data = (r ?? []).filter((t) => t.underlying_asset_symbol === 'BTC');
      if (data.length > 0) {
        tickerCache = { at: Date.now(), data };
        // The full list is the truth about which contracts exist; the socket
        // carries on from it.
        tickerSocket?.seed(data);
      }
      return data;
    } finally {
      tickerInflight = null;
    }
  })();
  return tickerInflight;
}

/**
 * The REST poll: the cold start, and the fallback.
 *
 * While the socket is delivering, this does nothing -- a board that arrives
 * the moment it changes does not need a copy downloaded every eight seconds.
 * The moment the socket goes quiet (`fresh()` false) the poll is back to
 * being the feed, with no gap longer than its own interval.
 */
export function startTickerPoller(intervalMs = 8_000) {
  if (tickerPollerId) return;
  void fetchTickersFresh().catch(() => {});
  tickerPollerId = setInterval(() => {
    if (tickerSocket?.fresh()) return;
    void fetchTickersFresh().catch(() => {});
  }, intervalMs);
  if (typeof tickerPollerId === 'object' && 'unref' in tickerPollerId) {
    tickerPollerId.unref();
  }
}

export function stopTickerPoller() {
  if (tickerPollerId) {
    clearInterval(tickerPollerId);
    tickerPollerId = null;
  }
  tickerSocket?.stop();
  tickerSocket = null;
}

/**
 * The socket feed. Every batch it hands over becomes the ticker cache, and
 * its freshest spot becomes the price -- the same two places the REST poll
 * writes, so nothing downstream can tell the two apart. See `delta-socket.ts`.
 */
export function startTickerSocket(log?: (line: string) => void): TickerSocket {
  if (tickerSocket) return tickerSocket;
  tickerSocket = new TickerSocket({
    log,
    onBatch: (data, at, spot) => {
      if (!data.length) return;
      tickerCache = { at, data };
      if (spot !== null) spotCache = { value: spot, at };
    },
  });
  tickerSocket.start();
  return tickerSocket;
}

/** Where the board is coming from, for /api/health and the screen. */
export function tickerFeedHealth(): FeedHealth & { batchAt: number | null } {
  const h = tickerSocket?.health() ?? { source: 'none' as const, connected: false, lastMessageAt: null, symbols: 0, reconnects: 0 };
  if (h.source === 'none' && tickerCache) h.source = 'rest';
  return { ...h, batchAt: tickerCache?.at ?? null };
}

/** When the current batch arrived: a client can tell "the board changed" from it. */
export const tickerBatchAt = (): number | null => tickerCache?.at ?? null;

/**
 * Spot, on its own, cheaply.
 *
 * The chain is a big response and is fetched every five seconds for that
 * reason. The price at the top of the screen is one number and should feel
 * live, so it gets its own endpoint and its own cache -- short enough that a
 * one-second poll reads a fresh figure, long enough that ten browser tabs
 * cannot turn into ten calls a second at the exchange.
 */
const SPOT_TTL_MS = 800;

export async function liveSpot(now = Date.now()): Promise<number | null> {
  if (spotCache && now - spotCache.at < SPOT_TTL_MS) return spotCache.value;
  // The ticker poller already holds every BTC option's spot_price, refreshed
  // every eight seconds in the background. A request inside that window costs
  // nothing; only a cold cache goes to Delta for the price.
  const fromTickers = tickerCache && now - tickerCache.at < 8_500
    ? Number(tickerCache.data[0]?.spot_price ?? NaN)
    : NaN;
  if (Number.isFinite(fromTickers) && fromTickers > 0) {
    spotCache = { value: fromTickers, at: now };
    return fromTickers;
  }
  const t = await req<{ spot_price?: string; mark_price?: string }>('/tickers/BTCUSD', 2).catch(() => null);
  const value = Number(t?.spot_price ?? t?.mark_price ?? Number.NaN);
  if (!Number.isFinite(value) || value <= 0) return spotCache?.value ?? null;
  spotCache = { value, at: now };
  return value;
}

export async function liveTickers(): Promise<Ticker[]> {
  // Stale-while-revalidate: if we have cached tickers, return them immediately (0ms).
  // If the cache is older than TTL, refresh in background without stalling the caller.
  if (tickerCache) {
    if (Date.now() - tickerCache.at >= TICKER_TTL_MS) {
      void fetchTickersFresh().catch(() => {});
    }
    return tickerCache.data;
  }
  // Cold start (first boot only): await the in-flight request
  try {
    return await fetchTickersFresh();
  } catch (e) {
    const cached = tickerCache as { at: number; data: Ticker[] } | null;
    if (cached) return cached.data;
    throw e;
  }
}

export async function productExists(symbol: string): Promise<boolean> {
  return (await req<unknown>(`/products/${symbol}`)) !== null;
}

/** Run `fn` over `items` with bounded concurrency, preserving order. */
export async function pool<A, B>(items: A[], limit: number, fn: (a: A) => Promise<B>): Promise<B[]> {
  const out = new Array<B>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
