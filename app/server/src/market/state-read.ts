import { candles, type Candle } from './delta.js';
import { atr, readMarket, type MarketRead } from './moves.js';
import { flowSummary } from './flow.js';
import { movementByWindow } from './movement.js';
import { marketState, LEVEL_BARS, type MarketState, type Regime, type StateInput } from '../domain/market-state.js';
import {
  candlePatterns, marketStructure, relevant, structurePatterns, trendLines, type Pattern, type TrendLine,
} from '../domain/patterns.js';
import { biasFrom, type BiasRead } from '../domain/bias.js';
import { indicators, relevantIndicators, type Indicator } from '../domain/indicators.js';

/**
 * The market-state card's one request: bars in, a state out.
 *
 * `domain/market-state.ts` is the rules and knows nothing about where numbers
 * come from. This is the other half -- it fetches the bars, works out the ATR
 * and the levels, and borrows the readings the desk already has (the timeframe
 * vote and the regime from `readMarket`, open interest from `movementByWindow`,
 * the aggressor split and cumulative delta from `flowSummary`) rather than
 * measuring any of them a second time in a second way.
 *
 * Everything but the bars is optional on the way in: a reading that is missing
 * costs the state its part of the score and says so on the card, and none of
 * them can stop the state being read.
 */

/** The timeframes the card offers, and how many minutes a bar of each is. */
export const STATE_TFS = ['5m', '15m', '30m', '1h', '2h', '4h'] as const;
export type StateTf = (typeof STATE_TFS)[number];

export const STATE_TF_MINUTES: Record<StateTf, number> = {
  '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240,
};

/** Enough bars for the level (20), the ATR (15) and the median volume (20), with room over. */
const BARS_WANTED = 60;

export type StateRead = {
  at: number;
  tf: StateTf;
  /** The bars the state was read from, newest last -- the same ones the chart draws. */
  bars: Candle[];
  state: MarketState;
  /** Every pattern that is true, and the few worth showing. */
  patterns: { all: Pattern[]; shown: Pattern[] };
  /** The lines through the last swings, for drawing on the chart. */
  lines: TrendLine[];
  /** Up or down, from everything measured, as a vote rather than a claim. */
  bias: BiasRead;
  /** Every reading, and the few that decide this state. */
  indicators: { all: Indicator[]; shown: Indicator[] };
  /** What each borrowed reading was, so the card can show its working. */
  inputs: {
    atr: number | null;
    oiChangePct: number | null;
    cvdSlope: number | null;
    aggressorBuyPct: number | null;
    mtf: { up: number; down: number; total: number } | null;
    regime: Regime | null;
  };
};

/** `readMarket`'s words for the regime, in the engine's. */
export function regimeOf(m: MarketRead | null): Regime | null {
  if (!m) return null;
  return m.regime === 'trending up' ? 'TREND_UP'
    : m.regime === 'trending down' ? 'TREND_DOWN'
      : m.regime === 'quiet' ? 'QUIET' : 'RANGE';
}

/** How the timeframes voted, counted off the reads `readMarket` already did. */
export function voteOf(m: MarketRead | null): { up: number; down: number; total: number } | null {
  if (!m || !m.timeframes.length) return null;
  return {
    up: m.timeframes.filter((t) => t.trend === 1).length,
    down: m.timeframes.filter((t) => t.trend === -1).length,
    total: m.timeframes.length,
  };
}

/**
 * Cumulative delta's slope: the last point less the one a third of the window
 * back. A straight subtraction of the ends would be decided by a single minute
 * at either end, which is exactly the minute most likely to be an outlier.
 */
export function cvdSlopeOf(points: readonly { cvd: number }[]): number | null {
  if (points.length < 6) return null;
  const back = Math.max(1, Math.floor(points.length / 3));
  const last = points[points.length - 1]!.cvd;
  const then = points[points.length - 1 - back]!.cvd;
  return last - then;
}

/**
 * The level the state is judged against.
 *
 * The timeframe's own nearest swing high and low when `readMarket` found them
 * -- those are the levels a chart reader would draw -- and the plain highest
 * high and lowest low of the last twenty bars when it did not. The engine
 * falls back to the same twenty bars itself, so a missing read costs nothing
 * but precision.
 */
export function levelFor(m: MarketRead | null, tf: StateTf, bars: readonly Candle[]): { resistance: number | null; support: number | null } {
  const read = m?.timeframes.find((t) => t.tf === tf) ?? null;
  const past = bars.slice(0, -1).slice(-LEVEL_BARS);
  const high = past.length ? Math.max(...past.map((b) => b.high)) : null;
  const low = past.length ? Math.min(...past.map((b) => b.low)) : null;
  return {
    resistance: read?.resistance[0] ?? high,
    support: read?.support[0] ?? low,
  };
}

/** The open-interest change over roughly this timeframe's own bar. */
export function oiFor(rows: readonly { minutes: number; oiPct: number | null }[], tf: StateTf): number | null {
  const want = STATE_TF_MINUTES[tf];
  let best: { minutes: number; oiPct: number | null } | null = null;
  for (const r of rows) {
    if (r.oiPct === null) continue;
    if (!best || Math.abs(r.minutes - want) < Math.abs(best.minutes - want)) best = r;
  }
  return best?.oiPct ?? null;
}

export async function readState(tf: StateTf = '15m', nowMs = Date.now()): Promise<StateRead> {
  const minutes = STATE_TF_MINUTES[tf];
  const end = Math.floor(nowMs / 1000);
  const start = end - minutes * 60 * BARS_WANTED;
  // Each of these is allowed to fail on its own: the bars are the only thing
  // without which there is nothing to say.
  const [bars, market, flow, movement] = await Promise.all([
    candles('BTCUSD', start, end, tf),
    readMarket().catch(() => null),
    flowSummary(Math.max(60, minutes), nowMs).catch(() => null),
    movementByWindow(nowMs).catch(() => null),
  ]);

  const tfRead = market?.timeframes.find((x) => x.tf === (tf as string)) ?? null;
  const inputs: StateRead['inputs'] = {
    atr: atr(bars),
    oiChangePct: movement ? oiFor(movement.rows, tf) : null,
    cvdSlope: flow ? cvdSlopeOf(flow.cvd) : null,
    aggressorBuyPct: flow?.aggressorBuyPct ?? null,
    mtf: voteOf(market),
    regime: regimeOf(market),
  };

  const input: StateInput = {
    bars,
    level: levelFor(market, tf, bars),
    atr: inputs.atr,
    tick: 0.5,
    oiChangePct: inputs.oiChangePct,
    cvdSlope: inputs.cvdSlope,
    aggressorBuyPct: inputs.aggressorBuyPct,
    mtf: inputs.mtf,
    regime: inputs.regime,
    tfLabel: tf,
  };

  const state = marketState(input);

  // The patterns and the readings are worked out from the same bars and the
  // same level, so the card can never show a pattern drawn against one level
  // and a state judged against another.
  const found = [
    ...structurePatterns({ bars, level: input.level, atr: inputs.atr }),
    ...marketStructure({ bars, atr: inputs.atr }),
    ...candlePatterns(bars),
  ];
  const read = indicators({
    bars,
    rsi14: tfRead?.rsi14 ?? null,
    adx14: tfRead?.adx14 ?? null,
    atrPct: tfRead?.atrPct ?? null,
    vwapDistPct: tfRead?.vwapDistPct ?? null,
    emaFast: tfRead?.ema21 ?? null,
    emaSlow: tfRead?.ema50 ?? null,
    volumeRatio: state.volumeRatio,
    cvdSlope: inputs.cvdSlope,
    aggressorBuyPct: inputs.aggressorBuyPct,
    oiChangePct: inputs.oiChangePct,
  });

  return {
    at: nowMs,
    tf,
    bars,
    state,
    patterns: { all: found, shown: relevant(found, state.event, state.side) },
    lines: trendLines(bars),
    // Everything above, in one word, from the whole list rather than the few
    // that are shown: the badge on the chart is the only thing most people
    // will read, so it is not decided by what happened to fit on the card.
    bias: biasFrom({
      state: { side: state.side, confirmed: state.confirmed, event: state.event },
      patterns: found,
      indicators: read,
      mtf: inputs.mtf,
      oiChangePct: inputs.oiChangePct,
      cvdSlope: inputs.cvdSlope,
      aggressorBuyPct: inputs.aggressorBuyPct,
      regime: inputs.regime,
    }),
    indicators: { all: read, shown: relevantIndicators(read, state.stage) },
    inputs,
  };
}
