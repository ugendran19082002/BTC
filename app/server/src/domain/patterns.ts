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

/**
 * A line drawn on the chart, in bars back from the newest bar.
 *
 * Not a pattern: a pattern is a name for what the bars did, this is where to
 * put the ink. The two travel together because they come from the same swings.
 */
export type TrendLine = {
  kind: 'support' | 'resistance';
  bias: Bias;
  from: { barsAgo: number; price: number };
  to: { barsAgo: number; price: number };
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
    /*
     * Three cases and they cover everything, which matters more than it looks.
     * A bar with no body has all of its range in its wicks, so one of them is
     * always at least half the bar -- a classification that left a gap here
     * would drop dojis on the floor rather than name them.
     */
    if (lw >= range(c) * 0.6) out.push(one('Dragonfly Doji', 'BULLISH', 'Sold down and bought all the way back'));
    else if (uw >= range(c) * 0.6) out.push(one('Gravestone Doji', 'BEARISH', 'Bought up and sold all the way back'));
    else out.push(one('Doji', 'NEUTRAL', 'Opened and closed in the same place: neither side held'));
  } else if (shape >= MARUBOZU_BODY) {
    out.push(one(up(c) ? 'Bullish Marubozu' : 'Bearish Marubozu', up(c) ? 'BULLISH' : 'BEARISH',
      'All body, no wick: one side had it the whole bar'));
  } else if (shape <= 0.3 && uw >= bodyC && lw >= bodyC && range(c) > 0
    && uw + lw >= range(c) * 0.8) {
    // Both wicks long against a small body: more violent than a spinning top,
    // and it means the same thing twice as loudly.
    out.push(one('High Wave Candle', 'NEUTRAL', 'Long wicks both ways: the bar was fought over and settled nothing'));
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

  // ---- two bars, the rest of the owner's list
  if (p && range(p) > 0) {
    const gapUp = c.low > p.high;
    const gapDown = c.high < p.low;
    if (body(p) > 0 && shape <= DOJI_BODY
      && Math.max(c.open, c.close) <= Math.max(p.open, p.close)
      && Math.min(c.open, c.close) >= Math.min(p.open, p.close)) {
      // A harami whose inside bar is a doji: the same pause, said harder.
      out.push(one(down(p) ? 'Harami Cross (Bullish)' : 'Harami Cross (Bearish)', down(p) ? 'BULLISH' : 'BEARISH',
        'A doji inside the last bar: the move has stopped'));
    }
    const closeNear = (a: number, b: number) => Math.abs(a - b) <= Math.max(range(c), range(p)) * 0.03;
    if (closeNear(c.close, p.close)) {
      if (down(p) && down(c)) out.push(one('Matching Low', 'BULLISH', 'Two falls closed at the same price: it is being defended'));
      if (up(p) && up(c)) out.push(one('Matching High', 'BEARISH', 'Two rises closed at the same price: it is being sold'));
    }
    if (down(p) && up(c) && gapDown && closeNear(c.close, p.close)) {
      out.push(one('Bullish Counterattack', 'BULLISH', 'Opened far lower and closed right back at the last close'));
    }
    if (up(p) && down(c) && gapUp && closeNear(c.close, p.close)) {
      out.push(one('Bearish Counterattack', 'BEARISH', 'Opened far higher and closed right back at the last close'));
    }
    // Kicking: two marubozu the opposite way with a gap between them. Rare, and
    // about as strong a two-bar signal as there is.
    const solid = (b: Candle) => range(b) > 0 && body(b) / range(b) >= MARUBOZU_BODY;
    if (solid(p) && solid(c) && down(p) && up(c) && gapUp) {
      out.push(one('Kicking (Bullish)', 'BULLISH', 'A solid fall, a gap up, a solid rise: the tape turned overnight'));
    }
    if (solid(p) && solid(c) && up(p) && down(c) && gapDown) {
      out.push(one('Kicking (Bearish)', 'BEARISH', 'A solid rise, a gap down, a solid fall: the tape turned overnight'));
    }
    // Where a rally stalls: opening into the last bar's body and closing inside it.
    if (down(p) && up(c) && c.open < p.low && c.close > p.close && c.close < mid(p)) {
      out.push(one(c.close <= p.close + body(p) * 0.1 ? 'On-Neck Line' : 'In-Neck Line', 'BEARISH',
        'Bounced into the last bar and stopped at its bottom: the fall is not done'));
    }
    if (down(p) && up(c) && c.open < p.low && c.close > mid(p) && c.close < p.open) {
      out.push(one('Thrusting Pattern', 'BEARISH', 'Back into the last bar but not through its middle'));
    }
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


  // ---- three bars, the rest of the list
  if (p && p2 && range(p) > 0 && range(p2) > 0) {
    const inside = body(p2) > 0
      && Math.max(p.open, p.close) <= Math.max(p2.open, p2.close)
      && Math.min(p.open, p.close) >= Math.min(p2.open, p2.close);
    if (inside && up(c) && down(p2) && c.close > p2.open) {
      out.push({ ...one('Three Inside Up', 'BULLISH', 'A fall, a bar inside it, and a close back through the top'), barsAgo: 2 });
    }
    if (inside && down(c) && up(p2) && c.close < p2.open) {
      out.push({ ...one('Three Inside Down', 'BEARISH', 'A rise, a bar inside it, and a close back through the bottom'), barsAgo: 2 });
    }
    const engulfs = down(p2) && up(p) && p.close >= p2.open && p.open <= p2.close;
    if (engulfs && up(c) && c.close > p.close) {
      out.push({ ...one('Three Outside Up', 'BULLISH', 'A fall, a bar covering it, and another up'), barsAgo: 2 });
    }
    const engulfsDown = up(p2) && down(p) && p.close <= p2.open && p.open >= p2.close;
    if (engulfsDown && down(c) && c.close < p.close) {
      out.push({ ...one('Three Outside Down', 'BEARISH', 'A rise, a bar covering it, and another down'), barsAgo: 2 });
    }
    // Abandoned baby: a doji gapped away from both neighbours. The cleanest
    // three-bar reversal there is, and the rarest.
    const pShape = bodyRatio(p) ?? 1;
    if (pShape <= DOJI_BODY && down(p2) && up(c) && p.high < p2.low && p.high < c.low) {
      out.push({ ...one('Abandoned Baby (Bullish)', 'BULLISH', 'A doji gapped below both its neighbours'), barsAgo: 2 });
    }
    if (pShape <= DOJI_BODY && up(p2) && down(c) && p.low > p2.high && p.low > c.high) {
      out.push({ ...one('Abandoned Baby (Bearish)', 'BEARISH', 'A doji gapped above both its neighbours'), barsAgo: 2 });
    }
    if (up(p2) && up(p) && up(c) && c.low > p.low && p.low > p2.low) {
      out.push({ ...one('Three Gaps Up', 'BEARISH', 'Three rises, each starting above the last: stretched'), barsAgo: 2 });
    }
    if (down(p2) && down(p) && down(c) && c.high < p.high && p.high < p2.high) {
      out.push({ ...one('Three Gaps Down', 'BULLISH', 'Three falls, each starting below the last: stretched'), barsAgo: 2 });
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
  return pivots(bars, which).map((p) => p.price);
}

/** The same swings, with the bar each one is on. */
function pivots(bars: readonly Candle[], which: 'high' | 'low'): { i: number; price: number }[] {
  const out: { i: number; price: number }[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const a = bars[i - 1]!, b = bars[i]!, c = bars[i + 1]!;
    if (which === 'high' ? b.high > a.high && b.high > c.high : b.low < a.low && b.low < c.low) {
      out.push({ i, price: which === 'high' ? b.high : b.low });
    }
  }
  return out;
}

/**
 * The two lines somebody would draw on this chart: one under the lows, one
 * over the highs.
 *
 * Through the last two swings on each side, carried forward to the newest bar
 * -- which is the whole point of drawing one, since the line only says
 * anything where price has not been yet. Both ends are given as bars back from
 * the newest bar rather than as an index into a slice, so a chart showing a
 * different window can still place them.
 *
 * Two swings is the least a line can be drawn through and is what a trader
 * uses; it is also the weakest kind, so nothing here calls it confirmed.
 */
export function trendLines(bars: readonly Candle[], lookback = 20): TrendLine[] {
  const window = bars.slice(-lookback);
  if (window.length < 5) return [];
  const last = window.length - 1;
  const out: TrendLine[] = [];

  for (const [which, kind] of [['low', 'support'], ['high', 'resistance']] as const) {
    const found = pivots(window, which);
    if (found.length < 2) continue;
    const a = found[found.length - 2]!;
    const b = found[found.length - 1]!;
    if (b.i === a.i) continue;
    const slope = (b.price - a.price) / (b.i - a.i);
    // Carried to the newest bar, which is where a trendline earns its keep.
    const end = b.price + slope * (last - b.i);
    out.push({
      kind,
      bias: slope > 0 ? 'BULLISH' : slope < 0 ? 'BEARISH' : 'NEUTRAL',
      from: { barsAgo: last - a.i, price: round2(a.price) },
      to: { barsAgo: 0, price: round2(end) },
    });
  }
  return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

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
export function relevant(all: readonly Pattern[], event: MarketEvent, side: Side | null, limit = 20): Pattern[] {
  const wants: Bias | null = side === 'UP' ? 'BULLISH' : side === 'DOWN' ? 'BEARISH' : null;
  const testing = event.includes('WATCH') || event.includes('REJECTION');
  const ranked = [...all].sort((a, b) => score(b) - score(a));
  return ranked.slice(0, limit);

  function score(p: Pattern): number {
    let n = 0;
    if (p.kind === 'structure') n += 3;
    if (p.name.includes('Order Block') || p.name.includes('FVG')) n += 2;
    // While a level is being tested, the pattern that contradicts the push is
    // the one that matters: that is what a rejection looks like as it forms.
    if (wants && p.bias === wants) n += testing ? 1 : 2;
    if (wants && p.bias !== wants && p.bias !== 'NEUTRAL') n += testing ? 2 : 0;
    if (p.name.startsWith('Resistance Test') || p.name.startsWith('Support Test')) n += 1;
    n -= p.barsAgo * 0.5;
    return n;
  }
}

// -------------------------------------------------------- market structure

/**
 * What the swings themselves are doing: the structure half of the owner's list.
 *
 * Higher highs and lower lows, the break of structure that ends a trend, the
 * change of character that warns of it, the sweep that takes the stops above a
 * high and gives it all back, and the shapes those swings make -- double tops,
 * head and shoulders, flags, channels.
 *
 * All of it from the same fractal pivots the trendlines are drawn through, so
 * nothing here can name a high the lines do not also bend around. Everything
 * is a pure function of bars; none of it is shown on its own, because a card
 * with thirty true things on it is a card nobody reads -- they are all votes
 * in the chart's up-or-down badge, and `relevant()` picks the few worth space.
 */
export function marketStructure(input: { bars: readonly Candle[]; atr: number | null }): Pattern[] {
  const out: Pattern[] = [];
  const bars = input.bars.slice(-40);
  if (bars.length < 10) return out;
  const tol = Math.max((input.atr ?? 0) * 0.2, 1);
  const last = bars[bars.length - 1]!;
  const highs = pivots(bars, 'high');
  const lows = pivots(bars, 'low');
  const agoOf = (i: number) => bars.length - 1 - i;
  const near = (a: number, b: number) => Math.abs(a - b) <= tol;

  const h1 = highs[highs.length - 1];
  const h0 = highs[highs.length - 2];
  const l1 = lows[lows.length - 1];
  const l0 = lows[lows.length - 2];

  // The four labels every structure reading is built out of.
  if (h1 && h0) {
    if (h1.price > h0.price + tol) out.push(at('Higher High', 'BULLISH', 'Each push is going further', agoOf(h1.i)));
    else if (h1.price < h0.price - tol) out.push(at('Lower High', 'BEARISH', 'The last push fell short of the one before', agoOf(h1.i)));
    else out.push(at('Equal Highs', 'NEUTRAL', 'Two pushes stopped at the same price: stops are sitting above', agoOf(h1.i)));
  }
  if (l1 && l0) {
    if (l1.price > l0.price + tol) out.push(at('Higher Low', 'BULLISH', 'The dip was bought earlier than the last one', agoOf(l1.i)));
    else if (l1.price < l0.price - tol) out.push(at('Lower Low', 'BEARISH', 'The dip went further than the last one', agoOf(l1.i)));
    else out.push(at('Equal Lows', 'NEUTRAL', 'Two dips stopped at the same price: stops are sitting below', agoOf(l1.i)));
  }

  /*
   * Break of structure and change of character.
   *
   * A BOS is the trend continuing: price closes through the swing it was
   * already heading towards. A CHOCH is the first sign it is not -- an uptrend
   * closing below the low it last bounced from. The difference is which way
   * the swings were going before the break, so both need the pair, not one.
   */
  const upTrend = h1 && h0 && l1 && l0 && h1.price > h0.price && l1.price > l0.price;
  const downTrend = h1 && h0 && l1 && l0 && h1.price < h0.price && l1.price < l0.price;
  if (h1 && last.close > h1.price + tol) {
    out.push(one2(upTrend ? 'BOS (Break of Structure)' : 'Market Structure Shift', 'BULLISH',
      upTrend ? `Closed through the last swing high at ${fmt(h1.price)}` : `Took out ${fmt(h1.price)} against the run of the swings`));
  }
  if (l1 && last.close < l1.price - tol) {
    out.push(one2(downTrend ? 'BOS (Break of Structure)' : 'Market Structure Shift', 'BEARISH',
      downTrend ? `Closed through the last swing low at ${fmt(l1.price)}` : `Lost ${fmt(l1.price)} against the run of the swings`));
  }
  if (upTrend && l1 && last.close < l1.price - tol) {
    out.push(one2('CHOCH (Change of Character)', 'BEARISH', 'An uptrend has closed under the low it last bounced from'));
  }
  if (downTrend && h1 && last.close > h1.price + tol) {
    out.push(one2('CHOCH (Change of Character)', 'BULLISH', 'A downtrend has closed over the high it last turned at'));
  }

  /*
   * A liquidity sweep: the wick goes through, the close does not.
   *
   * It is the one shape where more of the move is evidence *against* it -- the
   * stops above the high were taken and the price was given straight back.
   */
  for (const [i, bar] of bars.slice(-3).entries()) {
    const ago = 2 - i;
    if (h0 && bar.high > h0.price + tol && bar.close < h0.price) {
      out.push(at('Liquidity Sweep (High)', 'BEARISH', `Took the stops over ${fmt(h0.price)} and closed back under`, ago));
    }
    if (l0 && bar.low < l0.price - tol && bar.close > l0.price) {
      out.push(at('Liquidity Sweep (Low)', 'BULLISH', `Took the stops under ${fmt(l0.price)} and closed back over`, ago));
    }
  }

  // Double and triple tops and bottoms: the same price refused twice or three
  // times, with a real trough between -- two highs in consecutive bars are one
  // high, not a pattern.
  const trough = (a: { i: number }, b: { i: number }) => Math.min(...bars.slice(a.i, b.i + 1).map((x) => x.low));
  const peak = (a: { i: number }, b: { i: number }) => Math.max(...bars.slice(a.i, b.i + 1).map((x) => x.high));
  if (h1 && h0 && near(h1.price, h0.price) && h0.price - trough(h0, h1) >= tol * 3) {
    const third = highs[highs.length - 3];
    const triple = third && near(third.price, h0.price);
    out.push(at(triple ? 'Triple Top' : 'Double Top', 'BEARISH',
      `${fmt(h1.price)} refused ${triple ? 'three times' : 'twice'}`, agoOf(h1.i)));
  }
  if (l1 && l0 && near(l1.price, l0.price) && peak(l0, l1) - l0.price >= tol * 3) {
    const third = lows[lows.length - 3];
    const triple = third && near(third.price, l0.price);
    out.push(at(triple ? 'Triple Bottom' : 'Double Bottom', 'BULLISH',
      `${fmt(l1.price)} held ${triple ? 'three times' : 'twice'}`, agoOf(l1.i)));
  }

  // Head and shoulders: a peak with a lower one either side of it, within a
  // tolerance of each other.
  const h2 = highs[highs.length - 3];
  if (h2 && h0 && h1 && h0.price > h2.price + tol && h0.price > h1.price + tol && near(h2.price, h1.price)) {
    out.push(at('Head & Shoulders', 'BEARISH', 'A high with a lower one either side: the push is done', agoOf(h1.i)));
  }
  const l2 = lows[lows.length - 3];
  if (l2 && l0 && l1 && l0.price < l2.price - tol && l0.price < l1.price - tol && near(l2.price, l1.price)) {
    out.push(at('Inverse Head & Shoulders', 'BULLISH', 'A low with a higher one either side: the fall is done', agoOf(l1.i)));
  }

  // A channel: both ends of the swing moving the same way.
  if (h1 && h0 && l1 && l0) {
    if (h1.price > h0.price + tol && l1.price > l0.price + tol) {
      out.push(one2('Channel Up', 'BULLISH', 'Higher highs and higher lows together'));
    }
    if (h1.price < h0.price - tol && l1.price < l0.price - tol) {
      out.push(one2('Channel Down', 'BEARISH', 'Lower highs and lower lows together'));
    }
  }

  /*
   * Flags: a hard push, then a quiet drift against it.
   *
   * The drift is the point -- price that gives nothing back after a run is
   * being held, and the shape resolves the way the run went far more often
   * than the drift does.
   */
  const impulse = bars.slice(-9, -4);
  const drift = bars.slice(-4);
  if (impulse.length === 5 && drift.length === 4 && input.atr) {
    const move = impulse[impulse.length - 1]!.close - impulse[0]!.open;
    const driftRange = Math.max(...drift.map((b) => b.high)) - Math.min(...drift.map((b) => b.low));
    if (Math.abs(move) >= input.atr * 1.5 && driftRange <= Math.abs(move) * 0.5) {
      out.push(one2(move > 0 ? 'Bull Flag' : 'Bear Flag', move > 0 ? 'BULLISH' : 'BEARISH',
        `${fmt(Math.abs(move))} in five bars, and it has given almost none of it back`));
    }
  }

  // Fair Value Gaps (FVG) / Imbalances:
  // 3-bar pattern where the wicks of bar 1 and bar 3 do not overlap, creating an institutional imbalance.
  const fvgTol = Math.max((input.atr ?? 0) * 0.1, 1);
  for (let i = bars.length - 3; i >= Math.max(0, bars.length - 15); i--) {
    const b0 = bars[i]!, b1 = bars[i + 1]!, b2 = bars[i + 2]!;
    if (b1.close > b1.open && b2.low > b0.high + fvgTol) {
      const later = bars.slice(i + 3);
      const mitigated = later.some((b) => b.low <= b0.high);
      if (!mitigated) {
        const testing = last.low <= b2.low && last.high >= b0.high;
        out.push(at(
          testing ? `Bullish FVG Test (${fmt(b0.high)}–${fmt(b2.low)})` : `Bullish FVG (${fmt(b0.high)}–${fmt(b2.low)})`,
          'BULLISH',
          testing ? `Price currently testing unmitigated buyer imbalance at ${fmt(b0.high)}–${fmt(b2.low)}`
            : `Unmitigated buyer imbalance zone at ${fmt(b0.high)}–${fmt(b2.low)}`,
          agoOf(i + 1),
        ));
        break;
      }
    }
    if (b1.close < b1.open && b0.low > b2.high + fvgTol) {
      const later = bars.slice(i + 3);
      const mitigated = later.some((b) => b.high >= b0.low);
      if (!mitigated) {
        const testing = last.high >= b2.high && last.low <= b0.low;
        out.push(at(
          testing ? `Bearish FVG Test (${fmt(b2.high)}–${fmt(b0.low)})` : `Bearish FVG (${fmt(b2.high)}–${fmt(b0.low)})`,
          'BEARISH',
          testing ? `Price currently testing unmitigated seller imbalance at ${fmt(b2.high)}–${fmt(b0.low)}`
            : `Unmitigated seller imbalance zone at ${fmt(b2.high)}–${fmt(b0.low)}`,
          agoOf(i + 1),
        ));
        break;
      }
    }
  }

  // Order Blocks (OB):
  // The origin counter-trend candle before an aggressive expansion (>= 1.2 * ATR).
  if (input.atr && input.atr > 0) {
    for (let i = bars.length - 2; i >= Math.max(1, bars.length - 20); i--) {
      const impulseBar = bars[i]!;
      const obBar = bars[i - 1]!;
      if (obBar.close < obBar.open && (impulseBar.close - impulseBar.open) >= input.atr * 1.2 && impulseBar.close > obBar.high) {
        const later = bars.slice(i + 1);
        const broken = later.some((b) => b.close < obBar.low);
        if (!broken) {
          const inZone = last.low <= obBar.high && last.close >= obBar.low;
          out.push(at(
            inZone ? `Bullish Order Block Test (${fmt(obBar.low)}–${fmt(obBar.high)})` : `Bullish Order Block (${fmt(obBar.low)}–${fmt(obBar.high)})`,
            'BULLISH',
            inZone ? `Price testing institutional demand base at ${fmt(obBar.low)}–${fmt(obBar.high)}`
              : `Institutional demand base before breakout at ${fmt(obBar.low)}–${fmt(obBar.high)}`,
            agoOf(i - 1),
          ));
          break;
        }
      }
      if (obBar.close > obBar.open && (impulseBar.open - impulseBar.close) >= input.atr * 1.2 && impulseBar.close < obBar.low) {
        const later = bars.slice(i + 1);
        const broken = later.some((b) => b.close > obBar.high);
        if (!broken) {
          const inZone = last.high >= obBar.low && last.close <= obBar.high;
          out.push(at(
            inZone ? `Bearish Order Block Test (${fmt(obBar.low)}–${fmt(obBar.high)})` : `Bearish Order Block (${fmt(obBar.low)}–${fmt(obBar.high)})`,
            'BEARISH',
            inZone ? `Price testing institutional supply base at ${fmt(obBar.low)}–${fmt(obBar.high)}`
              : `Institutional supply base before breakdown at ${fmt(obBar.low)}–${fmt(obBar.high)}`,
            agoOf(i - 1),
          ));
          break;
        }
      }
    }
  }

  return out;
}

const at = (name: string, bias: Bias, note: string, barsAgo: number): Pattern =>
  ({ name, bias, kind: 'structure', note, barsAgo: Math.max(0, barsAgo) });
const one2 = (name: string, bias: Bias, note: string): Pattern => at(name, bias, note, 0);
