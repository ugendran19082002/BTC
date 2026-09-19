import type { CandlesResponse, ChainResponse, ExpiryOption } from '@/types/desk';
import { json, post } from '@/api/client';

export function getChain(
  at: string,
  width: number,
  minPremium: number,
  hedgeGap: number,
  lots: number,
  expiry?: string,
  requireHedge = false,
  mode: 'premium' | 'safety' = 'premium',
  safetyBar = 0.99,
) {
  const q = new URLSearchParams({
    at,
    width: String(width),
    minPremium: String(minPremium),
    hedgeGap: String(hedgeGap),
    lots: String(lots),
  });
  if (expiry) q.set('expiry', expiry);
  if (requireHedge) q.set('requireHedge', '1');
  if (mode === 'safety') {
    q.set('mode', 'safety');
    q.set('safetyBar', String(safetyBar));
  }
  return json<ChainResponse>(`/api/chain?${q}`);
}

export function getExpiries() {
  return json<{ expiries: ExpiryOption[] }>('/api/expiries');
}

export function getHealth() {
  return json<{ ok: boolean; days: number; now: string }>('/api/health');
}

/** Just the price. Tiny, so it can be polled every second. */
export const getSpot = () => json<{ spot: number; at: number }>('/api/spot');

/**
 * The total-short cap: what is in force, what the margin would allow, and what
 * the desk was asked to hold itself to.
 *
 * `ceiling` is null until the server has seen both a spot and a balance.
 */
export type ShortCap = { inForce: number; ceiling: number | null; chosen: number | null };

export const getSettings = () =>
  json<{ settings: Record<string, string | null>; shortCap: ShortCap }>('/api/settings');

/**
 * Ask the desk to hold itself to a smaller total short.
 *
 * The server decides -- it refuses anything above what the margin covers -- so
 * the answer, not the request, is what the screen shows afterwards.
 */
export const setShortCap = (contracts: number) =>
  post<{ ok: true; key: string; value: string; shortCap: ShortCap }>('/api/settings', {
    key: 'max_short_contracts',
    value: String(contracts),
  });

/**
 * BTC bars for the chart under the board.
 *
 * The span is the server's to choose per resolution — a chart meant to put the
 * open-interest walls against recent price does not need a year of 1m bars, and
 * a caller free to ask for one is a caller who can hang the page.
 */
export const getCandles = (tf: '1m' | '5m' | '15m' | '1h' | '4h' | '1d') =>
  json<CandlesResponse>(`/api/candles?tf=${tf}`);

/**
 * How far a wall may sit and still be drawn as support or resistance, in
 * expected moves to settlement. A desk setting: 0.25 to 20.
 */
export const setWallWithinEm = (em: number) =>
  post<{ ok: true; key: string; value: string }>('/api/settings', { key: 'wall_within_em', value: String(em) });


/** ATM implied volatility across every listed expiry, now. There is no history of it. */
export type TermPoint = { expiry: string; expiryTs: number; hoursAway: number; strike: number; atmIv: number; sides: 1 | 2 };
export type TermHistoryPoint = Pick<TermPoint, 'expiry' | 'hoursAway' | 'strike' | 'atmIv'>;
export type TermResponse = {
  at: number;
  points: TermPoint[];
  /** The term structure as recorded a week / a month ago; null until the record is that long. */
  weekAgo: { at: number; points: TermHistoryPoint[] } | null;
  monthAgo: { at: number; points: TermHistoryPoint[] } | null;
  /** Where today's put−call skew sits among every recorded reading. */
  skew: { percentile: number; samples: number; days: number } | null;
};
export const getTerm = (skewPts: number | null = null) =>
  json<TermResponse>(`/api/term${skewPts === null ? '' : `?skewPts=${encodeURIComponent(skewPts)}`}`);

/** The perpetual: ticker, top of book, and the last hour's flow by aggressor side. */
export type PerpTicker = {
  at: number; mark: number | null; spot: number | null; last: number | null;
  fundingRate: number | null; oiContracts: number | null; oiUsd: number | null;
  turnoverUsd24h: number | null; volume24h: number | null; change24hPct: number | null;
  high24h: number | null; low24h: number | null;
};
export type BookSnapshot = {
  at: number; bidDepth: number; askDepth: number; imbalance: number | null;
  bestBid: number | null; bestAsk: number | null; spreadUsd: number | null; spreadPct: number | null;
  top5Bid: number; top5Ask: number;
};
export type FlowSummary = {
  windowMin: number; minutesCovered: number;
  buyVolume: number; sellVolume: number; deltaVolume: number; totalVolume: number;
  trades: number; avgTradeSize: number | null; largeBuyVolume: number; largeSellVolume: number;
  aggressorBuyPct: number | null;
  cvd: { at: number; cvd: number; delta: number }[];
  source: 'socket' | 'none';
};
export type PerpResponse = { at: number; ticker: PerpTicker | null; book: BookSnapshot | null; flow: FlowSummary };
export const getPerp = (windowMin = 60) => json<PerpResponse>(`/api/perp?window=${windowMin}`);

/** One contract's recorded five-minute history (premium, quotes, IV, delta, OI, volume). */
export type OptionHistoryPoint = {
  at: number; spot: number | null; mark: number | null; bid: number | null; ask: number | null;
  markIv: number | null; delta: number | null; oi: number | null; volume: number | null;
};
export const getOptionHistory = (symbol: string, hours = 6) =>
  json<{ symbol: string; points: OptionHistoryPoint[] }>(`/api/option-history?symbol=${encodeURIComponent(symbol)}&hours=${hours}`);
