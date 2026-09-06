import { candles, liveTickers, spotAt, pool, type Ticker } from './delta.js';
import { greeks, impliedVol, expectedMove } from './bs.js';

export const STRIKE_STEP = 200;
/** Daily BTC options settle at 12:00 UTC == 17:30 IST. */
export const SETTLE_HOUR_UTC = 12;
const YEAR_MS = 365 * 24 * 3600 * 1000;

export type Leg = {
  cp: 'C' | 'P';
  strike: number;
  /** strikes away from the money; negative = below ATM */
  off: number;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  ltp: number | null;
  mark: number | null;
  bid: number | null;
  ask: number | null;
  /** the price a seller can realistically expect to receive */
  sellPrice: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  oi: number | null;
  volume: number | null;
  /** minutes since the last real trade; null when nothing traded */
  ageMin: number | null;
};

export type Snapshot = {
  /** the moment the snapshot describes, epoch seconds */
  ts: number;
  live: boolean;
  expiry: string;
  expiryTs: number;
  /** true when this is the same-day daily contract the backtest measured */
  isDaily: boolean;
  /** time to expiry in years */
  tte: number;
  hoursToExpiry: number;
  spot: number;
  atm: number;
  atmIv: number | null;
  expectedMove: number | null;
  legs: Leg[];
};

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export function ddmmyy(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}${p(d.getUTCMonth() + 1)}${String(d.getUTCFullYear()).slice(2)}`;
}

/** The next daily settlement at or after `ts`. */
export function nextExpiry(ts: number): { expiry: string; expiryTs: number } {
  const d = new Date(ts * 1000);
  const same = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SETTLE_HOUR_UTC) / 1000;
  const expiryTs = ts < same ? same : same + 86400;
  return { expiry: ddmmyy(new Date(expiryTs * 1000)), expiryTs };
}

function moneyness(cp: 'C' | 'P', off: number): Leg['moneyness'] {
  if (off === 0) return 'ATM';
  if (cp === 'C') return off > 0 ? 'OTM' : 'ITM';
  return off < 0 ? 'OTM' : 'ITM';
}

function finish(snap: Omit<Snapshot, 'atmIv' | 'expectedMove'>): Snapshot {
  const atmLegs = snap.legs.filter((l) => l.off === 0 && l.iv !== null);
  const atmIv = atmLegs.length
    ? atmLegs.reduce((a, l) => a + l.iv!, 0) / atmLegs.length
    : null;
  return {
    ...snap,
    atmIv,
    expectedMove: atmIv === null ? null : expectedMove(snap.spot, atmIv, snap.tte),
  };
}

/** Parse a DDMMYY expiry code into its 12:00 UTC settlement. */
export function expiryTsOf(code: string): number {
  const d = Number(code.slice(0, 2));
  const m = Number(code.slice(2, 4));
  const y = 2000 + Number(code.slice(4, 6));
  return Date.UTC(y, m - 1, d, SETTLE_HOUR_UTC) / 1000;
}

export type ExpiryOption = {
  expiry: string;
  expiryTs: number;
  iso: string;
  hoursAway: number;
  /** the same-day daily contract the strategy was measured on */
  isDaily: boolean;
  contracts: number;
};

/** Every BTC option expiry Delta is currently listing, soonest first. */
export async function liveExpiries(): Promise<ExpiryOption[]> {
  const tickers = await liveTickers();
  const now = Math.floor(Date.now() / 1000);
  const nearest = nextExpiry(now).expiry;
  const counts = new Map<string, number>();
  for (const t of tickers) {
    const code = t.symbol.split('-').pop();
    if (code && /^\d{6}$/.test(code)) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([expiry, contracts]) => {
      const ets = expiryTsOf(expiry);
      return {
        expiry,
        expiryTs: ets,
        iso: new Date(ets * 1000).toISOString().slice(0, 10),
        hoursAway: (ets - now) / 3600,
        isDaily: expiry === nearest,
        contracts,
      };
    })
    .filter((e) => e.hoursAway > 0)
    .sort((a, b) => a.expiryTs - b.expiryTs);
}

/**
 * Live chain, by default for the nearest daily expiry.
 *
 * `wantExpiry` selects a different one. The Greeks follow automatically because
 * time to expiry is derived from the code, but nothing measured in the backtest
 * carries over to a longer-dated contract -- that is a different trade.
 */
export async function liveChain(width = 12, wantExpiry?: string): Promise<Snapshot> {
  const tickers = await liveTickers();
  if (!tickers.length) throw new Error('ticker feed empty');
  const ts = Math.floor(Date.now() / 1000);
  const near = nextExpiry(ts);
  const expiry = wantExpiry ?? near.expiry;
  const expiryTs = wantExpiry ? expiryTsOf(wantExpiry) : near.expiryTs;
  const day = tickers.filter((t) => t.symbol.endsWith('-' + expiry));
  if (!day.length) throw new Error(`no live contracts for expiry ${expiry}`);

  const spot = num(day[0]!.spot_price) ?? num(day[0]!.greeks?.spot) ?? 0;
  const atm = Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
  const tte = Math.max(0, (expiryTs * 1000 - Date.now()) / YEAR_MS);

  const legs: Leg[] = [];
  for (const t of day) {
    const strike = num(t.strike_price);
    if (strike === null) continue;
    const off = Math.round((strike - atm) / STRIKE_STEP);
    if (Math.abs(off) > width) continue;
    const cp: 'C' | 'P' = t.contract_type === 'call_options' ? 'C' : 'P';
    const bid = num(t.quotes?.best_bid ?? null);
    const ask = num(t.quotes?.best_ask ?? null);
    const mark = num(t.mark_price);
    const g = t.greeks;
    legs.push({
      cp,
      strike,
      off,
      moneyness: moneyness(cp, off),
      ltp: num(t.close),
      mark,
      bid,
      ask,
      // selling hits the bid; fall back to mark when the book is empty
      sellPrice: bid ?? mark,
      iv: num(t.quotes?.mark_iv ?? null),
      delta: num(g?.delta ?? null),
      gamma: num(g?.gamma ?? null),
      theta: num(g?.theta ?? null),
      vega: num(g?.vega ?? null),
      oi: num(t.oi_contracts ?? t.oi),
      volume: t.volume ?? null,
      ageMin: null,
    });
  }
  legs.sort((a, b) => a.strike - b.strike || a.cp.localeCompare(b.cp));
  return finish({
    ts,
    live: true,
    expiry,
    expiryTs,
    isDaily: expiry === near.expiry,
    tte,
    hoursToExpiry: (expiryTs - ts) / 3600,
    spot,
    atm,
    legs,
  });
}

/**
 * Reconstruct the chain at a past minute from 1m candles.
 *
 * Delta's candle feed forward-fills minutes in which nothing traded, so a
 * traded price is only trustworthy alongside its age. Greeks are derived from
 * the mark price, which is quoted continuously and does not go stale.
 */
export async function historicalChain(
  ts: number,
  width = 12,
  wantExpiry?: string,
): Promise<Snapshot> {
  const minute = Math.floor(ts / 60) * 60;
  const near = nextExpiry(minute);
  const expiry = wantExpiry ?? near.expiry;
  const expiryTs = wantExpiry ? expiryTsOf(wantExpiry) : near.expiryTs;
  const spot = await spotAt(minute);
  if (spot === null) {
    throw new Error(
      `no BTCUSD price at or before ${new Date(minute * 1000).toISOString()} -- ` +
        'that minute is likely before Delta India listed the market',
    );
  }
  const atm = Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
  const tte = Math.max(0, (expiryTs - minute) / (365 * 24 * 3600));

  const jobs: { cp: 'C' | 'P'; strike: number }[] = [];
  for (let k = -width; k <= width; k++) {
    const strike = atm + k * STRIKE_STEP;
    jobs.push({ cp: 'C', strike }, { cp: 'P', strike });
  }

  const built = await pool(jobs, 8, async ({ cp, strike }) => {
    const sym = `${cp}-BTC-${strike}-${expiry}`;
    const tr = await candles(sym, minute - 8 * 3600, minute + 60);
    if (!tr.length) return null;
    const mk = await candles('MARK:' + sym, minute - 3600, minute + 60);
    const bar = tr.find((c) => c.time === minute) ?? null;
    const traded = tr.filter((c) => c.time <= minute && (c.volume ?? 0) > 0);
    const last = traded.length ? traded[traded.length - 1]! : null;
    const mark = mk.find((c) => c.time === minute)?.close ?? null;
    const off = Math.round((strike - atm) / STRIKE_STEP);
    const iv = mark !== null ? impliedVol(cp, mark, spot, strike, tte) : null;
    const g = iv !== null ? greeks(cp, spot, strike, tte, iv) : null;
    const leg: Leg = {
      cp,
      strike,
      off,
      moneyness: moneyness(cp, off),
      ltp: bar?.close ?? null,
      mark,
      bid: null,
      ask: null,
      // no historical book, so the mark is the honest sell estimate
      sellPrice: mark ?? bar?.close ?? null,
      iv,
      delta: g?.delta ?? null,
      gamma: g?.gamma ?? null,
      theta: g?.theta ?? null,
      vega: g?.vega ?? null,
      oi: null,
      volume: tr.reduce((a, c) => a + (c.volume ?? 0), 0),
      ageMin: last ? Math.round((minute - last.time) / 60) : null,
    };
    return leg;
  });

  const legs = built.filter((l): l is Leg => l !== null).sort(
    (a, b) => a.strike - b.strike || a.cp.localeCompare(b.cp),
  );
  return finish({
    ts: minute,
    live: false,
    expiry,
    expiryTs,
    isDaily: expiry === near.expiry,
    tte,
    hoursToExpiry: (expiryTs - minute) / 3600,
    spot,
    atm,
    legs,
  });
}
