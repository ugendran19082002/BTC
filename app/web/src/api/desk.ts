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
export const getCandles = (tf: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d') =>
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
  /** Where today's put−call skew, and the ATM IV, sit among every recorded reading. */
  skew: { percentile: number; samples: number; days: number } | null;
  iv?: { percentile: number; samples: number; days: number } | null;
};
export const getTerm = (skewPts: number | null = null, atmIv: number | null = null) => {
  const q = new URLSearchParams();
  if (skewPts !== null) q.set('skewPts', String(skewPts));
  if (atmIv !== null) q.set('atmIv', String(atmIv));
  const qs = q.toString();
  return json<TermResponse>(`/api/term${qs ? `?${qs}` : ''}`);
};

/** The perpetual: ticker, top of book, and the last hour's flow by aggressor side. */
export type PerpTicker = {
  at: number; mark: number | null; spot: number | null; last: number | null;
  /** Percent per funding period, as Delta publishes it: 0.01 is 0.01%. */
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
  trades: number; avgTradeSize: number | null; largeBuyVolume: number; largeSellVolume: number; largeTrades: number;
  aggressorBuyPct: number | null;
  cvd: { at: number; cvd: number; delta: number }[];
  source: 'socket' | 'none';
};
export type OiPulse = {
  ceChange1h: number | null; peChange1h: number | null;
  ceAcceleration: number | null; peAcceleration: number | null; at: number | null;
};
export type PerpResponse = { at: number; ticker: PerpTicker | null; book: BookSnapshot | null; flow: FlowSummary; oi?: OiPulse | null };
export const getPerp = (windowMin = 60, expiry: string | null = null) =>
  json<PerpResponse>(`/api/perp?window=${windowMin}${expiry ? `&expiry=${expiry}` : ''}`);

/** What changed over 1m … 12h for BTC, one strike and its board, from the desk's records. */
export type ChangeRow = {
  minutes: number;
  spotThen: number | null; spotChange: number | null; spotChangePct: number | null;
  markThen: number | null; markChange: number | null; markChangePct: number | null;
  oiThen: number | null; oiChange: number | null;
  ivThen: number | null; ivChangePts: number | null;
  volumeThen: number | null; volumeChange: number | null;
  ceOiChange: number | null; peOiChange: number | null;
  callVolumeChange: number | null; putVolumeChange: number | null;
  pcrThen: number | null; pcrChange: number | null;
  atmIvThen: number | null; atmIvChangePts: number | null;
};
/** How the premium is moving: change over the newest five-minute bucket, and the change of that change. */
export type PremiumMomentum = { velocity: number | null; acceleration: number | null };
export type ChangesResponse = { now: Record<string, number | null>; rows: ChangeRow[]; momentum: PremiumMomentum };
export const getChanges = (symbol: string, now: Record<string, number | null | undefined>) => {
  const q = new URLSearchParams({ symbol });
  for (const [k, v] of Object.entries(now)) if (v !== null && v !== undefined && Number.isFinite(v)) q.set(k, String(v));
  return json<ChangesResponse>(`/api/changes?${q.toString()}`);
};
