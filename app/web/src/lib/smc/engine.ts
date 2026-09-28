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

/** How long a setup may wait at each stage, in bars. */
const FORMING_BARS = 24;
const READY_BARS = 30;
const ACTIVE_BARS = 96;
/** The share of the position closed at each of the three targets. */
export const SCALE_OUT = 1 / 3;

type Extreme = { high: number; low: number; highAt: number; lowAt: number };

export class SmcEngine {
  private readonly o: Required<Omit<SmcOptions, 'htfTrendAt'>> & Pick<SmcOptions, 'htfTrendAt'>;
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
  private long: Setup | null = null;
  private short: Setup | null = null;

  private day: { key: number; ext: Extreme; open: number; pv: number; v: number } | null = null;
  private week: { key: number; ext: Extreme } | null = null;
  private month: { key: number; ext: Extreme } | null = null;
  private session: { name: Session; day: number; from: number; ext: Extreme } | null = null;

  constructor(opts: SmcOptions) {
    this.o = { pivotLeft: 2, pivotRight: 2, ...opts };
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
    if (this.liveZones.has(id) || this.zones.some((z) => z.id === id)) return null;
    const zone: Zone = { id, kind: 'OB', dir, low: c.low, high: c.high, at: pick, known: i, source };
    this.zones.push(zone);
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
   * The sequence the setup follows, long side (short mirrors it):
   *
   *   sell-side liquidity swept → bullish CHoCH / BOS → POI (the break's OB,
   *   else a bullish FVG since the sweep) → retest fills at the POI's top →
   *   stop under the sweep and the POI, plus a tenth of an ATR → targets at the
   *   buy-side liquidity already on the chart, R multiples only where there is
   *   none.
   *
   * The plan is fixed when the setup turns READY. Every target is at least 1R.
   * A third of the position comes off at each target; after TP1 the stop moves
   * to break-even, and that move is an event like any other.
   */
  private onSweep(pool: Pool, i: number) {
    const dir: Dir = pool.side === 'sell' ? 'bull' : 'bear';
    const slot = dir === 'bull' ? this.long : this.short;
    if (slot && slot.state !== 'FORMING') return; // a plan already made is not replaced by a newer sweep
    if (slot) this.finish(slot, 'INVALIDATED', i, null, 'superseded by a newer sweep');
    const bar = this.b[i]!;
    const s: Setup = {
      id: `${dir === 'bull' ? 'L' : 'S'}-${bar.time}`,
      dir,
      createdAt: i,
      state: 'FORMING',
      confirmations: [
        { name: `${dir === 'bull' ? 'Sell' : 'Buy'}-side liquidity swept (${pool.kind})`, ok: true, at: i },
        { name: `${dir === 'bull' ? 'Bullish' : 'Bearish'} CHoCH / BOS`, ok: false, at: null },
        { name: 'POI: order block or FVG', ok: false, at: null },
        { name: 'Retest of the POI', ok: false, at: null },
      ],
      poi: null, entry: null, stop: null, targets: [], risk: null, htf: null,
      events: [{ state: 'FORMING', at: i, known: i, price: dir === 'bull' ? bar.low : bar.high, note: `${pool.kind} ${Math.round(pool.price)} swept` }],
      mfeR: null, maeR: null, resultR: null, closedAt: null,
    };
    this.setups.push(s);
    if (dir === 'bull') this.long = s; else this.short = s;
  }

  private onStructure(brk: StructureBreak, ob: Zone | null, i: number) {
    const s = brk.dir === 'bull' ? this.long : this.short;
    if (!s || s.state !== 'FORMING' || s.createdAt >= i) return;
    s.confirmations[1] = { ...s.confirmations[1]!, ok: true, at: i };
    const fvg = [...this.liveZones.values()].map((l) => l.zone).reverse()
      .find((z) => z.kind === 'FVG' && z.dir === brk.dir && z.known > s.createdAt && z.known <= i);
    const poi = ob ?? fvg ?? null;
    if (!poi) { this.finish(s, 'INVALIDATED', i, null, `${brk.kind} with no OB or FVG to enter from`); return; }
    s.confirmations[2] = { ...s.confirmations[2]!, ok: true, at: i };

    const bull = brk.dir === 'bull';
    const sweepPrice = s.events[0]!.price!;
    const atr = this.atrs[i] ?? 0;
    const entry = bull ? poi.high : poi.low;
    const stop = bull ? Math.min(sweepPrice, poi.low) - 0.1 * atr : Math.max(sweepPrice, poi.high) + 0.1 * atr;
    const risk = bull ? entry - stop : stop - entry;
    if (!(risk > 0) || risk > 4 * atr) { this.finish(s, 'INVALIDATED', i, null, 'stop wider than four ATR'); return; }

    s.poi = poi;
    s.entry = entry;
    s.stop = stop;
    s.risk = risk;
    s.targets = this.targetsFor(brk.dir, entry, risk, i);
    const htf = this.o.htfTrendAt?.(this.b[i]!.time + this.o.tfSec) ?? null;
    s.htf = htf;
    s.state = 'READY';
    s.events.push({ state: 'READY', at: i, known: i, price: entry, note: `${brk.kind} ${Math.round(brk.level)}; POI ${poi.kind} ${Math.round(poi.low)}–${Math.round(poi.high)}` });
  }

  /** Liquidity already on the chart beyond the entry, nearest first; R multiples fill in only where there is none. */
  private targetsFor(dir: Dir, entry: number, risk: number, i: number): Target[] {
    const bull = dir === 'bull';
    const atr = this.atrs[i] ?? 0;
    // A target nearer than the stop is not worth the risk it asks for: every target is at least 1R.
    const beyond = (p: number) => (bull ? p - entry : entry - p) >= risk;
    const candidates: { price: number; label: string; source: Target['source'] }[] = [];
    for (const p of this.livePools.values()) {
      if (p.known > i || p.side !== (bull ? 'buy' : 'sell') || !beyond(p.price)) continue;
      const level = !['BSL', 'SSL', 'EQH', 'EQL'].includes(p.kind);
      candidates.push({ price: p.price, label: p.kind, source: level ? 'level' : 'liquidity' });
    }
    candidates.sort((a, b) => (bull ? a.price - b.price : b.price - a.price));
    const out: Target[] = [];
    for (const c of candidates) {
      if (out.some((t) => Math.abs(t.price - c.price) <= 0.2 * atr)) continue;
      out.push({ ...c, rr: Math.abs(c.price - entry) / risk });
      if (out.length === 3) break;
    }
    let r = Math.max(2, Math.ceil(out[out.length - 1]?.rr ?? 1) + 1);
    while (out.length < 3) {
      out.push({ price: bull ? entry + r * risk : entry - r * risk, label: `${r}R`, source: 'R-multiple', rr: r });
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
    const since = (state: SetupState) => i - (s.events.find((e) => e.state === state)?.at ?? i);

    if (s.state === 'FORMING') {
      const sweepPrice = s.events[0]!.price!;
      if (s.createdAt < i && (bull ? bar.close < sweepPrice : bar.close > sweepPrice)) this.finish(s, 'INVALIDATED', i, bar.close, 'closed beyond the sweep');
      else if (since('FORMING') > FORMING_BARS) this.finish(s, 'EXPIRED', i, null, 'no structure shift');
      return;
    }

    if (s.state === 'READY') {
      const readyAt = s.events.find((e) => e.state === 'READY')!.at;
      if (readyAt >= i) return;
      const entry = s.entry!;
      const filled = bull ? bar.low <= entry : bar.high >= entry;
      if (!filled) {
        const tp1 = s.targets[0]!.price;
        if (bull ? bar.high >= tp1 : bar.low <= tp1) this.finish(s, 'EXPIRED', i, null, 'ran to TP1 without a retest');
        else if (i - readyAt > READY_BARS) this.finish(s, 'EXPIRED', i, null, 'no retest');
        return;
      }
      s.confirmations[3] = { ...s.confirmations[3]!, ok: true, at: i };
      s.state = 'ACTIVE';
      s.events.push({ state: 'ACTIVE', at: i, known: i, price: entry, note: 'filled at the POI' });
      s.mfeR = 0;
      s.maeR = 0;
    }
    /*
     * A candle does not say whether its high came before or after the fill,
     * so on the fill candle nothing favourable is counted: the excursion is
     * taken at the close and no target is awarded. The stop still is -- the
     * same ignorance, resolved against the trade.
     */
    const justFilled = s.state === 'ACTIVE' && s.events[s.events.length - 1]!.at === i;

    // In the trade: the stop is checked before the targets inside one candle,
    // the assumption that cannot flatter the record.
    const entry = s.entry!;
    const risk = s.risk!;
    const best = justFilled ? bar.close : bull ? bar.high : bar.low;
    s.mfeR = Math.max(s.mfeR ?? 0, (bull ? best - entry : entry - best) / risk);
    s.maeR = Math.max(s.maeR ?? 0, (bull ? entry - bar.low : bar.high - entry) / risk);
    const pastTp1 = s.state === 'TP1' || s.state === 'TP2';
    const stop = pastTp1 ? entry : s.stop!;
    if (bull ? bar.low <= stop : bar.high >= stop) {
      this.finish(s, pastTp1 ? 'BREAKEVEN' : 'STOPPED', i, stop, pastTp1 ? 'stopped at break-even' : 'stop hit');
      return;
    }
    if (justFilled) return;
    const order: SetupState[] = ['TP1', 'TP2', 'TP3'];
    const reached = order.indexOf(s.state as 'TP1');
    for (let k = reached + 1; k < 3; k++) {
      const t = s.targets[k]!;
      if (!(bull ? bar.high >= t.price : bar.low <= t.price)) break;
      if (k === 2) { this.finish(s, 'TP3', i, t.price, `${t.label} reached`); return; }
      s.state = order[k]!;
      s.events.push({ state: s.state, at: i, known: i, price: t.price, note: k === 0 ? `${t.label} reached; stop to break-even` : `${t.label} reached` });
    }
    if (since('ACTIVE') > ACTIVE_BARS) this.finish(s, 'EXPIRED', i, bar.close, 'time exit');
  }

  private finish(s: Setup, state: SetupState, i: number, price: number | null, note: string) {
    s.state = state;
    s.closedAt = i;
    s.events.push({ state, at: i, known: i, price, note });
    if (s.entry !== null && s.risk && s.events.some((e) => e.state === 'ACTIVE')) {
      /*
       * A third off at each target, the rest on until the next one or the
       * stop -- which is at break-even from TP1 on. So TP1 then back to entry
       * banks a third of TP1's R, not nothing, and a stop before TP1 is -1R.
       */
      const hit = s.targets.filter((_, k) => s.events.some((e) => e.state === `TP${k + 1}`) || (k === 2 && state === 'TP3'));
      const banked = hit.reduce((sum, t) => sum + t.rr * SCALE_OUT, 0);
      const left = 1 - hit.length * SCALE_OUT;
      const exitR = price === null ? 0 : (s.dir === 'bull' ? price - s.entry : s.entry - price) / s.risk;
      if (state === 'STOPPED') s.resultR = -1;
      else if (state === 'BREAKEVEN') s.resultR = banked;
      else if (state === 'TP3') s.resultR = banked;
      else if (state === 'EXPIRED') s.resultR = banked + left * exitR;
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

function ext(bar: Bar, i: number): Extreme {
  return { high: bar.high, low: bar.low, highAt: i, lowAt: i };
}

function grow(e: Extreme, bar: Bar, i: number) {
  if (bar.high > e.high) { e.high = bar.high; e.highAt = i; }
  if (bar.low < e.low) { e.low = bar.low; e.lowAt = i; }
}

/** Run the engine over closed candles. The forming candle, if any, must be left out by the caller. */
export function runSmc(bars: readonly Bar[], opts: SmcOptions): SmcState {
  const e = new SmcEngine(opts);
  for (const b of bars) e.push(b);
  return e.state();
}

/** The confirmations still missing on a setup, in order. */
export const missing = (s: Setup): Confirmation[] => s.confirmations.filter((c) => !c.ok);
