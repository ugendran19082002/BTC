import type {
  Bar, CandleTag, Confirmation, DealingRange, Dir, Pool, PoolEvent, Session, SessionRange, Setup, SetupState,
  SmcOptions, SmcState, StructureBreak, Swing, Target, Zone, ZoneEvent,
} from './types';

/**
 * A price-action / SMC engine that reads the market one closed candle at a time.
 *
 * `push(bar)` is the only way in, and it sees nothing but the candles pushed
 * before it -- so no rule below *can* read the future, however it is written.
 * Every object it records says where it belongs (`at`) and which candle's close
 * made it knowable (`known`); later changes are appended as events and nothing
 * already recorded is edited. `engine.test.ts` replays every prefix of a series
 * and checks that the history at candle k is identical whether the engine
 * stopped at k or ran to the end.
 *
 * The rules are deliberately plain and each is one function: a fractal swing,
 * a close through it, the last opposite candle before the move, a three-candle
 * gap, a wick through resting liquidity that closes back. They describe what
 * happened; whether any of it pays is the setup record's job (`setups`), which
 * is kept for exactly that reason.
 */

const DAY = 86_400;
const WEEK_OFFSET_DAYS = 3; // 1970-01-01 was a Thursday; +3 makes weeks start on Monday

/** Session by the candle's UTC open time. Asia 00-07, London 07-12, New York 12-20; 20-24 is none. */
export function sessionOf(unixSec: number): Session | null {
  const h = (((unixSec % DAY) + DAY) % DAY) / 3600;
  if (h < 7) return 'Asia';
  if (h < 12) return 'London';
  if (h < 20) return 'New York';
  return null;
}

const dayOf = (t: number) => Math.floor(t / DAY);
const weekOf = (t: number) => Math.floor((t / DAY + WEEK_OFFSET_DAYS) / 7);
const monthOf = (t: number) => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

/** Candles after which resting liquidity and zones leave play (about a week of 5m candles). */
const RETIRE_BARS = 2000;
/** How long a setup may wait at each stage, in bars. */
const FORMING_BARS = 24;
const READY_BARS = 30;
const ACTIVE_BARS = 96;
/** The share of the position closed at TP1, TP2 and TP3. */
export const SCALE_OUT = [0.3, 0.3, 0.4] as const;
/** The least the nearest target may pay for the risk: below this there is no trade. */
export const MIN_TP1_R = 1.5;
/** The stop's buffer beyond structure: a fraction of the ATR, never less than a point. */
const stopBuffer = (atr: number) => Math.max(1, 0.15 * atr);

type Extreme = { high: number; low: number; highAt: number; lowAt: number };

export class SmcEngine {
  private readonly o: Required<Omit<SmcOptions, 'htfTrendAt' | 'sessions'>> & Pick<SmcOptions, 'htfTrendAt' | 'sessions'>;
  private readonly b: Bar[] = [];
  private readonly atrs: number[] = [];
  private atr = 0;

  private trend: Dir | null = null;
  private refHigh: Swing | null = null;
  private refLow: Swing | null = null;
  private lastHigh: Swing | null = null;
  private lastLow: Swing | null = null;

  private readonly swings: Swing[] = [];
  private readonly breaks: StructureBreak[] = [];
  private readonly zones: Zone[] = [];
  private readonly zoneEvents: ZoneEvent[] = [];
  private readonly pools: Pool[] = [];
  private readonly poolEvents: PoolEvent[] = [];
  private readonly sessions: SessionRange[] = [];
  private readonly tags: CandleTag[] = [];
  private readonly vwap: (number | null)[] = [];
  private readonly dayOpen: (number | null)[] = [];
  private readonly setups: Setup[] = [];

  /** Zones and pools still in play, with what has already happened to each. */
  private readonly liveZones = new Map<string, { zone: Zone; touched: boolean; filled: boolean }>();
  private readonly livePools = new Map<string, Pool>();
  private readonly zoneIds = new Set<string>();
  private long: Setup | null = null;
  private short: Setup | null = null;

  private day: { key: number; ext: Extreme; open: number; pv: number; v: number } | null = null;
  private week: { key: number; ext: Extreme } | null = null;
  private month: { key: number; ext: Extreme } | null = null;
  private session: { name: Session; day: number; from: number; ext: Extreme } | null = null;

  constructor(opts: SmcOptions) {
    this.o = { pivotLeft: 2, pivotRight: 2, stopAt: 'zone', minStopAtr: 0, entry: 'close', continuation: false, tp1: 'nearest', minTp1R: MIN_TP1_R, ...opts };
  }

  /** Feed the next closed candle. Candles must arrive in time order. */
  push(bar: Bar): void {
    const i = this.b.length;
    const prev = this.b[i - 1];
    if (prev && bar.time <= prev.time) throw new Error(`bars out of order at ${bar.time}`);
    this.b.push(bar);
    this.updateAtr(bar, prev);

    this.calendar(i);
    this.poolReactions(i);
    this.zoneReactions(i);
    this.confirmSwing(i);
    this.structure(i);
    this.gaps(i);
    this.candleTags(i);
    this.advanceSetups(i);
    if (i % 250 === 0) this.retire(i);
  }

  state(): SmcState {
    return {
      bars: this.b.length,
      atr: this.atr,
      trend: this.trend,
      swings: [...this.swings],
      breaks: [...this.breaks],
      zones: [...this.zones],
      zoneEvents: [...this.zoneEvents],
      pools: [...this.pools],
      poolEvents: [...this.poolEvents],
      sessions: [...this.sessions],
      tags: [...this.tags],
      vwap: [...this.vwap],
      dayOpen: [...this.dayOpen],
      setups: this.setups.map((s) => ({ ...s, confirmations: s.confirmations.map((c) => ({ ...c })), targets: [...s.targets], events: [...s.events] })),
      range: this.dealingRange(),
    };
  }

  /**
   * Liquidity and zones older than `RETIRE_BARS` are dropped from play: a
   * week-old 5-minute swing is not intraday liquidity, and keeping every one
   * ever made would make each candle slower than the last. Their records stay
   * in the history; only the live sets are pruned. Decided by bar index alone,
   * so it cannot depend on anything after the candle.
   */
  private retire(i: number) {
    for (const [id, p] of this.livePools) if (p.known < i - RETIRE_BARS) this.livePools.delete(id);
    for (const [id, z] of this.liveZones) if (z.zone.known < i - RETIRE_BARS) this.liveZones.delete(id);
  }

  // ---------------------------------------------------------------- volatility

  /** Wilder's ATR(14); a simple mean of what there is until fourteen true ranges exist. */
  private updateAtr(bar: Bar, prev: Bar | undefined) {
    const tr = prev
      ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close))
      : bar.high - bar.low;
    const n = this.atrs.length;
    this.atr = n < 14 ? (this.atr * n + tr) / (n + 1) : (this.atr * 13 + tr) / 14;
    this.atrs.push(this.atr);
  }

  private tol(i: number) {
    return Math.max((this.atrs[i] ?? 0) * 0.1, (this.b[i]?.close ?? 0) * 0.00005);
  }

  // ---------------------------------------------------------------- calendar

  /** Day / week / month references, session ranges, VWAP and the day open. */
  private calendar(i: number) {
    const bar = this.b[i]!;
    const d = dayOf(bar.time);

    if (this.day && this.day.key !== d) {
      this.addLevel('PDH', 'buy', this.day.ext.high, this.day.ext.highAt, i);
      this.addLevel('PDL', 'sell', this.day.ext.low, this.day.ext.lowAt, i);
    }
    if (!this.day || this.day.key !== d) this.day = { key: d, ext: ext(bar, i), open: bar.open, pv: 0, v: 0 };
    else grow(this.day.ext, bar, i);
    const tp = (bar.high + bar.low + bar.close) / 3;
    this.day.pv += tp * bar.volume;
    this.day.v += bar.volume;
    this.vwap.push(this.day.v > 0 ? this.day.pv / this.day.v : null);
    this.dayOpen.push(this.day.open);

    const w = weekOf(bar.time);
    if (this.week && this.week.key !== w) {
      this.addLevel('PWH', 'buy', this.week.ext.high, this.week.ext.highAt, i);
      this.addLevel('PWL', 'sell', this.week.ext.low, this.week.ext.lowAt, i);
    }
    if (!this.week || this.week.key !== w) this.week = { key: w, ext: ext(bar, i) };
    else grow(this.week.ext, bar, i);

    const m = monthOf(bar.time);
    if (this.month && this.month.key !== m) {
      this.addLevel('PMH', 'buy', this.month.ext.high, this.month.ext.highAt, i);
      this.addLevel('PML', 'sell', this.month.ext.low, this.month.ext.lowAt, i);
    }
    if (!this.month || this.month.key !== m) this.month = { key: m, ext: ext(bar, i) };
    else grow(this.month.ext, bar, i);

    const s = sessionOf(bar.time);
    if (this.session && (this.session.name !== s || this.session.day !== d)) {
      const done = this.session;
      this.sessions.push({ session: done.name, day: done.day, from: done.from, to: i - 1, high: done.ext.high, low: done.ext.low, known: i });
      // The Asian and London ranges are the liquidity the next session reaches for.
      if (done.name === 'Asia') {
        this.addLevel('ASH', 'buy', done.ext.high, done.ext.highAt, i);
        this.addLevel('ASL', 'sell', done.ext.low, done.ext.lowAt, i);
      } else if (done.name === 'London') {
        this.addLevel('LSH', 'buy', done.ext.high, done.ext.highAt, i);
        this.addLevel('LSL', 'sell', done.ext.low, done.ext.lowAt, i);
      }
      this.session = null;
    }
    if (s) {
      if (!this.session) this.session = { name: s, day: d, from: i, ext: ext(bar, i) };
      else grow(this.session.ext, bar, i);
    }
  }

  private addLevel(kind: Pool['kind'], side: Pool['side'], price: number, at: number, known: number) {
    const pool: Pool = { id: `${kind}-${this.b[at]!.time}`, kind, side, price, at, known };
    this.pools.push(pool);
    this.livePools.set(pool.id, pool);
  }

  // ---------------------------------------------------------------- liquidity

  /** A wick through resting liquidity that closes back is a sweep; a close through takes it. */
  private poolReactions(i: number) {
    const bar = this.b[i]!;
    const session = sessionOf(bar.time);
    for (const pool of [...this.livePools.values()]) {
      if (pool.known >= i) continue;
      const through = pool.side === 'buy' ? bar.high > pool.price : bar.low < pool.price;
      if (!through) continue;
      const closedThrough = pool.side === 'buy' ? bar.close > pool.price : bar.close < pool.price;
      const ev: PoolEvent = { pool: pool.id, type: closedThrough ? 'taken' : 'swept', at: i, known: i, session };
      this.poolEvents.push(ev);
      this.livePools.delete(pool.id);
      if (ev.type === 'swept') this.onSweep(pool, i);
    }
  }

  // ---------------------------------------------------------------- swings

  /**
   * A fractal swing: higher than `pivotLeft` candles before it and not exceeded
   * by `pivotRight` after. Known only once those right-hand candles have
   * closed, so a swing is never drawn before it could have been seen.
   */
  private confirmSwing(i: number) {
    const L = this.o.pivotLeft;
    const R = this.o.pivotRight;
    const j = i - R;
    if (j < L) return;
    const c = this.b[j]!;
    let isHigh = true;
    let isLow = true;
    for (let k = j - L; k <= i; k++) {
      if (k === j) continue;
      const o = this.b[k]!;
      if (k < j ? o.high >= c.high : o.high > c.high) isHigh = false;
      if (k < j ? o.low <= c.low : o.low < c.low) isLow = false;
    }
    const tol = this.tol(i);
    if (isHigh) {
      const prev = this.lastHigh;
      const label = !prev ? null : Math.abs(c.high - prev.price) <= tol ? 'EQH' : c.high > prev.price ? 'HH' : 'LH';
      const s: Swing = { id: `sh-${c.time}`, side: 'high', at: j, known: i, price: c.high, label };
      this.swings.push(s);
      this.lastHigh = s;
      this.refHigh = s;
      this.addSwingPool(s, tol, i);
    }
    if (isLow) {
      const prev = this.lastLow;
      const label = !prev ? null : Math.abs(c.low - prev.price) <= tol ? 'EQL' : c.low < prev.price ? 'LL' : 'HL';
      const s: Swing = { id: `sl-${c.time}`, side: 'low', at: j, known: i, price: c.low, label };
      this.swings.push(s);
      this.lastLow = s;
      this.refLow = s;
      this.addSwingPool(s, tol, i);
    }
  }

  /** Every swing is resting liquidity; two within tolerance become one equal-highs / equal-lows pool. */
  private addSwingPool(s: Swing, tol: number, i: number) {
    const buy = s.side === 'high';
    const twin = [...this.livePools.values()].find((p) =>
      (buy ? p.kind === 'BSL' || p.kind === 'EQH' : p.kind === 'SSL' || p.kind === 'EQL') && Math.abs(p.price - s.price) <= tol);
    if (twin) {
      this.poolEvents.push({ pool: twin.id, type: 'merged', at: i, known: i, session: null });
      this.livePools.delete(twin.id);
      const pool: Pool = {
        id: `${buy ? 'EQH' : 'EQL'}-${this.b[s.at]!.time}`, side: buy ? 'buy' : 'sell', kind: buy ? 'EQH' : 'EQL',
        price: buy ? Math.max(twin.price, s.price) : Math.min(twin.price, s.price), at: twin.at, known: i,
      };
      this.pools.push(pool);
      this.livePools.set(pool.id, pool);
      return;
    }
    const pool: Pool = { id: `${buy ? 'BSL' : 'SSL'}-${this.b[s.at]!.time}`, side: buy ? 'buy' : 'sell', kind: buy ? 'BSL' : 'SSL', price: s.price, at: s.at, known: i };
    this.pools.push(pool);
    this.livePools.set(pool.id, pool);
  }

  // ---------------------------------------------------------------- structure

  /** A close through the reference swing. With the trend it is a BOS, against it a CHoCH. */
  private structure(i: number) {
    const bar = this.b[i]!;
    if (this.refHigh && bar.close > this.refHigh.price) {
      this.onBreak('bull', this.refHigh, i);
      this.refHigh = null;
    }
    if (this.refLow && bar.close < this.refLow.price) {
      this.onBreak('bear', this.refLow, i);
      this.refLow = null;
    }
  }

  private onBreak(dir: Dir, swing: Swing, i: number) {
    const kind = this.trend !== null && this.trend !== dir ? 'CHoCH' : 'BOS';
    const brk: StructureBreak = {
      id: `${kind}-${dir}-${this.b[i]!.time}`, dir, kind, mss: kind === 'CHoCH' && this.isDisplacement(i),
      level: swing.price, from: swing.at, at: i, known: i,
    };
    this.breaks.push(brk);
    this.trend = dir;
    const ob = this.orderBlock(dir, swing.at, i, brk.id);
    this.onStructure(brk, ob, i);
    if (this.o.continuation && kind === 'BOS') this.onContinuation(brk, ob, swing, i);
  }

  /**
   * The order block behind a break: the last opposite-coloured candle before
   * the leg that broke structure, looked for from the leg's origin (the
   * extreme since the broken swing) back up to four candles.
   */
  private orderBlock(dir: Dir, from: number, i: number, source: string): Zone | null {
    let m = from + 1;
    for (let k = from + 1; k <= i; k++) {
      const b = this.b[k]!;
      if (dir === 'bull' ? b.low < this.b[m]!.low : b.high > this.b[m]!.high) m = k;
    }
    let pick = -1;
    for (let k = m; k >= Math.max(from + 1, m - 4); k--) {
      const b = this.b[k]!;
      if (dir === 'bull' ? b.close < b.open : b.close > b.open) { pick = k; break; }
    }
    if (pick < 0) pick = m;
    const c = this.b[pick]!;
    if (c.high <= c.low) return null;
    const id = `OB-${dir}-${c.time}`;
    if (this.zoneIds.has(id)) return null;
    const zone: Zone = { id, kind: 'OB', dir, low: c.low, high: c.high, at: pick, known: i, source };
    this.zones.push(zone);
    this.zoneIds.add(id);
    this.liveZones.set(id, { zone, touched: false, filled: false });
    return zone;
  }

  /** A three-candle gap: the first candle's high below the third's low (bullish), or the reverse. */
  private gaps(i: number) {
    if (i < 2) return;
    const a = this.b[i - 2]!;
    const c = this.b[i]!;
    const min = (this.atrs[i] ?? 0) * 0.05;
    let zone: Zone | null = null;
    if (c.low - a.high > min) zone = { id: `FVG-bull-${this.b[i - 1]!.time}`, kind: 'FVG', dir: 'bull', low: a.high, high: c.low, at: i - 1, known: i, source: 'gap' };
    else if (a.low - c.high > min) zone = { id: `FVG-bear-${this.b[i - 1]!.time}`, kind: 'FVG', dir: 'bear', low: c.high, high: a.low, at: i - 1, known: i, source: 'gap' };
    if (!zone) return;
    this.zones.push(zone);
    this.zoneIds.add(zone.id);
    this.liveZones.set(zone.id, { zone, touched: false, filled: false });
  }

  /** First retest, a full fill (gaps), and a close through: the OB is then a breaker, the gap an inverse FVG. */
  private zoneReactions(i: number) {
    const bar = this.b[i]!;
    for (const live of [...this.liveZones.values()]) {
      const z = live.zone;
      if (z.known >= i) continue;
      const bull = z.dir === 'bull';
      const broken = bull ? bar.close < z.low : bar.close > z.high;
      if (!live.touched && (bull ? bar.low <= z.high : bar.high >= z.low)) {
        live.touched = true;
        this.zoneEvents.push({ zone: z.id, type: 'touched', at: i, known: i });
      }
      if (z.kind === 'FVG' && !live.filled && !broken && (bull ? bar.low <= z.low : bar.high >= z.high)) {
        live.filled = true;
        this.zoneEvents.push({ zone: z.id, type: 'filled', at: i, known: i });
      }
      if (broken) {
        this.zoneEvents.push({ zone: z.id, type: 'broken', at: i, known: i });
        this.liveZones.delete(z.id);
      }
    }
  }

  // ---------------------------------------------------------------- candles

  private isDisplacement(i: number) {
    const b = this.b[i]!;
    const atr = this.atrs[i - 1] ?? this.atrs[i] ?? 0;
    const body = Math.abs(b.close - b.open);
    return atr > 0 && body >= 1.5 * atr && body >= 0.6 * (b.high - b.low);
  }

  private candleTags(i: number) {
    const b = this.b[i]!;
    const p = this.b[i - 1];
    const atr = this.atrs[i - 1] ?? this.atrs[i] ?? 0;
    const body = Math.abs(b.close - b.open);
    const range = b.high - b.low;
    const up = b.close > b.open;
    const tag = (name: CandleTag['name'], dir: Dir | null) => this.tags.push({ at: i, known: i, name, dir });

    if (this.isDisplacement(i)) tag('Displacement', up ? 'bull' : 'bear');
    if (p) {
      const pUp = p.close > p.open;
      const pLo = Math.min(p.open, p.close);
      const pHi = Math.max(p.open, p.close);
      if (up !== pUp && body >= 0.5 * atr && Math.min(b.open, b.close) <= pLo && Math.max(b.open, b.close) >= pHi && Math.abs(p.close - p.open) > 0) {
        tag(up ? 'Bull engulfing' : 'Bear engulfing', up ? 'bull' : 'bear');
      } else if (b.high <= p.high && b.low >= p.low) tag('Inside bar', null);
    }
    const upper = b.high - Math.max(b.open, b.close);
    const lower = Math.min(b.open, b.close) - b.low;
    if (range >= 0.8 * atr && Math.max(upper, lower) >= 2 * body && Math.max(upper, lower) >= 0.6 * range) tag('Pin bar', lower > upper ? 'bull' : 'bear');
    else if (range >= 0.3 * atr && body <= 0.1 * range) tag('Doji', null);

    if (i >= 20) {
      let sum = 0;
      for (let k = i - 20; k < i; k++) sum += this.b[k]!.volume;
      const mean = sum / 20;
      if (mean > 0 && b.volume >= 2 * mean) tag('Volume spike', up ? 'bull' : 'bear');
      else if (mean > 0 && b.volume <= 0.35 * mean) tag('Volume dry-up', null);
    }
  }

  // ---------------------------------------------------------------- setups

  /**
   * The sequence a setup has to complete, long side (short mirrors it). No
   * single event is an entry -- not the sweep, not the break, not the zone:
   *
   *   1. sell-side liquidity swept                      FORMING
   *   2. bullish CHoCH / BOS
   *   3. displacement in that move -- a displacement     (else keep waiting)
   *      candle, or the FVG such a move leaves
   *   4. an OB or FVG left by the move                   READY: plan fixed
   *   5. price comes back into it (the retest)
   *   6. a candle closes back above it, bullish          ACTIVE at that close
   *
   * The plan, fixed at READY and never moved:
   *   stop    beyond the POI's distal edge (the level whose loss says the
   *           zone failed), plus max(1, 0.15 ATR); wider than 4 ATR is no trade.
   *   TP1     the nearest internal liquidity (swing, EQH / EQL, session high / low)
   *   TP2     the next external liquidity (previous day / week / month)
   *   TP3     the opposing OB, or the next level out
   *   filter  TP1 must pay at least 1.5R, from the plan and again at the fill.
   *
   * In the trade: 30% off at TP1, 30% at TP2, 40% at TP3. The stop goes to
   * break-even only after TP1 *and* a new higher low (lower high) confirms;
   * after TP2 it trails under each confirmed swing. It only ever tightens,
   * and every move is recorded in `trail`.
   */
  /** Whether a setup may start on this candle: always, unless the options name the sessions. */
  private inSession(i: number) {
    const allowed = this.o.sessions;
    if (!allowed) return true;
    const s = sessionOf(this.b[i]!.time);
    return s !== null && allowed.includes(s);
  }

  private onSweep(pool: Pool, i: number) {
    if (!this.inSession(i)) return;
    const dir: Dir = pool.side === 'sell' ? 'bull' : 'bear';
    const slot = dir === 'bull' ? this.long : this.short;
    if (slot && slot.state !== 'FORMING') return; // a plan already made is not replaced by a newer sweep
    if (slot) this.finish(slot, 'INVALIDATED', i, null, 'superseded by a newer sweep');
    const bar = this.b[i]!;
    const bull = dir === 'bull';
    const s: Setup = {
      id: `${bull ? 'L' : 'S'}-${bar.time}`,
      dir,
      createdAt: i,
      state: 'FORMING',
      confirmations: [
        { name: `${bull ? 'SSL' : 'BSL'} swept (${pool.kind})`, ok: true, at: i },
        { name: `${bull ? 'Bullish' : 'Bearish'} CHoCH / BOS`, ok: false, at: null },
        { name: 'Displacement', ok: false, at: null },
        { name: 'OB / FVG from the move', ok: false, at: null },
        { name: 'Retest', ok: false, at: null },
        { name: 'Close confirms', ok: false, at: null },
      ],
      poi: null, entry: null, stop: null, targets: [], risk: null, fill: null, htf: null,
      events: [{ state: 'FORMING', at: i, known: i, price: bull ? bar.low : bar.high, note: `${pool.kind} ${Math.round(pool.price)} swept` }],
      trail: [], mfeR: null, maeR: null, resultR: null, closedAt: null,
    };
    this.setups.push(s);
    if (bull) this.long = s; else this.short = s;
  }

  private onStructure(brk: StructureBreak, ob: Zone | null, i: number) {
    const s = brk.dir === 'bull' ? this.long : this.short;
    if (!s || s.state !== 'FORMING' || s.createdAt >= i) return;
    s.confirmations[1] = { ...s.confirmations[1]!, ok: true, at: i };
    this.plan(s, brk, ob, s.createdAt, s.events[0]!.price, i);
  }

  /**
   * Continuation (research option): a with-trend BOS made with displacement is
   * itself the setup -- the retrace into the zone it left is the entry. It
   * never replaces a setup already running on that side.
   */
  private onContinuation(brk: StructureBreak, ob: Zone | null, swing: Swing, i: number) {
    if (!this.inSession(i)) return;
    const bull = brk.dir === 'bull';
    if (bull ? this.long : this.short) return;
    const s: Setup = {
      id: `${bull ? 'CL' : 'CS'}-${this.b[i]!.time}`, dir: brk.dir, createdAt: i, state: 'FORMING',
      confirmations: [
        { name: 'With the trend (continuation)', ok: true, at: i },
        { name: `${bull ? 'Bullish' : 'Bearish'} BOS`, ok: true, at: i },
        { name: 'Displacement', ok: false, at: null },
        { name: 'OB / FVG from the move', ok: false, at: null },
        { name: 'Retest', ok: false, at: null },
        { name: 'Close confirms', ok: false, at: null },
      ],
      poi: null, entry: null, stop: null, targets: [], risk: null, fill: null, htf: null,
      events: [{ state: 'FORMING', at: i, known: i, price: null, note: `${bull ? 'bullish' : 'bearish'} BOS ${Math.round(brk.level)} with the trend` }],
      trail: [], mfeR: null, maeR: null, resultR: null, closedAt: null,
    };
    this.setups.push(s);
    if (bull) this.long = s; else this.short = s;
    this.plan(s, brk, ob, swing.at, null, i);
    if (s.state === 'FORMING') this.finish(s, 'INVALIDATED', i, null, 'BOS without displacement');
  }

  /** Displacement, a POI, the stop, the targets and the R filter: shared by both kinds of setup. */
  private plan(s: Setup, brk: StructureBreak, ob: Zone | null, since: number, sweepPrice: number | null, i: number) {
    const ok = (k: number) => { s.confirmations[k] = { ...s.confirmations[k]!, ok: true, at: i }; };
    /*
     * The move must have been made with intent. Displacement is a move strong
     * enough to leave an imbalance: a displacement candle, or the fair value
     * gap such a move leaves, since the sweep (or the broken swing).
     */
    const disp = someSince(this.tags, since, (t) => t.name === 'Displacement' && t.dir === brk.dir)
      || someSince(this.zones, since, (z) => z.kind === 'FVG' && z.dir === brk.dir);
    if (!disp) return; // a break without displacement is not enough; a later break may still qualify
    ok(2);
    const fvg = [...this.liveZones.values()].map((l) => l.zone).reverse()
      .find((z) => z.kind === 'FVG' && z.dir === brk.dir && z.known > since && z.known <= i);
    const poi = ob ?? fvg ?? null;
    if (!poi) { this.finish(s, 'INVALIDATED', i, null, `${brk.kind} left no OB or FVG to enter from`); return; }
    ok(3);

    const bull = brk.dir === 'bull';
    const atr = this.atrs[i] ?? 0;
    const buf = stopBuffer(atr);
    const entry = bull ? poi.high : poi.low;
    // The stop: beyond the POI's distal edge -- the level whose loss says the zone failed -- plus the buffer.
    let stop = bull ? poi.low - buf : poi.high + buf;
    if (this.o.stopAt === 'sweep' && sweepPrice !== null) stop = bull ? Math.min(stop, sweepPrice - buf) : Math.max(stop, sweepPrice + buf);
    const floor = this.o.minStopAtr * atr;
    if (floor > 0) stop = bull ? Math.min(stop, entry - floor) : Math.max(stop, entry + floor);
    const risk = bull ? entry - stop : stop - entry;
    if (!(risk > 0) || risk > 4 * atr) { this.finish(s, 'INVALIDATED', i, null, 'stop wider than four ATR'); return; }
    const targets = this.targetsFor(brk.dir, entry, risk, i);
    if (!targets) { this.finish(s, 'INVALIDATED', i, null, 'no liquidity to aim at'); return; }
    if (targets[0]!.rr < this.o.minTp1R) {
      this.finish(s, 'INVALIDATED', i, null, `TP1 ${targets[0]!.label} pays ${targets[0]!.rr.toFixed(1)}R, under ${this.o.minTp1R}R`);
      return;
    }

    s.poi = poi;
    s.entry = entry;
    s.stop = stop;
    s.risk = risk;
    s.targets = targets;
    s.htf = this.o.htfTrendAt?.(this.b[i]!.time + this.o.tfSec) ?? null;
    s.state = 'READY';
    s.events.push({ state: 'READY', at: i, known: i, price: entry, note: `${brk.mss ? 'MSS' : brk.kind} ${Math.round(brk.level)}; POI ${poi.kind} ${Math.round(poi.low)}–${Math.round(poi.high)}` });

    // The momentum entry, for 'hybrid': only when the move was a displacement candle
    // (not merely a gap) and the higher timeframe's trend, as known now, agrees.
    const momentum = this.o.entry === 'break' || (this.o.entry === 'hybrid'
      && someSince(this.tags, since, (t) => t.name === 'Displacement' && t.dir === brk.dir)
      && (this.o.htfTrendAt?.(this.b[i]!.time + this.o.tfSec) ?? null) === brk.dir);
    if (momentum) {
      // Momentum entry: at the close of the break itself, no retest. Same stop and targets.
      const close = this.b[i]!.close;
      const fillRisk = bull ? close - stop : stop - close;
      const rr1 = (bull ? targets[0]!.price - close : close - targets[0]!.price) / fillRisk;
      if (!(fillRisk > 0) || rr1 <= 0 || rr1 < this.o.minTp1R) { this.finish(s, 'INVALIDATED', i, close, `break entry: TP1 ${rr1.toFixed(1)}R at the close`); return; }
      ok(4);
      ok(5);
      s.fill = { at: i, price: close, risk: fillRisk };
      s.state = 'ACTIVE';
      s.events.push({ state: 'ACTIVE', at: i, known: i, price: close, note: 'entered at the close of the break' });
      s.mfeR = 0;
      s.maeR = 0;
    }
  }

  /**
   * TP1 the nearest internal liquidity, TP2 the next external level, TP3 the
   * opposing zone -- each with the reason it is there. A tier with nothing in
   * it borrows from the next; R multiples only when the chart has no level
   * left. Null when there is no liquidity at all for TP1: a target needs a
   * reason.
   */
  private targetsFor(dir: Dir, entry: number, risk: number, i: number): Target[] | null {
    const bull = dir === 'bull';
    const atr = this.atrs[i] ?? 0;
    const dist = (p: number) => (bull ? p - entry : entry - p);
    const INTERNAL: readonly Pool['kind'][] = ['BSL', 'SSL', 'EQH', 'EQL', 'ASH', 'ASL', 'LSH', 'LSL'];
    const REASON: Record<string, string> = {
      BSL: 'swing high liquidity', SSL: 'swing low liquidity', EQH: 'equal highs', EQL: 'equal lows',
      ASH: 'Asia high', ASL: 'Asia low', LSH: 'London high', LSL: 'London low',
      PDH: 'previous day high', PDL: 'previous day low', PWH: 'previous week high', PWL: 'previous week low',
      PMH: 'previous month high', PML: 'previous month low',
    };
    type C = { price: number; label: string; source: Target['source']; reason: string };
    const pools: C[] = [];
    for (const p of this.livePools.values()) {
      if (p.known > i || p.side !== (bull ? 'buy' : 'sell') || dist(p.price) <= 0) continue;
      const internal = INTERNAL.includes(p.kind);
      pools.push({ price: p.price, label: p.kind, source: internal ? 'internal' : 'external', reason: REASON[p.kind] ?? p.kind });
    }
    // The opposing zone: a supply OB above a long (demand below a short), aimed at its near edge.
    for (const { zone: z } of this.liveZones.values()) {
      if (z.kind !== 'OB' || z.known > i || z.dir === dir) continue;
      const near = bull ? z.low : z.high;
      if (dist(near) > 0) pools.push({ price: near, label: bull ? 'Supply OB' : 'Demand OB', source: 'zone', reason: bull ? 'opposing supply' : 'opposing demand' });
    }
    const nearest = (xs: C[], beyond: number) => xs.filter((c) => dist(c.price) > beyond + 0.2 * atr).sort((a, b) => dist(a.price) - dist(b.price))[0] ?? null;
    const of = (src: Target['source']) => pools.filter((c) => c.source === src);

    // 'first-over-min' passes over levels that would pay less than the minimum.
    const floor = this.o.tp1 === 'first-over-min' ? this.o.minTp1R * risk : 0;
    const tp1 = nearest(of('internal'), floor) ?? nearest(pools, floor);
    if (!tp1) return null;
    const tp2 = nearest(of('external'), dist(tp1.price)) ?? nearest(pools, dist(tp1.price));
    const tp3 = tp2 ? nearest(of('zone'), dist(tp2.price)) ?? nearest(pools, dist(tp2.price)) : null;
    const out: Target[] = [];
    for (const c of [tp1, tp2, tp3]) if (c) out.push({ ...c, rr: dist(c.price) / risk });
    let r = Math.max(out.length + 1, Math.ceil(out[out.length - 1]!.rr) + 1);
    while (out.length < 3) {
      out.push({ price: bull ? entry + r * risk : entry - r * risk, label: `${r}R`, source: 'R-multiple', rr: r, reason: 'no level beyond; R extension' });
      r += 1;
    }
    return out;
  }

  private advanceSetups(i: number) {
    for (const s of [this.long, this.short]) if (s) this.advance(s, i);
  }

  private advance(s: Setup, i: number) {
    const bar = this.b[i]!;
    const bull = s.dir === 'bull';
    const beyond = (a: number, b: number) => (bull ? a > b : a < b); // a is further in the trade's favour than b
    const ok = (k: number) => { s.confirmations[k] = { ...s.confirmations[k]!, ok: true, at: i }; };

    if (s.state === 'FORMING') {
      const sweepPrice = s.events[0]!.price!;
      if (s.createdAt < i && beyond(sweepPrice, bar.close)) this.finish(s, 'INVALIDATED', i, bar.close, 'closed beyond the sweep');
      else if (i - s.createdAt > FORMING_BARS) this.finish(s, 'EXPIRED', i, null, 'no displaced structure shift');
      return;
    }

    if (s.state === 'READY') {
      const readyAt = s.events.find((e) => e.state === 'READY')!.at;
      if (readyAt >= i) return;
      const poi = s.poi!;
      const stop = s.stop!;
      if (beyond(stop, bar.close)) { this.finish(s, 'INVALIDATED', i, bar.close, 'closed through the stop before entry'); return; }
      const touched = s.confirmations[4]!.ok;
      if (!touched) {
        const into = bull ? bar.low <= poi.high : bar.high >= poi.low;
        if (!into) {
          const tp1 = s.targets[0]!.price;
          if (bull ? bar.high >= tp1 : bar.low <= tp1) this.finish(s, 'EXPIRED', i, null, 'ran to TP1 without a retest');
          else if (i - readyAt > READY_BARS) this.finish(s, 'EXPIRED', i, null, 'no retest');
          return;
        }
        ok(4);
        if (this.o.entry === 'limit') {
          // Research option: a resting limit at the zone edge, filled on the touch. On the fill
          // candle only the stop is checked -- which extreme came first is unknown.
          ok(5);
          s.fill = { at: i, price: s.entry!, risk: s.risk! };
          s.state = 'ACTIVE';
          s.events.push({ state: 'ACTIVE', at: i, known: i, price: s.entry!, note: 'filled at the zone edge (limit)' });
          s.mfeR = Math.max(0, (bull ? bar.close - s.entry! : s.entry! - bar.close) / s.risk!);
          s.maeR = Math.max(0, (bull ? s.entry! - bar.low : bar.high - s.entry!) / s.risk!);
          if (bull ? bar.low <= stop : bar.high >= stop) this.finish(s, 'STOPPED', i, stop, 'stop hit on the fill candle');
          return;
        }
      }
      // The trigger: a candle that closes back out of the zone in the trade's direction.
      const confirms = bull ? bar.close > poi.high && bar.close > bar.open : bar.close < poi.low && bar.close < bar.open;
      if (!confirms) {
        if (i - readyAt > READY_BARS) this.finish(s, 'EXPIRED', i, null, 'retest never closed back out');
        return;
      }
      const risk = bull ? bar.close - stop : stop - bar.close;
      const rr1 = (bull ? s.targets[0]!.price - bar.close : bar.close - s.targets[0]!.price) / risk;
      if (!(risk > 0) || rr1 < this.o.minTp1R) {
        this.finish(s, 'INVALIDATED', i, bar.close, `confirmed too far from the zone: TP1 ${rr1.toFixed(1)}R at the close`);
        return;
      }
      ok(5);
      s.fill = { at: i, price: bar.close, risk };
      s.state = 'ACTIVE';
      s.events.push({ state: 'ACTIVE', at: i, known: i, price: bar.close, note: 'entered at the close that confirmed the retest' });
      s.mfeR = 0;
      s.maeR = 0;
      return; // the fill candle is over: nothing in it happened after the entry
    }

    // In the trade. The stop in force is checked before the targets inside one
    // candle, the assumption that cannot flatter the record.
    const fill = s.fill!;
    const rOf = (p: number) => (bull ? p - fill.price : fill.price - p) / fill.risk;
    s.mfeR = Math.max(s.mfeR ?? 0, rOf(bull ? bar.high : bar.low));
    s.maeR = Math.max(s.maeR ?? 0, -rOf(bull ? bar.low : bar.high));
    const stopNow = s.trail[s.trail.length - 1]?.price ?? s.stop!;
    if (bull ? bar.low <= stopNow : bar.high >= stopNow) {
      const anyTp = s.state === 'TP1' || s.state === 'TP2';
      this.finish(s, anyTp ? 'PROTECTED' : 'STOPPED', i, stopNow, anyTp ? 'stopped at the protected stop' : 'stop hit');
      return;
    }
    const order: SetupState[] = ['TP1', 'TP2', 'TP3'];
    for (let k = order.indexOf(s.state as 'TP1') + 1; k < 3; k++) {
      const t = s.targets[k]!;
      if (!(bull ? bar.high >= t.price : bar.low <= t.price)) break;
      if (k === 2) { this.finish(s, 'TP3', i, t.price, `${t.label} reached`); return; }
      s.state = order[k]!;
      s.events.push({ state: s.state, at: i, known: i, price: t.price, note: `${t.label} reached; ${Math.round(SCALE_OUT[k]! * 100)}% off` });
      if (k === 1) {
        // TP2: trail behind the last confirmed swing, if that tightens the stop.
        const sw = bull ? this.lastLow : this.lastHigh;
        if (sw && sw.at > fill.at) this.tighten(s, bull ? sw.price - stopBuffer(this.atrs[i] ?? 0) : sw.price + stopBuffer(this.atrs[i] ?? 0), i, `trail behind ${sw.label ?? 'swing'} ${Math.round(sw.price)} after TP2`);
      }
    }

    // A swing confirmed on this candle, in the trade's favour: the protected stop moves.
    const sw = bull ? this.lastLow : this.lastHigh;
    if (sw && sw.known === i && sw.at > fill.at && beyond(sw.price, fill.price)) {
      if (s.state === 'TP1') this.tighten(s, fill.price, i, `break-even: ${sw.label ?? 'swing'} ${Math.round(sw.price)} confirmed after TP1`);
      else if (s.state === 'TP2') this.tighten(s, bull ? sw.price - stopBuffer(this.atrs[i] ?? 0) : sw.price + stopBuffer(this.atrs[i] ?? 0), i, `trail behind ${sw.label ?? 'swing'} ${Math.round(sw.price)}`);
    }
    if (i - fill.at > ACTIVE_BARS) this.finish(s, 'EXPIRED', i, bar.close, 'time exit');
  }

  /** Move the stop, only ever towards the trade. */
  private tighten(s: Setup, price: number, i: number, note: string) {
    const bull = s.dir === 'bull';
    const now = s.trail[s.trail.length - 1]?.price ?? s.stop!;
    if (bull ? price <= now : price >= now) return;
    s.trail.push({ at: i, known: i, price, note });
  }

  private finish(s: Setup, state: SetupState, i: number, price: number | null, note: string) {
    s.state = state;
    s.closedAt = i;
    s.events.push({ state, at: i, known: i, price, note });
    const fill = s.fill;
    if (fill) {
      const rOf = (p: number) => (s.dir === 'bull' ? p - fill.price : fill.price - p) / fill.risk;
      const hits = s.events.filter((e) => e.state === 'TP1' || e.state === 'TP2' || e.state === 'TP3').length;
      const banked = s.targets.slice(0, hits).reduce((sum, t, k) => sum + SCALE_OUT[k]! * rOf(t.price), 0);
      const left = 1 - SCALE_OUT.slice(0, hits).reduce((a, b) => a + b, 0);
      s.resultR = banked + (left > 1e-9 && price !== null ? left * rOf(price) : 0);
    }
    if (this.long === s) this.long = null;
    if (this.short === s) this.short = null;
  }

  // ---------------------------------------------------------------- range

  /** The dealing range between the latest confirmed swing high and low. */
  private dealingRange(): DealingRange | null {
    const h = this.lastHigh;
    const l = this.lastLow;
    const last = this.b[this.b.length - 1];
    if (!h || !l || !last || h.price <= l.price) return null;
    const r = h.price - l.price;
    const ote = this.trend === 'bull' ? { low: h.price - 0.79 * r, high: h.price - 0.62 * r }
      : this.trend === 'bear' ? { low: l.price + 0.62 * r, high: l.price + 0.79 * r } : null;
    return {
      high: h.price, low: l.price, highAt: h.at, lowAt: l.at, equilibrium: l.price + r / 2, ote,
      position: Math.max(0, Math.min(1, (last.close - l.price) / r)),
    };
  }
}

/** Whether anything recorded after candle `after` matches -- scanning back from the newest, and stopping there. */
function someSince<T extends { known: number }>(xs: readonly T[], after: number, match: (x: T) => boolean): boolean {
  for (let k = xs.length - 1; k >= 0 && xs[k]!.known > after; k--) if (match(xs[k]!)) return true;
  return false;
}

function ext(bar: Bar, i: number): Extreme {
  return { high: bar.high, low: bar.low, highAt: i, lowAt: i };
}

function grow(e: Extreme, bar: Bar, i: number) {
  if (bar.high > e.high) { e.high = bar.high; e.highAt = i; }
  if (bar.low < e.low) { e.low = bar.low; e.lowAt = i; }
}

/**
 * The options the desk's chart runs with: continuation setups on, a stop at
 * least 1.5 ATR from the entry, no minimum on TP1 (the nearest liquidity is
 * TP1 whatever it pays), and the entry at the close of the break -- momentum
 * rarely comes back to its zone. Chosen on 2024-25 out of twelve variants,
 * then judged once on 2026 -- see research/SMC-STUDY.txt, which also shows
 * that no variant clears fees. The HUD prints that record beside every setup.
 */
export const DESK_SMC_OPTIONS = { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break' } as const;

/** Run the engine over closed candles. The forming candle, if any, must be left out by the caller. */
export function runSmc(bars: readonly Bar[], opts: SmcOptions): SmcState {
  const e = new SmcEngine(opts);
  for (const b of bars) e.push(b);
  return e.state();
}

/** The confirmations still missing on a setup, in order. */
export const missing = (s: Setup): Confirmation[] => s.confirmations.filter((c) => !c.ok);
