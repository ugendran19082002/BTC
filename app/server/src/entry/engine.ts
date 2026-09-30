import type { Candle } from '../market/delta.js';
import {
  CHAIN, TF_SEC,
  type EntryContext, type EntryState, type Gate, type MethodRead, type Mode, type Plan, type ScorePart, type Step, type Tf,
} from './types.js';
import { METHODS, type Setup } from './methods.js';
import { atr, isDisplacement, lastSweep, pivots, rvol, trendOf, bullish, bearish } from './prims.js';

/**
 * The entry engine: twelve methods, each read with the timeframe chain and
 * without it -- 24 reads -- and every read ending TRADE, WAIT or NO TRADE the
 * same way (TEST.md):
 *
 *   1. the method's own chain on the entry timeframe (its detector)
 *   2. with the chain: 4H / 1H / 30m / 15m not against it, 3m confirming,
 *      1m at the entry
 *   3. hard gates -- any one fails, NO TRADE, whatever else is green
 *   4. targets from real liquidity, and R:R after taker fees both ways
 *   5. a quality score, which is not a probability and never shown as one
 *
 * Nothing here has an edge until the paper log says so. The research on this
 * desk's candles found every directional rule near zero before fees and
 * negative after (docs/research/findings.md); these reads are measured, not
 * trusted.
 */

/** Least reward to TP1 over risk, after fees, for a TRADE (TEST.md: "R:R > 1.8"). */
export const MIN_RR = 1.8;
/** Delta's taker fee, each side, as a share of price. */
export const FEE_PER_SIDE = 0.0005;
/** The stop sits this many ATRs past the structure it protects. */
export const STOP_BUFFER_ATR = 0.25;
/** A stop nearer than this many ATRs is inside the noise; further, too wide to be worth it. */
export const STOP_MIN_ATR = 0.3;
export const STOP_MAX_ATR = 2.5;
/** The newest closed 1m candle may be at most this old, in seconds. */
export const DATA_MAX_AGE_SEC = 180;
/** The perpetual's spread above this, as a percentage of price, is too wide to enter. */
export const SPREAD_MAX_PCT = 0.05;
/** No entry this close to the 17:30 IST settlement, in seconds. */
export const SETTLE_GUARD_SEC = 15 * 60;
/** The day's move past this share of the expected daily move, in the trade's direction: used up. */
export const EM_USED = 0.8;
/** Bars a timeframe needs before it is read at all. */
export const MIN_BARS = 60;

const fmt = (v: number) => Math.round(v).toLocaleString('en-US');
const dirName = (d: 1 | -1) => (d === 1 ? 'long' : 'short');

/**
 * Where the trade could take profit, nearest first: the method's own targets,
 * then swing levels on this timeframe and the ones above it, the book's walls
 * and the option walls, then the expected-move boundary.
 */
function targetLevels(dir: 1 | -1, from: number, bars: readonly Candle[], ctx: EntryContext, own: Setup['targets']): { price: number; why: string }[] {
  const out: { price: number; why: string }[] = [...(own ?? [])];
  const swingOf = (xs: readonly Candle[] | undefined, tf: string) =>
    pivots(xs ?? [], dir === 1 ? 'high' : 'low').map((p) => ({ price: p.price, why: `${tf} swing ${dir === 1 ? 'high' : 'low'} ${fmt(p.price)}` }));
  out.push(...swingOf(bars, 'entry'), ...swingOf(ctx.frames['1h'], '1h'), ...swingOf(ctx.frames['4h'], '4h'));
  for (const w of ctx.walls) {
    if ((dir === 1 && w.side === 'ask') || (dir === -1 && w.side === 'bid')) out.push({ price: w.price, why: `${w.side} wall ${fmt(w.price)}` });
  }
  const o = ctx.options;
  if (o) {
    const wall = dir === 1 ? o.callWall : o.putWall;
    if (wall !== null) out.push({ price: wall, why: `${dir === 1 ? 'call' : 'put'} OI wall ${fmt(wall)}` });
  }
  return out
    .filter((t) => (dir === 1 ? t.price > from : t.price < from))
    .sort((x, y) => Math.abs(x.price - from) - Math.abs(y.price - from))
    .filter((t, i, xs) => i === 0 || Math.abs(t.price - xs[i - 1]!.price) > 1e-9);
}

/** R:R after taker fees on the way in and the way out. */
export function rrAfterFees(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop);
  const fees = FEE_PER_SIDE * (entry + target);
  const reward = Math.abs(target - entry);
  return risk + fees > 0 ? (reward - fees) / (risk + fees) : 0;
}

function planOf(setup: Setup, a: number, bars: readonly Candle[], ctx: EntryContext): Plan {
  const dir = setup.dir;
  const [lo, hi] = setup.zone[0] <= setup.zone[1] ? setup.zone : [setup.zone[1], setup.zone[0]];
  const entry = (lo + hi) / 2;
  const stop = dir === 1 ? setup.stop - STOP_BUFFER_ATR * a : setup.stop + STOP_BUFFER_ATR * a;
  const risk = Math.abs(entry - stop);
  // A level closer than a fifth of an ATR past the zone is not a target, it is the zone.
  const beyond = dir === 1 ? hi + 0.2 * a : lo - 0.2 * a;
  const levels = targetLevels(dir, beyond, bars, ctx, setup.targets);
  const why: string[] = [];
  let tp1: number;
  let tp2: number | null = null;
  if (levels.length) {
    tp1 = levels[0]!.price;
    why.push(levels[0]!.why);
    if (levels[1]) { tp2 = levels[1].price; why.push(levels[1].why); }
  } else {
    tp1 = entry + dir * 2 * risk;
    why.push('2R -- no level found beyond the entry');
  }
  const o = ctx.options;
  const emEdge = o && o.emDay !== null ? o.spot + dir * o.emDay : null;
  const tp3 = emEdge !== null && (dir === 1 ? emEdge > (tp2 ?? tp1) : emEdge < (tp2 ?? tp1)) ? emEdge : null;
  if (tp3 !== null) why.push(`expected-move edge ${fmt(tp3)}`);
  return { entryLo: lo, entryHi: hi, stop, tp1, tp2, tp3, tpWhy: why, rr: rrAfterFees(entry, stop, tp1) };
}

/** The age of the newest closed candle on a timeframe, in seconds. */
const ageOf = (bars: readonly Candle[] | undefined, tf: Tf, nowSec: number) => {
  const b = bars?.[bars.length - 1];
  return b ? nowSec - (b.time + TF_SEC[tf]) : Infinity;
};

function gatesOf(i: {
  setup: Setup; plan: Plan; a: number; mode: Mode; tf: Tf; ctx: EntryContext; bars: readonly Candle[];
}): Gate[] {
  const { setup, plan, a, mode, tf, ctx } = i;
  const dir = setup.dir;
  const nowSec = Math.floor(ctx.now / 1000);
  const gates: Gate[] = [];
  const g = (key: string, label: string, ok: boolean, why: string | null) => gates.push({ key, label, ok, why: ok ? null : why });
  // The method's own "not now" first: it is the most specific reason there is.
  if (setup.blocked) g('method', 'Method allows it now', false, setup.blocked);

  const dataTf: Tf = mode === 'mtf' ? '1m' : tf;
  const age = ageOf(ctx.frames[dataTf], dataTf, nowSec);
  g('data', 'Data fresh', age <= (mode === 'mtf' ? DATA_MAX_AGE_SEC : TF_SEC[tf] + DATA_MAX_AGE_SEC),
    Number.isFinite(age) ? `the newest ${dataTf} candle is ${Math.round(age / 60)} min old` : `no ${dataTf} candles`);
  g('spread', 'Spread', ctx.spreadPct === null || ctx.spreadPct <= SPREAD_MAX_PCT,
    `the perpetual's spread is ${ctx.spreadPct?.toFixed(3)}%`);

  const risk = Math.abs((plan.entryLo + plan.entryHi) / 2 - plan.stop);
  g('stop-min', 'Stop outside the noise', risk >= STOP_MIN_ATR * a, `the stop is ${(risk / a).toFixed(2)} ATR away -- inside the noise`);
  g('stop-max', 'Stop not too wide', risk <= STOP_MAX_ATR * a, `the stop is ${(risk / a).toFixed(1)} ATR away -- too wide`);
  g('rr', `R:R ${MIN_RR} after fees`, plan.rr >= MIN_RR,
    `R:R to ${plan.tpWhy[0] ?? 'TP1'} is ${plan.rr.toFixed(2)} after fees -- no room`);

  if (mode === 'mtf') {
    const h1 = trendOf(ctx.frames['1h'] ?? []);
    const h4 = trendOf(ctx.frames['4h'] ?? []);
    g('htf', 'Higher timeframes not both against', !(h1 === -dir && h4 === -dir), `1H and 4H are both ${dir === 1 ? 'down' : 'up'}`);
  }

  const bm = ctx.bigMove;
  g('big-move', 'Big-move risk not against',
    !(bm && (bm.band === 'high' || bm.band === 'sudden') && bm.direction !== null && bm.direction * dir <= -0.3),
    `big-move risk ${bm?.band} pointing ${dir === 1 ? 'down' : 'up'}`);

  const o = ctx.options;
  const h1bars = ctx.frames['1h'] ?? [];
  const lastH1 = h1bars[h1bars.length - 1];
  if (o && o.emDay !== null && lastH1) {
    const dayStart = lastH1.time - (lastH1.time % 86_400);
    const open = h1bars.find((b) => b.time >= dayStart)?.open ?? null;
    const moved = open === null ? 0 : (i.bars[i.bars.length - 1]!.close - open) * dir;
    g('em', 'Expected move not used up', moved < EM_USED * o.emDay,
      `the day has moved ${fmt(moved)} of an expected ${fmt(o.emDay)} in this direction`);
  }
  if (o && o.toSettleSec !== null) {
    g('settle', 'Not into the settlement', !(o.toSettleSec >= 0 && o.toSettleSec <= SETTLE_GUARD_SEC),
      `settlement in ${Math.round(o.toSettleSec / 60)} min`);
  }
  return gates;
}

/** With the chain: each timeframe's check, coarsest first. The entry timeframe is the method's own chain. */
function chainSteps(setup: Setup, ctx: EntryContext, a5: number): Step[] {
  const dir = setup.dir;
  const notAgainst = (tf: Tf, role: string): Step => {
    const bars = ctx.frames[tf];
    if (!bars || bars.length < MIN_BARS) return { tf, label: `${role}: not enough candles`, ok: null };
    const t = trendOf(bars);
    return { tf, label: `${role}: ${t === dir ? 'with it' : t === 0 ? 'neutral' : 'against it'}`, ok: t !== -dir };
  };
  const steps: Step[] = [
    notAgainst('4h', 'macro context'),
    notAgainst('1h', 'major structure'),
    notAgainst('30m', 'regime'),
    notAgainst('15m', 'setup structure'),
  ];
  const m3 = ctx.frames['3m'] ?? [];
  const c3 = m3[m3.length - 1];
  steps.push(c3
    ? { tf: '3m', label: 'confirmation: the last 3m candle closed its way', ok: dir === 1 ? bullish(c3) : bearish(c3) }
    : { tf: '3m', label: 'confirmation: no 3m candles', ok: null });
  const m1 = ctx.frames['1m'] ?? [];
  const c1 = m1[m1.length - 1];
  if (!c1) {
    steps.push({ tf: '1m', label: 'execution: no 1m candles', ok: null });
  } else {
    const [lo, hi] = setup.zone[0] <= setup.zone[1] ? setup.zone : [setup.zone[1], setup.zone[0]];
    const atZone = dir === 1 ? c1.close <= hi + 0.3 * a5 && c1.low >= setup.stop : c1.close >= lo - 0.3 * a5 && c1.high <= setup.stop;
    steps.push({ tf: '1m', label: atZone ? 'execution: price at the entry, the stop intact' : 'execution: price has left the entry zone', ok: atZone });
  }
  return steps;
}

function scoreOf(setup: Setup, bars: readonly Candle[], a: number, trend: -1 | 0 | 1, ctx: EntryContext): ScorePart[] {
  const dir = setup.dir;
  const done = setup.steps.filter((s) => s.ok === true).length / Math.max(1, setup.steps.length);
  const recent = bars.slice(-6);
  const disp = recent.some((b) => isDisplacement(b, a, 1) && (dir === 1 ? bullish(b) : bearish(b)));
  const rv = rvol(bars);
  const sw = lastSweep(bars, 12);
  const nowSec = Math.floor(ctx.now / 1000);
  const tape = ctx.flow.filter((m) => m.time >= nowSec - 30 * 60);
  const delta = (xs: typeof tape) => xs.reduce((s, m) => s + m.buy - m.sell, 0);
  const o = ctx.options;
  const wall = o ? (dir === 1 ? o.callWall : o.putWall) : null;
  const price = bars[bars.length - 1]!.close;
  return [
    { name: 'Structure', max: 20, got: Math.round((trend === dir ? 10 : trend === 0 ? 5 : 0) + 10 * done) },
    { name: 'Liquidity', max: 15, got: sw && sw.dir === dir ? 15 : 0 },
    { name: 'Momentum', max: 15, got: (disp ? 8 : 0) + (rv !== null && rv >= 1.5 ? 7 : 0) },
    { name: 'Flow', max: 15, got: tape.length < 10 ? null : delta(tape.slice(-15)) * dir > 0 ? 15 : 0 },
    { name: 'CVD', max: 10, got: tape.length < 20 ? null : delta(tape) * dir > 0 && delta(tape.slice(-10)) * dir > 0 ? 10 : 0 },
    // Volume at each price is not recorded yet (docs/TODO.md, "Next recorders").
    { name: 'Footprint', max: 10, got: null },
    { name: 'Options', max: 10, got: !o ? null : wall === null || Math.abs(wall - price) > 2 * a ? 10 : 0 },
    // No calibrated probability for these setups exists; a score is not one.
    { name: 'Probability', max: 5, got: null },
  ];
}

/** One method, one mode, read to a state. */
export function readMethod(m: (typeof METHODS)[number], mode: Mode, tf: Tf, ctx: EntryContext): MethodRead {
  const entryTf: Tf = mode === 'mtf' ? '5m' : tf;
  const base = { id: m.id, n: m.n, name: m.name, group: m.group, mode, tf: entryTf };
  const empty = (reason: string, state: EntryState = 'NO_TRADE'): MethodRead => ({
    ...base, dir: null, state, steps: [], gates: [], plan: null, score: null, scoreParts: [], alignment: null, reason, triggerTime: null,
  });
  const bars = ctx.frames[entryTf] ?? [];
  if (bars.length < MIN_BARS) return empty(`not enough ${entryTf} candles yet (${bars.length} of ${MIN_BARS})`);
  const a = atr(bars);
  if (a === null || !(a > 0)) return empty('no volatility reading');
  const trend = trendOf(bars);
  const setup = m.detect({ bars, a, trend, ctx });
  if (!setup) return empty('nothing forming');

  const own: Step[] = setup.steps.map((s) => ({ tf: entryTf, ...s }));
  const chain = mode === 'mtf' ? chainSteps(setup, ctx, a) : [];
  const steps = mode === 'mtf'
    ? [...chain.filter((s) => s.tf === '4h' || s.tf === '1h' || s.tf === '30m' || s.tf === '15m'), ...own, ...chain.filter((s) => s.tf === '3m' || s.tf === '1m')]
    : own;
  const plan = planOf(setup, a, bars, ctx);
  const gates = gatesOf({ setup, plan, a, mode, tf: entryTf, ctx, bars });
  const scoreParts = scoreOf(setup, bars, a, trend, ctx);
  const score = scoreParts.reduce((s, p) => s + (p.got ?? 0), 0);

  let alignment: number | null = null;
  if (mode === 'mtf') {
    const ownOk = own.every((s) => s.ok === true);
    let got = 0;
    let of = 0;
    for (const c of CHAIN) {
      const ok = c.tf === '5m' ? ownOk : chain.find((s) => s.tf === c.tf)?.ok ?? null;
      if (ok === null) continue;
      of += c.weight;
      if (ok) got += c.weight;
    }
    alignment = of > 0 ? Math.round((100 * got) / of) : null;
  }

  const failed = gates.find((x) => !x.ok);
  const missing = steps.find((s) => s.ok !== true);
  const state: EntryState = failed ? 'NO_TRADE' : missing ? 'WAIT' : 'TRADE';
  const reason = failed
    ? failed.why ?? failed.label
    : missing
      ? missing.ok === null ? `${missing.tf ?? ''} ${missing.label}`.trim() : `waiting for ${missing.tf ? `${missing.tf}: ` : ''}${missing.label}`
      : `${dirName(setup.dir)} -- ${m.name}${mode === 'mtf' ? ' with the timeframe chain' : ` on ${entryTf}`}`;
  return {
    ...base,
    dir: dirName(setup.dir),
    state,
    steps,
    gates,
    // TEST.md: no box until every critical confirmation holds.
    plan: state === 'TRADE' ? plan : null,
    score,
    scoreParts,
    alignment,
    reason,
    triggerTime: setup.triggerTime,
  };
}

/**
 * The 24 reads: each method with the timeframe chain (entry on 5m), then each
 * without it, on `tf` alone.
 */
export function entryBoard(ctx: EntryContext, tf: Tf = '5m'): MethodRead[] {
  return (['mtf', 'single'] as const).flatMap((mode) => METHODS.map((m) => readMethod(m, mode, tf, ctx)));
}

export type TimeframeRow = {
  tf: Tf;
  role: string;
  /** +1 up, −1 down, 0 neither -- EMA stack and swings agreeing (`trendOf`). */
  trend: -1 | 0 | 1;
  label: 'Bullish' | 'Bearish' | 'Neutral' | 'Not read';
  /** What the last two swings did: "HH / HL", "LH / LL", "range". */
  structure: string;
};

/**
 * Each timeframe of the chain, read once for the whole board: the trend and
 * what its last swings did. The same reading every method's chain step uses.
 */
export function timeframeRows(ctx: EntryContext): TimeframeRow[] {
  return CHAIN.map(({ tf, role }) => {
    const bars = ctx.frames[tf] ?? [];
    if (bars.length < MIN_BARS) return { tf, role, trend: 0, label: 'Not read', structure: `${bars.length} candles` };
    const t = trendOf(bars);
    const hs = pivots(bars, 'high').slice(-2);
    const ls = pivots(bars, 'low').slice(-2);
    const hh = hs.length === 2 ? (hs[1]!.price > hs[0]!.price ? 'HH' : 'LH') : null;
    const hl = ls.length === 2 ? (ls[1]!.price > ls[0]!.price ? 'HL' : 'LL') : null;
    const structure = hh && hl ? (hh === 'HH' && hl === 'HL' ? 'HH / HL' : hh === 'LH' && hl === 'LL' ? 'LH / LL' : `range (${hh} / ${hl})`) : 'no swings yet';
    return { tf, role, trend: t, label: t === 1 ? 'Bullish' : t === -1 ? 'Bearish' : 'Neutral', structure };
  });
}
