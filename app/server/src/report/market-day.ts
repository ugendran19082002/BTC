/**
 * One expiry day of the BTC perp, measured and named (owner, 13 Oct 2026).
 *
 * "Every day, the market's trend: 5:31 PM to 5:29 PM, how the whole expiry went" -- the daily option settles at
 * 5:30 PM IST, so the day that matters to a desk selling it runs from one settlement to the next, and is named
 * for the date it ends on. Each such day gets its figures -- the high and the low with their points, the zigzag,
 * the ATR and where it stands among the days before, how far the largest candle stood out -- and one of twenty
 * names for its shape, so that what the methods made can be read against the kind of day it was.
 *
 * Pure: bars in, figures out. The bars are the desk's own one-minute tape of the perp (`trade_flow_1m`), which
 * keeps a high, a low and a volume-weighted price for each minute; that price is taken as the minute's close.
 *
 * THE NAMING, in the order it is tried -- the first that fits is the day's name (`classify`):
 *
 *   1. a tight start, then out of it and gone          COMPRESSION_BREAKOUT
 *   2. one candle that is most of the day              VOLATILITY_SPIKE
 *   3. a day that ended well away from where it began  the trend names -- losing strength, pausing, breaking on,
 *                                                       else clean / zigzag / high zigzag by its pullbacks
 *   4. the rest ended near where it began              low volatility, a reversal, a failed break, wide, choppy,
 *                                                       zigzag, else clean
 *
 * Every threshold is in `RULES`, in one place, with the day it was set against. They were set on the 24 expiry
 * days from 20 Sep to 13 Oct 2026; they are judgements, and a number that proves wrong is changed there and
 * `MARKET_DAY_VERSION` raised, which has every stored day named again.
 */

export type MinuteBar = { at: number; high: number; low: number; close: number };

/** Raise when the figures or the rules change: stored days of an older version are worked out again. */
export const MARKET_DAY_VERSION = 1;

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
/** The daily option settles at 5:30 PM IST: an expiry day runs from that minute to the same minute a day later. */
export const SETTLE_MIN_IST = 17 * 60 + 30;

/** The expiry day a moment belongs to, as the IST date it ends on. 5:30 PM IST is the first minute of the next one. */
export const sessionDayOf = (ms: number): string =>
  new Date(ms + IST_MS + (DAY_MS - SETTLE_MIN_IST * 60_000)).toISOString().slice(0, 10);

/** An expiry day's span, epoch ms: from 5:30 PM IST the evening before to 5:30 PM IST on the day, the end not included. */
export function sessionOf(day: string): { from: number; to: number } {
  const to = Date.parse(`${day}T00:00:00Z`) - IST_MS + SETTLE_MIN_IST * 60_000;
  return { from: to - DAY_MS, to };
}

/** The expiry days from one to another, both included, oldest first. */
export function sessionDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export const RULES = {
  /** A zigzag swing: a move of this share of the price against the swing before it (about 210 points at 84,000). */
  zigzagPct: 0.0025,
  /** A trend day: it closed this share of its own range away from its open, and at least this share of the price. */
  trendShare: 0.45, trendNetPct: 0.006,
  /** A spike: one 15-minute candle of this share of the price, and this share of the day's range. */
  spikeCandlePct: 0.012, spikeShare: 0.45,
  /** Compression: the first `compressEarly` of the day inside this share of the range, and the close this far outside it. */
  compressEarly: 0.6, compressRange: 0.4, compressClose: 0.3,
  /** Exhaustion: a trend that gave this much of its run back, having made its extreme before this point of the day. */
  exhaustFrom: 0.35, exhaustTo: 0.6, exhaustBy: 0.85,
  /** A trend that paused: the last third inside this share of the range, and moved this little of it. */
  pauseRange: 0.3, pauseNet: 0.1,
  /** A trend that broke on: a quiet middle third, then this share of the range again in the trend's direction. */
  breakMidNet: 0.12, breakMidRange: 0.45, breakLeg: 0.25, breakFirst: 0.15,
  /** A trend's pullbacks: the largest swing against it as a share of the range, and the path walked over the range. */
  cleanCounter: 0.25, cleanPath: 3, highCounter: 0.45, highPath: 6,
  /** Low volatility: the ATR among the lowest fifth of the days before; with too few days before, a range this narrow. */
  lowVolPercentile: 20, lowVolRangePct: 0.012,
  /** A reversal: this share of the range one way from the open, this share of that leg taken back, on a day this wide. */
  reversalOut: 0.6, reversalBack: 0.6, reversalRangePct: 0.025, reversalFrom: 0.15, reversalTo: 0.85,
  /** A failed break: past the first third's range by this share of the day's, and closed back inside it. */
  falseBreak: 0.1,
  /** A range day's width and noise: wide by its range; choppy and zigzag by the path walked over the range. */
  wideRangePct: 0.025, choppyPath: 5, zigzagPath: 3.5,
} as const;

export type PatternFamily = 'up' | 'down' | 'range' | 'turn';
export type PatternKey =
  | 'UP_TREND_CLEAN' | 'UP_TREND_ZIGZAG' | 'UP_TREND_HIGH_ZIGZAG'
  | 'DOWN_TREND_CLEAN' | 'DOWN_TREND_ZIGZAG' | 'DOWN_TREND_HIGH_ZIGZAG'
  | 'RANGE_CLEAN' | 'RANGE_ZIGZAG' | 'RANGE_WIDE_ZIGZAG' | 'RANGE_LOW_VOLATILITY'
  | 'UPTREND_RANGE' | 'DOWNTREND_RANGE' | 'UPTREND_BREAKOUT' | 'DOWNTREND_BREAKDOWN'
  | 'FALSE_BREAKOUT_RANGE' | 'REVERSAL_ZIGZAG' | 'SIDEWAYS_CHOPPY' | 'TREND_EXHAUSTION'
  | 'COMPRESSION_BREAKOUT' | 'VOLATILITY_SPIKE';

/** The twenty names, with the owner's own numbers and meanings, a short name for a phone, and the family each is counted with. */
export const PATTERNS: readonly { id: number; key: PatternKey; name: string; meaning: string; family: PatternFamily }[] = [
  { id: 1, key: 'UP_TREND_CLEAN', name: 'Up trend · clean', meaning: 'Smooth upward movement', family: 'up' },
  { id: 2, key: 'UP_TREND_ZIGZAG', name: 'Up trend · zigzag', meaning: 'Uptrend with pullbacks', family: 'up' },
  { id: 3, key: 'UP_TREND_HIGH_ZIGZAG', name: 'Up trend · high zigzag', meaning: 'Uptrend, but large swings', family: 'up' },
  { id: 4, key: 'DOWN_TREND_CLEAN', name: 'Down trend · clean', meaning: 'Smooth downward movement', family: 'down' },
  { id: 5, key: 'DOWN_TREND_ZIGZAG', name: 'Down trend · zigzag', meaning: 'Downtrend with bounces', family: 'down' },
  { id: 6, key: 'DOWN_TREND_HIGH_ZIGZAG', name: 'Down trend · high zigzag', meaning: 'Downtrend with violent reversals', family: 'down' },
  { id: 7, key: 'RANGE_CLEAN', name: 'Range · clean', meaning: 'Tight horizontal range', family: 'range' },
  { id: 8, key: 'RANGE_ZIGZAG', name: 'Range · zigzag', meaning: 'Range with frequent swings', family: 'range' },
  { id: 9, key: 'RANGE_WIDE_ZIGZAG', name: 'Range · wide zigzag', meaning: 'Wide range, high volatility', family: 'range' },
  { id: 10, key: 'RANGE_LOW_VOLATILITY', name: 'Range · low volatility', meaning: 'Narrow candles and low ATR', family: 'range' },
  { id: 11, key: 'UPTREND_RANGE', name: 'Up trend, then range', meaning: 'Uptrend pauses in consolidation', family: 'up' },
  { id: 12, key: 'DOWNTREND_RANGE', name: 'Down trend, then range', meaning: 'Downtrend pauses in consolidation', family: 'down' },
  { id: 13, key: 'UPTREND_BREAKOUT', name: 'Up trend breakout', meaning: 'Upward continuation breakout', family: 'up' },
  { id: 14, key: 'DOWNTREND_BREAKDOWN', name: 'Down trend breakdown', meaning: 'Downward continuation breakdown', family: 'down' },
  { id: 15, key: 'FALSE_BREAKOUT_RANGE', name: 'False breakout', meaning: 'Breakout attempt fails', family: 'range' },
  { id: 16, key: 'REVERSAL_ZIGZAG', name: 'Reversal', meaning: 'Direction changes repeatedly near a turning point', family: 'turn' },
  { id: 17, key: 'SIDEWAYS_CHOPPY', name: 'Sideways · choppy', meaning: 'Noisy, directionless movement', family: 'range' },
  { id: 18, key: 'TREND_EXHAUSTION', name: 'Trend exhaustion', meaning: 'Existing trend losing strength', family: 'turn' },
  { id: 19, key: 'COMPRESSION_BREAKOUT', name: 'Compression breakout', meaning: 'Tight price compression followed by breakout', family: 'turn' },
  { id: 20, key: 'VOLATILITY_SPIKE', name: 'Volatility spike', meaning: 'Sudden large movement', family: 'turn' },
];

export const FAMILIES: readonly { key: PatternFamily; name: string }[] = [
  { key: 'up', name: 'Up trend' }, { key: 'down', name: 'Down trend' }, { key: 'range', name: 'Range' }, { key: 'turn', name: 'Turn / event' },
];

export const familyOf = (key: PatternKey): PatternFamily => PATTERNS.find((p) => p.key === key)!.family;

export type DayStats = {
  /** One-minute bars the figures are from: 1,440 for a whole day. */
  bars: number;
  open: number; close: number; high: number; low: number;
  highAt: number; lowAt: number;
  /** High less low, and as a share of the open. */
  rangePts: number; rangePct: number;
  /** Close less open, signed, and as a share of the open. */
  netPts: number; netPct: number;
  /** The most it stood above the open, and below it. */
  upPts: number; downPts: number;
  /** How much of its own range the day kept, 0-1: 1 opened at one end and closed at the other. */
  dirShare: number;
  /** Net move over the path walked on 15-minute closes (Kaufman's efficiency), 0-1. */
  efficiency: number;
  /** The mean true range of the day's 15-minute candles, in points and as a share of the price. */
  atr: number; atrPct: number;
  /** Where that ATR stands among the up-to-30 expiry days before, 0-100; null with fewer than five before. */
  atrPercentile: number | null;
  /** The ATR over the mean ATR of the five days before: over 1 is volatility expanding. Null with fewer than five. */
  volExpansion: number | null;
  /** The largest 15-minute candle's true range over the day's median one. */
  candleExpansion: number;
  /** That candle: when, its points, its share of the day's range and of the price, and which way it closed. */
  bigCandle: { at: number; pts: number; shareOfRange: number; pctOfPrice: number; up: boolean };
  /** The late day's candles against the early day's: the last third's mean true range over the first third's. */
  lateVsEarly: number;
  zigzag: {
    /** A swing is a move of this many points against the one before (`RULES.zigzagPct` of the open). */
    thresholdPts: number;
    /** Turns: the legs less one. */
    swings: number;
    /** Every leg added up, whichever way it went: the path the price walked. */
    totalPts: number;
    avgPts: number; maxUpPts: number; maxDownPts: number;
    /** The turning points, for a line: [epoch ms, price]. */
    pivots: [number, number][];
  };
  /** The path walked over the day's range: 1 is a straight line from one end to the other. */
  pathRatio: number;
  /** The largest swing against the day's direction, as a share of the range. */
  counterShare: number;
  /** The day in thirds: what each made, and how much of the day's range each covered. */
  thirds: { netPts: number; rangeShare: number }[];
  /** Where in the day the high and the low were made, 0-1. */
  highPos: number; lowPos: number;
  /** The first `RULES.compressEarly` of the day: its share of the range, and how far outside it the close is (signed, in ranges). */
  earlyRangeShare: number; closeBeyondEarly: number;
  /** The first third's high and low, how far the rest of the day went past each (in ranges), and whether the close is back inside. */
  firstHigh: number; firstLow: number; breakUp: number; breakDown: number; closeInsideFirst: boolean;
  /** Half-hour closes, oldest first: the day as a line. */
  line: number[];
};

type Candle = { at: number; open: number; high: number; low: number; close: number };

/** Minutes into candles of `sec` seconds. A candle opens where the one before closed; the first, at its first minute's price. */
export function candles(bars: readonly MinuteBar[], sec: number): Candle[] {
  const out: Candle[] = [];
  let prevClose: number | null = null;
  for (const b of bars) {
    const at = Math.floor(b.at / (sec * 1_000)) * sec * 1_000;
    const last = out[out.length - 1];
    if (last && last.at === at) {
      last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close;
    } else {
      const open: number = prevClose ?? b.close;
      out.push({ at, open, high: Math.max(b.high, open), low: Math.min(b.low, open), close: b.close });
    }
    prevClose = b.close;
  }
  return out;
}

/** The turning points of a series of closes: a new leg starts when the price has come `thr` back from the leg's extreme. */
export function zigzagOf(points: readonly { at: number; price: number }[], thr: number): [number, number][] {
  if (points.length === 0) return [];
  const first = points[0]!;
  const pivots: [number, number][] = [[first.at, first.price]];
  let dir = 0;
  let ext = first;
  for (const p of points) {
    if (dir === 0) {
      if (Math.abs(p.price - first.price) >= thr) { dir = p.price > first.price ? 1 : -1; ext = p; }
    } else if (dir === 1 ? p.price > ext.price : p.price < ext.price) {
      ext = p;
    } else if (Math.abs(ext.price - p.price) >= thr) {
      pivots.push([ext.at, ext.price]);
      dir = -dir; ext = p;
    }
  }
  const last = points[points.length - 1]!;
  if (last.at !== pivots[pivots.length - 1]![0]) pivots.push([last.at, last.price]);
  return pivots;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
const median = (xs: readonly number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1_000) / 1_000;

/** Fewer minutes than this and a day has no figures: an hour of tape is not a day. */
export const MIN_BARS = 60;

/**
 * A day's figures from its one-minute bars, oldest first. `priorAtr` is the ATR of the expiry days before it,
 * oldest first: what its ATR is ranked against. Null with too few bars to say anything.
 */
export function dayStats(bars: readonly MinuteBar[], priorAtr: readonly number[] = []): DayStats | null {
  if (bars.length < MIN_BARS) return null;
  const n = bars.length;
  const open = bars[0]!.close, close = bars[n - 1]!.close;
  let hi = 0, lo = 0;
  for (let i = 1; i < n; i++) { if (bars[i]!.high > bars[hi]!.high) hi = i; if (bars[i]!.low < bars[lo]!.low) lo = i; }
  const high = Math.max(bars[hi]!.high, open), low = Math.min(bars[lo]!.low, open);
  const range = Math.max(high - low, 1e-9);
  const net = close - open;

  const c15 = candles(bars, 900);
  const tr = c15.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - c15[i - 1]!.close), Math.abs(c.low - c15[i - 1]!.close))));
  const atr = mean(tr);
  let big = 0;
  for (let i = 1; i < tr.length; i++) if (tr[i]! > tr[big]!) big = i;
  const third = Math.max(1, Math.floor(tr.length / 3));
  const prior = priorAtr.slice(-30);
  const walked = c15.reduce((a, c, i) => a + (i ? Math.abs(c.close - c15[i - 1]!.close) : 0), 0);

  const c5 = candles(bars, 300);
  const thr = open * RULES.zigzagPct;
  const pivots = zigzagOf(c5.map((c) => ({ at: c.at, price: c.close })), thr);
  const legs = pivots.slice(1).map((p, i) => p[1] - pivots[i]![1]);
  const total = legs.reduce((a, x) => a + Math.abs(x), 0);
  const against = legs.filter((x) => (net >= 0 ? x < 0 : x > 0)).map(Math.abs);

  const cut = (a: number, b: number) => bars.slice(Math.floor(n * a), Math.max(Math.floor(n * a) + 1, Math.floor(n * b)));
  const spanOf = (xs: readonly MinuteBar[]) => ({ high: Math.max(...xs.map((b) => b.high)), low: Math.min(...xs.map((b) => b.low)) });
  const thirds = [cut(0, 1 / 3), cut(1 / 3, 2 / 3), cut(2 / 3, 1)].map((xs) => {
    const s = spanOf(xs);
    return { netPts: r1(xs[xs.length - 1]!.close - xs[0]!.close), rangeShare: r3((s.high - s.low) / range) };
  });
  const early = spanOf(cut(0, RULES.compressEarly));
  const first = spanOf(cut(0, 1 / 3));
  const rest = spanOf(cut(1 / 3, 1));

  const c30 = candles(bars, 1_800);
  return {
    bars: n, open: r1(open), close: r1(close), high: r1(high), low: r1(low), highAt: bars[hi]!.at, lowAt: bars[lo]!.at,
    rangePts: r1(range), rangePct: r3(range / open * 100) / 100, netPts: r1(net), netPct: r3(net / open * 100) / 100,
    upPts: r1(high - open), downPts: r1(open - low),
    dirShare: r3(Math.abs(net) / range), efficiency: r3(walked > 0 ? Math.abs(c15[c15.length - 1]!.close - c15[0]!.close) / walked : 0),
    atr: r1(atr), atrPct: r3(atr / open * 100) / 100,
    atrPercentile: prior.length >= 5 ? Math.round(100 * prior.filter((a) => a <= atr).length / prior.length) : null,
    volExpansion: prior.length >= 5 ? r3(atr / mean(prior.slice(-5))) : null,
    candleExpansion: r3(tr[big]! / Math.max(median(tr), 1e-9)),
    bigCandle: { at: c15[big]!.at, pts: r1(tr[big]!), shareOfRange: r3(tr[big]! / range), pctOfPrice: r3(tr[big]! / open * 100) / 100, up: c15[big]!.close >= c15[big]!.open },
    lateVsEarly: r3(mean(tr.slice(-third)) / Math.max(mean(tr.slice(0, third)), 1e-9)),
    zigzag: {
      thresholdPts: r1(thr), swings: Math.max(0, legs.length - 1), totalPts: r1(total), avgPts: r1(legs.length ? total / legs.length : 0),
      maxUpPts: r1(Math.max(0, ...legs)), maxDownPts: r1(Math.max(0, ...legs.map((x) => -x))),
      pivots: pivots.map(([at, p]) => [at, r1(p)] as [number, number]),
    },
    pathRatio: r3(total / range), counterShare: r3(Math.max(0, ...against) / range),
    thirds, highPos: r3(hi / (n - 1)), lowPos: r3(lo / (n - 1)),
    earlyRangeShare: r3((early.high - early.low) / range),
    closeBeyondEarly: r3(close > early.high ? (close - early.high) / range : close < early.low ? -(early.low - close) / range : 0),
    firstHigh: r1(first.high), firstLow: r1(first.low),
    breakUp: r3(Math.max(0, rest.high - first.high) / range), breakDown: r3(Math.max(0, first.low - rest.low) / range),
    closeInsideFirst: close <= first.high && close >= first.low,
    line: c30.map((c) => r1(c.close)),
  };
}

const pts = (n: number) => Math.round(Math.abs(n)).toLocaleString('en-US');
const share = (n: number) => `${Math.round(n * 100)}%`;
const pc = (n: number) => `${(Math.abs(n) * 100).toFixed(2)}%`;

/** The day's name, and one sentence of why with its own numbers in it. */
export function classify(s: DayStats): { key: PatternKey; why: string } {
  const R = RULES;
  const up = s.netPts >= 0;
  const way = up ? 'up' : 'down';
  const t = s.thirds;
  const rangeWords = `${pts(s.rangePts)}-pt range`;

  if (s.earlyRangeShare <= R.compressRange && Math.abs(s.closeBeyondEarly) >= R.compressClose) {
    return { key: 'COMPRESSION_BREAKOUT', why: `The first ${share(R.compressEarly)} of the day stayed inside ${share(s.earlyRangeShare)} of the ${rangeWords}; it then broke ${s.closeBeyondEarly > 0 ? 'up' : 'down'} and closed ${pts(Math.abs(s.closeBeyondEarly) * s.rangePts)} pts outside it.` };
  }
  if (s.bigCandle.pctOfPrice >= R.spikeCandlePct && s.bigCandle.shareOfRange >= R.spikeShare) {
    return { key: 'VOLATILITY_SPIKE', why: `One 15-minute candle moved ${pts(s.bigCandle.pts)} pts ${s.bigCandle.up ? 'up' : 'down'} (${pc(s.bigCandle.pctOfPrice)} of the price) — ${share(s.bigCandle.shareOfRange)} of the day's ${rangeWords}, ${s.candleExpansion.toFixed(1)}× a usual candle.` };
  }

  if (s.dirShare >= R.trendShare && Math.abs(s.netPct) >= R.trendNetPct) {
    const run = up ? s.upPts : s.downPts;
    const back = up ? s.high - s.close : s.close - s.low;
    const backShare = run > 0 ? back / run : 0;
    const extremePos = up ? s.highPos : s.lowPos;
    const closed = `Closed ${pts(s.netPts)} pts ${way} (${pc(s.netPct)}), ${share(s.dirShare)} of the ${rangeWords}`;
    if (backShare >= R.exhaustFrom && backShare <= R.exhaustTo && extremePos <= R.exhaustBy) {
      return { key: 'TREND_EXHAUSTION', why: `Ran ${pts(run)} pts ${way} from the open, then gave ${share(backShare)} of it back before the close: the ${way}trend lost strength.` };
    }
    const sign = up ? 1 : -1;
    if (t[2]!.rangeShare <= R.pauseRange && Math.abs(t[2]!.netPts) / s.rangePts <= R.pauseNet) {
      return { key: up ? 'UPTREND_RANGE' : 'DOWNTREND_RANGE', why: `${closed}; the move was made early and the last third of the day stayed inside ${share(t[2]!.rangeShare)} of the range.` };
    }
    if (Math.abs(t[1]!.netPts) / s.rangePts <= R.breakMidNet && t[1]!.rangeShare <= R.breakMidRange
      && sign * t[2]!.netPts / s.rangePts >= R.breakLeg && sign * t[0]!.netPts / s.rangePts >= R.breakFirst) {
      return { key: up ? 'UPTREND_BREAKOUT' : 'DOWNTREND_BREAKDOWN', why: `${closed}: ${pts(t[0]!.netPts)} pts ${way} early, a pause in the middle of the day, then ${pts(t[2]!.netPts)} pts more the same way.` };
    }
    const pull = `largest move against it ${share(s.counterShare)} of the range, path ${s.pathRatio.toFixed(1)}× the range`;
    if (s.counterShare >= R.highCounter || s.pathRatio >= R.highPath) return { key: up ? 'UP_TREND_HIGH_ZIGZAG' : 'DOWN_TREND_HIGH_ZIGZAG', why: `${closed}, with large swings on the way: ${pull}.` };
    if (s.counterShare <= R.cleanCounter && s.pathRatio <= R.cleanPath) return { key: up ? 'UP_TREND_CLEAN' : 'DOWN_TREND_CLEAN', why: `${closed}, smoothly: ${pull}.` };
    return { key: up ? 'UP_TREND_ZIGZAG' : 'DOWN_TREND_ZIGZAG', why: `${closed}, with ${up ? 'pullbacks' : 'bounces'}: ${pull}.` };
  }

  const flat = `Closed ${pts(s.netPts)} pts ${way} of the open inside a ${rangeWords} (${pc(s.rangePct)})`;
  if (s.atrPercentile !== null ? s.atrPercentile <= R.lowVolPercentile : s.rangePct < R.lowVolRangePct) {
    return { key: 'RANGE_LOW_VOLATILITY', why: `${flat}; ATR ${pts(s.atr)} pts${s.atrPercentile === null ? '' : s.atrPercentile === 0 ? ', the lowest of the days before' : `, lower than ${100 - s.atrPercentile}% of the days before`}.` };
  }
  const downOut = s.downPts >= s.upPts;
  const out = downOut ? s.downPts : s.upPts;
  const backOf = downOut ? s.close - s.low : s.high - s.close;
  const turnPos = downOut ? s.lowPos : s.highPos;
  if (s.rangePct >= R.reversalRangePct && out / s.rangePts >= R.reversalOut && out > 0 && backOf / out >= R.reversalBack && turnPos >= R.reversalFrom && turnPos <= R.reversalTo) {
    return { key: 'REVERSAL_ZIGZAG', why: `Went ${pts(out)} pts ${downOut ? 'down' : 'up'} from the open, turned, and took ${pts(backOf)} pts of it back: a reversal inside a ${rangeWords}.` };
  }
  if ((s.breakUp >= R.falseBreak || s.breakDown >= R.falseBreak) && s.closeInsideFirst) {
    const upBreak = s.breakUp >= s.breakDown;
    return { key: 'FALSE_BREAKOUT_RANGE', why: `Broke ${upBreak ? 'above' : 'below'} the early range by ${pts((upBreak ? s.breakUp : s.breakDown) * s.rangePts)} pts and closed back inside it: the breakout failed.` };
  }
  const walked = `${s.zigzag.swings} swings, path ${s.pathRatio.toFixed(1)}× the range`;
  if (s.rangePct >= R.wideRangePct) return { key: 'RANGE_WIDE_ZIGZAG', why: `${flat}: a wide range with ${walked}.` };
  if (s.pathRatio >= R.choppyPath) return { key: 'SIDEWAYS_CHOPPY', why: `${flat}, noisy and without direction: ${walked}.` };
  if (s.pathRatio >= R.zigzagPath) return { key: 'RANGE_ZIGZAG', why: `${flat}, swinging inside it: ${walked}.` };
  return { key: 'RANGE_CLEAN', why: `${flat}, quietly: ${walked}.` };
}
