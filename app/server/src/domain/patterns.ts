import type { Candle } from '../market/delta.js';
import { bodyRatio, closeLocation, volumeRatio, type MarketEvent, type Side } from './market-state.js';

/**
 * What the last few bars are doing, named.
 *
 * Two layers, kept apart because they are answering different questions:
 *
 *   - **Candles**: what the last one, two or three bars say on their own. A
 *     bearish engulfing is a bearish engulfing wherever it happens.
 *   - **Structure**: what the last twenty or so say together -- higher lows, an
 *     ascending triangle, a level being tested for the third time, volume
 *     building into it. These are the ones a chart reader actually draws.
 *
 * Every detector is a pure function of bars, so each is one test with one
 * hand-built shape, and nothing here can be true "sometimes".
 *
 * The full list is deliberately longer than any screen should show. A card
 * with thirty patterns on it is a card nobody reads, so `relevant()` picks the
 * few that bear on the state price is actually in -- the rest stay available
 * to the API, the journal and anything measuring which of them ever paid.
 */

export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export type Pattern = {
  /** The name a trader would use, as it goes on the card. */
  name: string;
  bias: Bias;
  /** Candles are about the last bars; structure is about the shape of many. */
  kind: 'candle' | 'structure';
  /** A few words on what it means, for the line under the name. */
  note: string;
  /** How far back it starts, in bars from the newest: 0 is the bar being formed. */
  barsAgo: number;
};

// ------------------------------------------------------------ candle shapes

/** Under this share of its own range, a body is no body at all. */
const DOJI_BODY = 0.1;
/** A body this much of the range and the bar is all one thing. */
const MARUBOZU_BODY = 0.9;
/** A wick this long against the body is a rejection, not a tail. */
const HAMMER_WICK = 2;

const body = (b: Candle) => Math.abs(b.close - b.open);
const range = (b: Candle) => b.high - b.low;
const upperWick = (b: Candle) => b.high - Math.max(b.open, b.close);
const lowerWick = (b: Candle) => Math.min(b.open, b.close) - b.low;
const up = (b: Candle) => b.close > b.open;
const down = (b: Candle) => b.close < b.open;
const mid = (b: Candle) => (b.open + b.close) / 2;

/**
 * Every candle pattern the last three bars make, newest first.
 *
 * More than one can be true at once and all of them are returned: a hammer
 * that is also the third bar of a morning star is both, and picking one to
 * report would be throwing away the more interesting half at random.
 */
export function candlePatterns(bars: readonly Candle[]): Pattern[] {
  const out: Pattern[] = [];
  const c = bars[bars.length - 1];
  const p = bars[bars.length - 2] ?? null;
  const p2 = bars[bars.length - 3] ?? null;
  if (!c || range(c) <= 0) return out;

  const shape = bodyRatio(c) ?? 0;
  const loc = closeLocation(c) ?? 0.5;
  const uw = upperWick(c);
  const lw = lowerWick(c);
  const bodyC = body(c);

  // ---- one bar
  if (shape <= DOJI_BODY) {
    if (lw >= range(c) * 0.6) out.push(one('Dragonfly Doji', 'BULLISH', 'Sold down and bought all the way back'));
    else if (uw >= range(c) * 0.6) out.push(one('Gravestone Doji', 'BEARISH', 'Bought up and sold all the way back'));
    else if (uw >= range(c) * 0.3 && lw >= range(c) * 0.3) out.push(one('Long-Legged Doji', 'NEUTRAL', 'Both sides tried; neither held'));
    else out.push(one('Doji', 'NEUTRAL', 'Opened and closed in the same place'));
  } else if (shape >= MARUBOZU_BODY) {
    out.push(one(up(c) ? 'Bullish Marubozu' : 'Bearish Marubozu', up(c) ? 'BULLISH' : 'BEARISH',
      'All body, no wick: one side had it the whole bar'));
  } else if (shape <= 0.3 && uw > 0 && lw > 0) {
    out.push(one('Spinning Top', 'NEUTRAL', 'A small body between two wicks: indecision'));
  }

  if (bodyC > 0 && lw >= bodyC * HAMMER_WICK && uw <= bodyC) {
    // The same shape, and which it is depends entirely on what came before it.
    const trendDown = p2 !== null && p !== null && p2.close > p.close && p.close > c.open;
    out.push(one(trendDown ? 'Hammer' : 'Hanging Man', trendDown ? 'BULLISH' : 'BEARISH',
      trendDown ? 'A long tail under a fall: buyers stepped in' : 'A long tail after a rise: a warning, not a signal'));
  }
  if (bodyC > 0 && uw >= bodyC * HAMMER_WICK && lw <= bodyC) {
    const trendUp = p2 !== null && p !== null && p2.close < p.close && p.close < c.open;
    out.push(one(trendUp ? 'Shooting Star' : 'Inverted Hammer', trendUp ? 'BEARISH' : 'BULLISH',
      trendUp ? 'Pushed up and sold back: the high was refused' : 'A long wick up after a fall: buyers testing'));
  }
  if (shape < 0.35 && loc >= 0.75 && lw >= range(c) * 0.5) {
    out.push(one('Bullish Pin Bar', 'BULLISH', 'Rejected the low and closed at the top'));
  }
  if (shape < 0.35 && loc <= 0.25 && uw >= range(c) * 0.5) {
    out.push(one('Bearish Pin Bar', 'BEARISH', 'Rejected the high and closed at the bottom'));
  }

  // ---- two bars
  if (p && range(p) > 0) {
    if (down(p) && up(c) && c.close >= p.open && c.open <= p.close) {
      out.push(one('Bullish Engulfing', 'BULLISH', 'This bar covers the whole of the last one'));
    }
    if (up(p) && down(c) && c.close <= p.open && c.open >= p.close) {
      out.push(one('Bearish Engulfing', 'BEARISH', 'This bar covers the whole of the last one'));
    }
    if (body(p) > 0 && body(c) < body(p) * 0.6
      && Math.max(c.open, c.close) <= Math.max(p.open, p.close)
      && Math.min(c.open, c.close) >= Math.min(p.open, p.close)) {
      out.push(one(down(p) ? 'Bullish Harami' : 'Bearish Harami', down(p) ? 'BULLISH' : 'BEARISH',
        'A small bar inside the last one: the move has paused'));
    }
    if (down(p) && up(c) && c.open < p.close && c.close > mid(p) && c.close < p.open) {
      out.push(one('Piercing Line', 'BULLISH', 'Opened lower and closed back through the middle'));
    }
    if (up(p) && down(c) && c.open > p.close && c.close < mid(p) && c.close > p.open) {
      out.push(one('Dark Cloud Cover', 'BEARISH', 'Opened higher and closed back through the middle'));
    }
    const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(range(c), range(p)) * 0.05;
    if (near(c.low, p.low) && down(p) && up(c)) out.push(one('Tweezer Bottom', 'BULLISH', 'Two bars refused the same low'));
    if (near(c.high, p.high) && up(p) && down(c)) out.push(one('Tweezer Top', 'BEARISH', 'Two bars refused the same high'));
  }

  // ---- three bars
  if (p && p2 && range(p) > 0 && range(p2) > 0) {
    const small = body(p) <= range(p) * 0.4;
    if (down(p2) && small && up(c) && c.close > mid(p2)) {
      out.push({ ...one('Morning Star', 'BULLISH', 'A fall, a pause, and a bar back up through it'), barsAgo: 2 });
    }
    if (up(p2) && small && down(c) && c.close < mid(p2)) {
      out.push({ ...one('Evening Star', 'BEARISH', 'A rise, a pause, and a bar back down through it'), barsAgo: 2 });
    }
    if (up(p2) && up(p) && up(c) && c.close > p.close && p.close > p2.close
      && body(c) > range(c) * 0.5 && body(p) > range(p) * 0.5) {
      out.push({ ...one('Three White Soldiers', 'BULLISH', 'Three strong bars up, each closing higher'), barsAgo: 2 });
    }
    if (down(p2) && down(p) && down(c) && c.close < p.close && p.close < p2.close
      && body(c) > range(c) * 0.5 && body(p) > range(p) * 0.5) {
      out.push({ ...one('Three Black Crows', 'BEARISH', 'Three strong bars down, each closing lower'), barsAgo: 2 });
    }
  }

  return out;
}

const one = (name: string, bias: Bias, note: string): Pattern => ({ name, bias, kind: 'candle', note, barsAgo: 0 });

// --------------------------------------------------------------- structure

export type StructureInput = {
  bars: readonly Candle[];
  level: { resistance: number | null; support: number | null };
  atr: number | null;
};

/**
 * The shapes that take more than three bars: the ones somebody would draw a
 * line on the chart for.
 */
export function structurePatterns(input: StructureInput): Pattern[] {
  const out: Pattern[] = [];
  const bars = input.bars.slice(-20);
  if (bars.length < 8) return out;
  const { resistance, support } = input.level;
  const atr = input.atr ?? 0;
  const tol = Math.max(atr * 0.15, 1);

  const lows = swings(bars, 'low');
  const highs = swings(bars, 'high');

  const risingLows = lows.length >= 2 && lows[lows.length - 1]! > lows[lows.length - 2]!;
  const fallingHighs = highs.length >= 2 && highs[highs.length - 1]! < highs[highs.length - 2]!;
  const flatHighs = highs.length >= 2 && Math.abs(highs[highs.length - 1]! - highs[highs.length - 2]!) <= tol;
  const flatLows = lows.length >= 2 && Math.abs(lows[lows.length - 1]! - lows[lows.length - 2]!) <= tol;

  if (risingLows) out.push(struct('Higher Lows', 'BULLISH', 'Each dip is being bought earlier'));
  if (fallingHighs) out.push(struct('Lower Highs', 'BEARISH', 'Each push is being sold sooner'));
  if (risingLows && flatHighs) out.push(struct('Ascending Triangle', 'BULLISH', 'Higher lows into one flat ceiling'));
  if (fallingHighs && flatLows) out.push(struct('Descending Triangle', 'BEARISH', 'Lower highs onto one flat floor'));
  if (risingLows && fallingHighs) out.push(struct('Symmetrical Triangle', 'NEUTRAL', 'The range is closing from both sides'));
  if (flatHighs && flatLows) out.push(struct('Rectangle', 'NEUTRAL', 'The same ceiling and the same floor, repeatedly'));

  // Touches of the level, which is what makes it a level rather than a number.
  if (resistance !== null) {
    const touches = bars.filter((b) => b.high >= resistance - tol).length;
    if (touches >= 2) {
      out.push(struct(`Resistance Test${touches > 2 ? ` (${touches}x)` : ''}`, 'BEARISH',
        `Tested ${fmt(resistance)} ${touches} times without going through`));
    }
  }
  if (support !== null) {
    const touches = bars.filter((b) => b.low <= support + tol).length;
    if (touches >= 2) {
      out.push(struct(`Support Test${touches > 2 ? ` (${touches}x)` : ''}`, 'BULLISH',
        `Held ${fmt(support)} ${touches} times`));
    }
  }

  // Volume building into whatever is about to happen.
  const ratio = volumeRatio(input.bars);
  if (ratio !== null && ratio >= 1.3 && rising(bars.slice(-4).map((b) => b.volume))) {
    out.push(struct('Volume Buildup', 'NEUTRAL', `Each bar busier than the last, now ${ratio.toFixed(1)}x`));
  }

  // Compression: the last few bars narrower than the ones before them, which
  // is what precedes a break far more often than a wide, noisy range does.
  const late = bars.slice(-5).map(range);
  const early = bars.slice(-15, -5).map(range);
  if (late.length && early.length) {
    const lateAvg = avg(late);
    const earlyAvg = avg(early);
    if (earlyAvg > 0 && lateAvg <= earlyAvg * 0.6) {
      out.push(struct('Compression', 'NEUTRAL', 'The bars are getting smaller: a move is being wound up'));
    }
  }

  return out;
}

const struct = (name: string, bias: Bias, note: string): Pattern => ({ name, bias, kind: 'structure', note, barsAgo: 0 });

/** The fractal swing points: a bar higher (or lower) than its two neighbours. */
function swings(bars: readonly Candle[], which: 'high' | 'low'): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const a = bars[i - 1]!, b = bars[i]!, c = bars[i + 1]!;
    if (which === 'high' ? b.high > a.high && b.high > c.high : b.low < a.low && b.low < c.low) {
      out.push(which === 'high' ? b.high : b.low);
    }
  }
  return out;
}

const rising = (xs: readonly number[]) => xs.length >= 2 && xs.every((v, i) => i === 0 || v >= xs[i - 1]!);
const avg = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });

// --------------------------------------------------------------- the picking

/**
 * The few worth showing, out of everything that is true.
 *
 * The rule is relevance to the state price is actually in, not strength in the
 * abstract: while price is pushing at resistance, a bearish engulfing on that
 * bar is the whole story and a hammer from two bars ago is trivia. Structure
 * first, because that is what somebody looking at the chart already sees, then
 * candles that agree with the side the state is about, then whatever is left.
 */
export function relevant(all: readonly Pattern[], event: MarketEvent, side: Side | null, limit = 4): Pattern[] {
  const wants: Bias | null = side === 'UP' ? 'BULLISH' : side === 'DOWN' ? 'BEARISH' : null;
  const testing = event.includes('WATCH') || event.includes('REJECTION');
  const ranked = [...all].sort((a, b) => score(b) - score(a));
  return ranked.slice(0, limit);

  function score(p: Pattern): number {
    let n = 0;
    if (p.kind === 'structure') n += 3;
    // While a level is being tested, the pattern that contradicts the push is
    // the one that matters: that is what a rejection looks like as it forms.
    if (wants && p.bias === wants) n += testing ? 1 : 2;
    if (wants && p.bias !== wants && p.bias !== 'NEUTRAL') n += testing ? 2 : 0;
    if (p.name.startsWith('Resistance Test') || p.name.startsWith('Support Test')) n += 1;
    n -= p.barsAgo * 0.5;
    return n;
  }
}
