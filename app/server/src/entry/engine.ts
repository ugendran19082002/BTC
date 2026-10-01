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
 *   4. targets from real liquidity, and R:R to TP1 (reward over risk, in points;
 *      no fee term -- the owner removed it from the entry section, 1 Oct 2026)
 *   5. a quality score, which is not a probability and never shown as one
 *
 * Nothing here has an edge until the paper log says so. The research on this
 * desk's candles found every directional rule near zero before fees and
 * negative after (docs/research/findings.md); these reads are measured, not
 * trusted.
 */

/** Least reward to TP1 over risk for a TRADE (TEST.md: "R:R > 1.8"). */
export const MIN_RR = 1.8;
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
/** The last trade is the live price while it is at most this old; older, the last closed 1m candle is. */
export const LTP_FRESH_MS = 15_000;

/** Bars a timeframe needs before it is read at all. */
export const MIN_BARS = 60;
/**
 * The widest an entry zone may be, in ATRs, measured back from the edge price
 * reaches first. A whole order-block candle or fair-value gap was up to 8 ATR
 * (689 points) before the 30 Sep 2026 audit -- not an entry, a region.
 */
export const MAX_ZONE_ATR = 0.5;
/**
 * Each target at least this many ATRs past the one before it. Two swing levels
 * 29 points apart were TP1 and TP2 on the owner's screen (30 Sep 2026): a
 * second target that close adds nothing.
 */
export const TP_STEP_ATR = 0.5;

/**
 * Where a trade in this zone fills: the edge price reaches first -- the top
 * for a long (price comes down into it), the bottom for a short. The paper log
 * fills there, so risk, R:R and the stop band are measured from it, not from
 * the middle (which made a wide zone look cheaper than it was).
 */
export const fillOf = (p: Pick<Plan, 'entryLo' | 'entryHi'>, dir: 1 | -1) => (dir === 1 ? p.entryHi : p.entryLo);

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

/**
 * R:R: the points to the target over the points to the stop, from the fill.
 * No fee term -- the owner removed "after fees" from the entry section on
 * 1 Oct 2026; the levels and the record are in plain points and R.
 */
export function rrOf(entry: number, stop: number, target: number): number {
  const loss = Math.abs(entry - stop);
  return loss > 0 ? Math.abs(target - entry) / loss : 0;
}

function planOf(setup: Setup, a: number, bars: readonly Candle[], ctx: EntryContext): Plan {
  const dir = setup.dir;
  const [z0, z1] = setup.zone[0] <= setup.zone[1] ? setup.zone : [setup.zone[1], setup.zone[0]];
  // Never wider than MAX_ZONE_ATR, kept at the edge price reaches first.
  const lo = dir === 1 ? Math.max(z0, z1 - MAX_ZONE_ATR * a) : z0;
  const hi = dir === 1 ? z1 : Math.min(z1, z0 + MAX_ZONE_ATR * a);
  const entry = fillOf({ entryLo: lo, entryHi: hi }, dir);
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
    // The next level far enough past TP1 to be a target of its own; none, no TP2 (never an invented one).
    const next = levels.find((l) => (l.price - tp1) * dir >= TP_STEP_ATR * a);
    if (next) { tp2 = next.price; why.push(next.why); }
  } else {
    tp1 = entry + dir * 2 * risk;
    why.push('2R -- no level found beyond the entry');
  }
  const o = ctx.options;
  const emEdge = o && o.emDay !== null ? o.spot + dir * o.emDay : null;
  const tp3 = emEdge !== null && (emEdge - (tp2 ?? tp1)) * dir >= TP_STEP_ATR * a ? emEdge : null;
  if (tp3 !== null) why.push(`expected-move edge ${fmt(tp3)}`);
  return { entryLo: lo, entryHi: hi, stop, tp1, tp2, tp3, tpWhy: why, rr: rrOf(entry, stop, tp1) };
}

/** The age of the newest closed candle on a timeframe, in seconds. */
const ageOf = (bars: readonly Candle[] | undefined, tf: Tf, nowSec: number) => {
  const b = bars?.[bars.length - 1];
  return b ? nowSec - (b.time + TF_SEC[tf]) : Infinity;
};

/**
 * The hard gates, all of them, in the checklist's order: any one false and
 * the read is NO TRADE, whatever else holds. A gate the data cannot answer is
 * listed as not read (`ok` null) rather than left out, so the screen can show
 * the whole list.
 */
function gatesOf(i: {
  setup: Setup; plan: Plan; a: number; mode: Mode; tf: Tf; ctx: EntryContext; bars: readonly Candle[]; methodRule?: string;
}): Gate[] {
  const { setup, plan, a, mode, tf, ctx } = i;
  const dir = setup.dir;
  const nowSec = Math.floor(ctx.now / 1000);
  const gates: Gate[] = [];
  const off = new Set(ctx.gatesOff ?? []);
  // Data fresh cannot be switched off: on stale candles nothing else here means anything.
  const g = (key: string, label: string, rule: string, value: string | null, ok: boolean | null, why: string | null) =>
    gates.push({ key, label, rule, value, ok, why: ok === false ? why : null, enabled: key === 'data' || !off.has(key) });

  const dataTf: Tf = mode === 'mtf' ? '1m' : tf;
  const maxAge = mode === 'mtf' ? DATA_MAX_AGE_SEC : TF_SEC[tf] + DATA_MAX_AGE_SEC;
  const age = ageOf(ctx.frames[dataTf], dataTf, nowSec);
  g('data', 'Data fresh', `newest ${dataTf} candle ≤ ${Math.round(maxAge / 60)} min old`,
    Number.isFinite(age) ? `${(age / 60).toFixed(1)} min old` : `no ${dataTf} candles`, age <= maxAge,
    Number.isFinite(age) ? `the newest ${dataTf} candle is ${Math.round(age / 60)} min old` : `no ${dataTf} candles`);

  g('spread', 'Spread', `perp spread ≤ ${SPREAD_MAX_PCT}%`,
    ctx.spreadPct === null ? 'not read' : `${ctx.spreadPct.toFixed(3)}%`,
    ctx.spreadPct === null ? null : ctx.spreadPct <= SPREAD_MAX_PCT,
    `the perpetual's spread is ${ctx.spreadPct?.toFixed(3)}%`);

  const risk = Math.abs(fillOf(plan, dir) - plan.stop);
  const inAtr = risk / a;
  g('stop', 'Stop band', `stop ${STOP_MIN_ATR}–${STOP_MAX_ATR} ATR from the entry`, `${inAtr.toFixed(2)} ATR`,
    inAtr >= STOP_MIN_ATR && inAtr <= STOP_MAX_ATR,
    inAtr < STOP_MIN_ATR ? `the stop is ${inAtr.toFixed(2)} ATR away -- inside the noise` : `the stop is ${inAtr.toFixed(1)} ATR away -- too wide`);

  g('rr', 'R:R', `≥ ${MIN_RR} to TP1`, plan.rr.toFixed(2), plan.rr >= MIN_RR,
    `R:R to ${plan.tpWhy[0] ?? 'TP1'} is ${plan.rr.toFixed(2)} -- no room`);

  if (mode === 'mtf') {
    const h1 = trendOf(ctx.frames['1h'] ?? []);
    const h4 = trendOf(ctx.frames['4h'] ?? []);
    const word = (t: -1 | 0 | 1) => (t === 1 ? 'up' : t === -1 ? 'down' : 'flat');
    g('htf', 'HTF alignment', '1H and 4H not both against', `1H ${word(h1)} · 4H ${word(h4)}`,
      !(h1 === -dir && h4 === -dir), `1H and 4H are both ${dir === 1 ? 'down' : 'up'}`);
  } else {
    g('htf', 'HTF alignment', '1H and 4H not both against', 'not part of this mode', null, null);
  }

  const bm = ctx.bigMove;
  g('big-move', 'Big-move risk', 'not high / sudden pointing the other way',
    bm ? `${bm.band}${bm.direction === null ? '' : bm.direction > 0 ? ' · up' : bm.direction < 0 ? ' · down' : ''}` : 'not read',
    bm ? !((bm.band === 'high' || bm.band === 'sudden') && bm.direction !== null && bm.direction * dir <= -0.3) : null,
    `big-move risk ${bm?.band} pointing ${dir === 1 ? 'down' : 'up'}`);

  const o = ctx.options;
  const h1bars = ctx.frames['1h'] ?? [];
  const lastH1 = h1bars[h1bars.length - 1];
  if (o && o.emDay !== null && o.emDay > 0 && lastH1) {
    const dayStart = lastH1.time - (lastH1.time % 86_400);
    const open = h1bars.find((b) => b.time >= dayStart)?.open ?? null;
    const moved = open === null ? 0 : (i.bars[i.bars.length - 1]!.close - open) * dir;
    g('em', 'Expected move', `< ${EM_USED * 100}% of the day's expected move used this way`,
      `${Math.max(0, Math.round((100 * moved) / o.emDay))}% used`, moved < EM_USED * o.emDay,
      `the day has moved ${fmt(moved)} of an expected ${fmt(o.emDay)} in this direction`);
  } else {
    g('em', 'Expected move', `< ${EM_USED * 100}% of the day's expected move used this way`, 'no option board', null, null);
  }
  if (o && o.toSettleSec !== null) {
    const mins = Math.round(o.toSettleSec / 60);
    g('settle', 'Settlement', `not within ${SETTLE_GUARD_SEC / 60} min of 17:30 IST`,
      o.toSettleSec < 0 ? 'settled' : `${Math.floor(mins / 60)}h ${mins % 60}m to go`,
      !(o.toSettleSec >= 0 && o.toSettleSec <= SETTLE_GUARD_SEC), `settlement in ${mins} min`);
  } else {
    g('settle', 'Settlement', `not within ${SETTLE_GUARD_SEC / 60} min of 17:30 IST`, 'no option board', null, null);
  }

  // The method's own "not now" (momentum extended, mean reversion on a trend day), for the methods that have one.
  if (i.methodRule || setup.blocked) {
    g('method', 'Method gate', i.methodRule ?? 'the method\'s own condition', setup.blocked ? 'refused' : 'clear', !setup.blocked, setup.blocked ?? null);
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
    // The live price where there is one: the perpetual's last trade, fresh; else the last closed 1m close.
    const live = ctx.ltp && ctx.now - ctx.ltp.at <= LTP_FRESH_MS ? ctx.ltp.price : null;
    const px = live ?? c1.close;
    const stopIntact = dir === 1 ? Math.min(c1.low, px) >= setup.stop : Math.max(c1.high, px) <= setup.stop;
    const atZone = (dir === 1 ? px <= hi + 0.3 * a5 : px >= lo - 0.3 * a5) && stopIntact;
    const where = live !== null ? `LTP ${fmt(live)}` : `last 1m close ${fmt(c1.close)}`;
    steps.push({ tf: '1m', label: atZone ? `execution: ${where} at the entry, the stop intact` : `execution: ${where} has left the entry zone`, ok: atZone });
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
  const base = { id: m.id, n: m.n, name: m.name, group: m.group, summary: m.summary, mode, tf: entryTf };
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
  const gates = gatesOf({ setup, plan, a, mode, tf: entryTf, ctx, bars, methodRule: m.gate });
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

  // The method's own gate is the most specific reason there is, so it speaks first.
  // A gate switched off still reads, and still shows ✗, but refuses nothing.
  const refusing = gates.filter((x) => x.enabled && x.ok === false);
  const failed = refusing.find((x) => x.key === 'method') ?? refusing[0];
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
  // A view-only timeframe (1m) has no reads without the chain: the panel shows its chart alone.
  const modes = SINGLE_TFS.includes(tf) ? (['mtf', 'single'] as const) : (['mtf'] as const);
  return modes.flatMap((mode) => METHODS.map((m) => readMethod(m, mode, tf, ctx)));
}

/**
 * Every timeframe a read without the chain is taken on -- and so signalled,
 * alerted and kept in the history. Not 1m: at the owner's request (1 Oct 2026)
 * 1m is a chart to look at only; its bars are too fast for these methods'
 * stops and fees. The chain still reads 1m as its execution step.
 */
export const SINGLE_TFS: readonly Tf[] = ['3m', '5m', '15m', '30m', '1h', '4h'];

/** Timeframes the without-the-chain panel may show as a chart only: no reads, no signal, no alert. */
export const VIEW_ONLY_TFS: readonly Tf[] = ['1m'];

/**
 * Every read the screen can show: the twelve with the chain (read once -- its
 * entry is 5m whatever is chosen) and the twelve without it on each timeframe.
 * What the recorder writes, so a signal is kept whichever chip was on screen.
 */
export function allReads(ctx: EntryContext, tfs: readonly Tf[] = SINGLE_TFS): MethodRead[] {
  return [
    ...METHODS.map((m) => readMethod(m, 'mtf', '5m', ctx)),
    ...tfs.flatMap((tf) => METHODS.map((m) => readMethod(m, 'single', tf, ctx))),
  ];
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
