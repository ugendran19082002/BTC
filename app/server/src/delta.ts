/**
 * Delta Exchange India public market data.
 *
 * Everything this file touches is an unauthenticated endpoint. No API key is
 * read, stored or sent -- market data does not need one, and keeping keys out
 * of this process means a leak here cannot move money.
 */

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
async function req<T>(path: string, tries = 5): Promise<T | null> {
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

export async function liveTickers(): Promise<Ticker[]> {
  if (tickerCache && Date.now() - tickerCache.at < TICKER_TTL_MS) return tickerCache.data;
  // collapse concurrent callers onto one upstream request
  if (!tickerInflight) {
    tickerInflight = (async () => {
      try {
        const r = await req<Ticker[]>('/tickers?contract_types=call_options,put_options');
        const data = (r ?? []).filter((t) => t.underlying_asset_symbol === 'BTC');
        tickerCache = { at: Date.now(), data };
        return data;
      } finally {
        tickerInflight = null;
      }
    })();
  }
  try {
    return await tickerInflight;
  } catch (e) {
    // a stale board beats no board when the feed is briefly throttling us
    if (tickerCache) return tickerCache.data;
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
