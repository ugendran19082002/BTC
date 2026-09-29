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
/** Resting liquidity per candle: [bin, contracts] cells, bin = floor(price / step). */
export type HeatColumn = { time: number; cells: [number, number][] };
export type Wall = { side: 'bid' | 'ask'; price: number; size: number; minutes: number };
/** The book heatmap's columns from `since` (epoch seconds; all 36 hours when absent), and the persistent walls now. */
export const getHeatmap = (tf: '1m' | '5m', since?: number) =>
  json<{ tf: string; step: number; columns: HeatColumn[]; walls: Wall[] }>(`/api/flow/heatmap?tf=${tf}${since ? `&since=${since}` : ''}`);

/** Aggressive flow per candle: taker buy / sell volume (contracts), trades, and how many of its minutes were recorded. */
export type FlowBar = { time: number; buy: number; sell: number; trades: number; minutes: number };
export const getFlowBars = (tf: '1m' | '5m', hours: number) =>
  json<{ tf: string; bars: FlowBar[] }>(`/api/flow/bars?tf=${tf}&hours=${hours}`);

/**
 * Large taker orders on the perpetual (contracts, 1,000 to a BTC), oldest
 * first: the chart's big-trade bubbles. The size they must reach is set by the
 * server from the market (`min`, and `basis` says how).
 */
export const getLargePrints = (hours: number) =>
  json<{ min: number; basis?: string; since: number; prints: { at: number; side: 'buy' | 'sell'; price: number; size: number }[] }>(
    `/api/flow/large-prints?hours=${hours}`,
  );

export const getCandles = (tf: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d') =>
  json<CandlesResponse>(`/api/candles?tf=${tf}`);

/**
 * How far a wall may sit and still be drawn as support or resistance, in
 * expected moves to settlement. A desk setting: 0.25 to 20.
 */
export const setWallWithinEm = (em: number) =>
  post<{ ok: true; key: string; value: string }>('/api/settings', { key: 'wall_within_em', value: String(em) });

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
  ceAcceleration: number | null; peAcceleration: number | null;
  /** The hour's OI change as a share of the side's OI, and the ATM call's / put's mark against an hour ago, percent. */
  ceOiChange1hPct?: number | null; peOiChange1hPct?: number | null;
  ceAtmMarkChange1hPct?: number | null; peAtmMarkChange1hPct?: number | null;
  at: number | null;
};
/** The options' own tape on one side over the window: who crossed the spread on the calls, and on the puts. */
export type SideFlow = {
  buyVolume: number; sellVolume: number; deltaVolume: number; trades: number;
  aggressorBuyPct: number | null;
  pressure: 'BUY PRESSURE' | 'SELL PRESSURE' | 'BALANCED' | null;
  strikes: { strike: number; buyVolume: number; sellVolume: number }[];
  cvd: { at: number; cvd: number; delta: number }[];
};
export type OptionFlowSummary = {
  expiry: string; windowMin: number; minutesCovered: number;
  ce: SideFlow; pe: SideFlow;
  combined: { buyVolume: number; sellVolume: number; deltaVolume: number; bias: 'CALL BUYING' | 'CALL SELLING' | 'PUT BUYING' | 'PUT SELLING' | 'MIXED' | null };
  source: 'socket' | 'none';
};
/** The perpetual's open interest against about an hour ago, with the price over the same window, and what the pair reads as. */
export type PerpOiChange = {
  oiContracts: number; change: number; changePct: number; priceChangePct: number | null; overMinutes: number;
  read: 'new longs' | 'new shorts' | 'short covering' | 'long unwinding' | 'flat';
};
export type PerpResponse = { at: number; ticker: PerpTicker | null; book: BookSnapshot | null; flow: FlowSummary; oi?: OiPulse | null; optionFlow?: OptionFlowSummary | null; perpOi?: PerpOiChange | null };
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
  /** The strike's odds and distance then, by the option model from that moment's spot, IV and time left. */
  pOtmThen: number | null; pTouchThen: number | null; emDistanceThen: number | null;
  /** The same now, on the row's basis (strike IV where the record had it, ATM IV otherwise). */
  pOtmNow: number | null; pTouchNow: number | null; emDistanceNow: number | null;
  /** True on the row that runs from the strategy's entry moment. */
  sinceEntry?: boolean;
};
/** The same odds and distance now, by the same model. */
export type ModelNow = { pOtm: number | null; pTouch: number | null; emDistance: number | null };
/** How the premium is moving: change over the newest five-minute bucket, and the change of that change. */
export type PremiumMomentum = { velocity: number | null; acceleration: number | null };
export type ChangesResponse = { now: Record<string, number | null>; model: ModelNow; rows: ChangeRow[]; momentum: PremiumMomentum };
export const getChanges = (symbol: string, now: Record<string, number | null | undefined>, entryMs: number | null = null) => {
  const q = new URLSearchParams({ symbol });
  for (const [k, v] of Object.entries(now)) if (v !== null && v !== undefined && Number.isFinite(v)) q.set(k, String(v));
  if (entryMs !== null) q.set('entry', String(entryMs));
  return json<ChangesResponse>(`/api/changes?${q.toString()}`);
};
export type StatePlan = { side: 'UP' | 'DOWN'; trigger: number; target1: number; target2: number; invalidation: number };

/**
 * The hour after a confirmed break on 15m / 30m / 1h, as measured over
 * 2024-2026 (server: domain/break-risk.ts). Sizes are BTC points from the
 * break's close; `keptGoing` is the measured share that went on the break's
 * way -- a coin flip, which is why the card never calls a direction.
 */
export type BreakRisk = {
  tf: '15m' | '30m' | '1h';
  side: 'UP' | 'DOWN';
  level: number;
  at: number;
  until: number;
  entry: number;
  atr: number;
  withPts: [number, number, number, number];
  againstPts: [number, number, number, number];
  eitherPts: [number, number];
  baselinePts: [number, number];
  bigger: number;
  keptGoing: number;
  keptGoingByYear: Record<string, { n: number; keptGoing: number }>;
  n: number;
  from: string;
  to: string;
  reach: { stepsAtr: readonly number[]; with: number[]; against: number[] };
};

export type StateHistoryRow = {
  id: number; at: number; tf: string; event: string; stage: string;
  side: 'UP' | 'DOWN' | null; confirmed: boolean; confidence: number; close: number;
  plan: StatePlan | null;
  /**
   * Where the call ended, in the words of what happened.
   *
   * Never "wrong": a setup whose trigger was never reached did not happen, and
   * one still inside its window has not finished. The old words still arrive
   * from rows written before 24 Sep 2026 and are mapped on the server.
   */
  outcome: 'TARGET_HIT' | 'INVALIDATED' | 'NOT_TRIGGERED' | 'EXPIRED' | 'NOT_GRADED' | null;
  gradedAt: number | null;
  /** Where price finished the grading window, and the BTC points from the call. */
  resolvedClose?: number | null;
  movePts?: number | null;
  triggeredAt?: number | null;
  confirmedAt?: number | null;
  targetHitAt?: number | null;
  stopHitAt?: number | null;
  expiredAt?: number | null;
  firstHit?: 'TARGET' | 'STOP' | 'NONE' | null;
  firstHitPrice?: number | null;
  firstHitTime?: number | null;
  mfe?: number | null;
  mae?: number | null;
  mfePrice?: number | null;
  maePrice?: number | null;
  evalWindowMin?: number | null;
  score?: number | null;
  probability?: number | null;
  regime?: string | null;
  mtfConsensus?: string | null;
};
