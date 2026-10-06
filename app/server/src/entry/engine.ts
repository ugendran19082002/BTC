import type { Candle } from '../market/delta.js';
import {
  CHAIN, TF_SEC,
  type EntryContext, type EntryState, type Gate, type MethodRead, type Mode, type Plan, type ScorePart, type Step, type Tf,
} from './types.js';
import { METHODS, regimeOf, type MethodDef, type Regime, type Setup, type TargetSpec } from './methods.js';
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

/**
 * Least reward to TP1 over risk, from the fill: 1R -- TGT1 at least as far as
 * the stop, and no maximum (owner, 1 Oct 2026; TEST.md had 1.8). One number
 * for both TP1's choice and the R:R gate, so they can never disagree.
 */
export const MIN_RR = 1;
/**
 * TGT1 is a real level no farther than this; past it, TGT1 is TP1_FALLBACK_R
 * and the far level becomes TGT2 (owner, 1 Oct 2026). The live log's same
 * trades regraded with TGT1 at 0.3-2R: average R best at 1.5-2R before and
 * after 07:30, while TGT1s that averaged 2.8R (breakout 4.9R) were rarely
 * reached before the stop.
 */
export const MAX_TP1_R = 2;
export const TP1_FALLBACK_R = 1.5;
/** The entry zone keeps at least this many ATRs from the stop. */
export const ZONE_STOP_GAP_ATR = 0.1;
/** The stop sits this many ATRs past the structure it protects. */
export const STOP_BUFFER_ATR = 0.25;
/** A stop nearer than this many ATRs is inside the noise; further, too wide to be worth it. */
export const STOP_MIN_ATR = 0.3;
export const STOP_MAX_ATR = 2.5;
/**
 * The furthest the price may be from the entry zone, in ATRs, for a setup to
 * still be in play (1 Oct 2026 audit: 445 TRADEs in six months sat over 2 ATR
 * away -- a move that had happened, waiting for a return that rarely came).
 */
export const PLAN_MAX_AWAY_ATR = 2;

/**
 * Why a plan cannot be traded at `px`, in words, or null when it can.
 *
 * Three things the levels alone can get wrong (the 1 Oct 2026 audit replayed
 * all 81 methods over six months and found each): the stop on the winning
 * side of the entry -- two liquidity-sweep longs with the stop above the fill,
 * passed because risk is measured as a distance; TGT1 already reached by the
 * price -- 980 TRADEs, each written down at once as "expired, ran to TGT1
 * without it"; and the zone more than PLAN_MAX_AWAY_ATR from the price.
 */
export function planProblem(plan: Pick<Plan, 'entryLo' | 'entryHi' | 'stop' | 'tp1'>, dir: 1 | -1, px: number, a: number): string | null {
  const edge = fillOf(plan, dir);
  if (!((edge - plan.stop) * dir > 0)) return `the stop ${fmt(plan.stop)} is on the wrong side of the ${fmt(edge)} entry`;
  if (!((plan.tp1 - px) * dir > 0)) return `the price ${fmt(px)} has already reached TGT1 ${fmt(plan.tp1)} -- the move happened without the trade`;
  const away = dir === 1 ? px - plan.entryHi : plan.entryLo - px;
  if (away > PLAN_MAX_AWAY_ATR * a) return `the entry is ${(away / a).toFixed(1)} ATR from the price -- the setup is behind it`;
  return null;
}

/** The newest closed 1m candle may be at most this old, in seconds. */
export const DATA_MAX_AGE_SEC = 180;
/** The perpetual's spread above this, as a percentage of price, is too wide to enter. */
export const SPREAD_MAX_PCT = 0.05;
/** Most the perpetual's last trade may sit from its mark price, in percent, before it is a wick, not a price. */
export const MARK_MAX_PCT = 0.15;
/** A trade or a mark older than this is not "now". */
const QUOTE_FRESH_MS = 30_000;
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
type Level = { price: number; why: string; kind: 'own' | 'entry' | 'htf' | 'wall' | 'oi' };

/**
 * Every level price could be aimed at past `from`, nearest first, each with
 * its kind: the method's own, a swing on the entry timeframe, a 1H/4H swing,
 * a book wall, the OI wall.
 */
export function targetLevels(dir: 1 | -1, from: number, bars: readonly Candle[], ctx: EntryContext, own: Setup['targets']): Level[] {
  const out: Level[] = (own ?? []).map((t) => ({ ...t, kind: 'own' as const }));
  // A swing price has traded through since it formed is consumed -- its liquidity is taken -- and no target.
  const swingOf = (xs: readonly Candle[] | undefined, tf: string, kind: 'entry' | 'htf') =>
    pivots(xs ?? [], dir === 1 ? 'high' : 'low')
      .filter((p) => !(xs ?? []).slice(p.i + 1).some((b) => (dir === 1 ? b.high > p.price : b.low < p.price)))
      .map((p) => ({ price: p.price, why: `${tf} swing ${dir === 1 ? 'high' : 'low'} ${fmt(p.price)}`, kind }));
  out.push(...swingOf(bars, 'entry', 'entry'), ...swingOf(ctx.frames['1h'], '1h', 'htf'), ...swingOf(ctx.frames['4h'], '4h', 'htf'));
  for (const w of ctx.walls) {
    if ((dir === 1 && w.side === 'ask') || (dir === -1 && w.side === 'bid')) out.push({ price: w.price, why: `${w.side} wall ${fmt(w.price)}`, kind: 'wall' });
  }
  const o = ctx.options;
  if (o) {
    const wall = dir === 1 ? o.callWall : o.putWall;
    if (wall !== null) out.push({ price: wall, why: `${dir === 1 ? 'call' : 'put'} OI wall ${fmt(wall)}`, kind: 'oi' });
  }
  return out
    .filter((t) => (dir === 1 ? t.price > from : t.price < from))
    .sort((x, y) => Math.abs(x.price - from) - Math.abs(y.price - from))
    .filter((t, i, xs) => i === 0 || Math.abs(t.price - xs[i - 1]!.price) > 1e-9);
}

/** The kinds each method looks at first for TP1, before any other (methods.ts TargetSpec). */
const TP1_KINDS: Record<Exclude<TargetSpec['tp1'], 'own'>, readonly Level['kind'][]> = {
  nearest: ['own', 'entry', 'htf', 'wall', 'oi'], swing: ['entry'], book: ['wall', 'entry'], oi: ['oi'],
};

/** The kinds each TP2 pool draws from (methods.ts TargetSpec). */
const TP2_KINDS: Record<TargetSpec['tp2'], readonly Level['kind'][]> = {
  htf: ['htf'], next: ['own', 'entry', 'htf', 'wall', 'oi'], own: ['own'], book: ['wall', 'entry'], oi: ['oi'],
};

/**
 * TP1, TP2 and TP3 by the method's own rule (owner's SL/TP tables, 1 Oct 2026).
 *
 * TP1 is the nearest *valid* target, not merely the nearest: of the levels
 * past the zone (each in the trade's direction, none consumed), the first in
 * the method's own priority -- a continuation swing, a book wall, an OI wall
 * -- that pays at least `minRr` from the fill; failing that, the first of any
 * kind that does. A nearer level that pays less is skipped, and the reason
 * says so. Only when no level pays enough is TP1 the nearest one -- and the
 * R:R gate then refuses the read, honestly. VWAP reversion keeps VWAP as TP1
 * whatever it pays: reverting to VWAP is the method.
 *
 * TP2 is the next target of the method's pool at least TP_STEP_ATR past TP1,
 * TP3 the expected-move edge or the method's own (max pain) past TP2. A pool
 * with nothing in it falls back to the next real level of any kind; nothing
 * at all past the zone, TP1 is 2R and says so. Never an invented TP2/TP3.
 */
export function pickTargets(spec: TargetSpec, levels: readonly Level[], i: {
  dir: 1 | -1; a: number; entry: number; risk: number; ownTp3?: { price: number; why: string }; emEdge: number | null; minRr?: number; maxRr?: number;
}): { tp1: number; tp2: number | null; tp3: number | null; why: string[] } {
  const { dir, a } = i;
  const minRr = i.minRr ?? MIN_RR;
  const maxRr = i.maxRr ?? MAX_TP1_R;
  const why: string[] = [];
  const rOf = (l: { price: number }) => (i.risk > 0 ? Math.abs(l.price - i.entry) / i.risk : 0);
  const pays = (l: Level) => i.risk > 0 && rOf(l) >= minRr;
  const inBand = (l: Level) => pays(l) && rOf(l) <= maxRr;
  const fallback = i.entry + dir * TP1_FALLBACK_R * i.risk;
  let first: Level | undefined;
  let tp1: number;
  if (spec.tp1 === 'own') {
    // VWAP reversion keeps VWAP whatever it pays: reverting to it is the method.
    first = levels.find((l) => l.kind === 'own') ?? levels[0];
    if (!first) return { tp1: fallback, tp2: null, tp3: null, why: [`${TP1_FALLBACK_R}R -- no level found beyond the entry`] };
    tp1 = first.price;
    why.push(first.why);
  } else {
    const prefer = TP1_KINDS[spec.tp1];
    // A real level between minRr and maxRr, the method's own kind first.
    first = levels.find((l) => prefer.includes(l.kind) && inBand(l)) ?? levels.find(inBand);
    const far = first ? undefined : levels.find(pays);
    if (first) {
      tp1 = first.price;
      const skipped = levels.filter((l) => (l.price - i.entry) * dir < (tp1 - i.entry) * dir && !pays(l)).length;
      why.push(skipped ? `${first.why} (${skipped} nearer under ${minRr}R skipped)` : first.why);
    } else if (far || !levels.length) {
      // Nothing real between minRr and maxRr: TGT1 at TP1_FALLBACK_R, and a far level is TGT2.
      tp1 = fallback;
      why.push(far ? `${TP1_FALLBACK_R}R -- no level between ${minRr}R and ${maxRr}R (the next, ${far.why}, is ${rOf(far).toFixed(1)}R)`
        : `${TP1_FALLBACK_R}R -- no level found beyond the entry`);
    } else {
      // Every level pays under minRr: the nearest of its kind, and the R:R gate refuses -- never a made-up far target.
      first = levels.find((l) => prefer.includes(l.kind)) ?? levels[0]!;
      tp1 = first.price;
      why.push(first.why);
    }
  }
  const past = (l: { price: number }, ref: number) => (l.price - ref) * dir >= TP_STEP_ATR * a;
  const kinds = TP2_KINDS[spec.tp2];
  const second = levels.find((l) => l !== first && kinds.includes(l.kind) && past(l, tp1)) ?? levels.find((l) => l !== first && past(l, tp1));
  const tp2 = second?.price ?? null;
  if (second) why.push(second.why);
  const ref = tp2 ?? tp1;
  const third = i.ownTp3 && past(i.ownTp3, ref) ? i.ownTp3
    : i.emEdge !== null && past({ price: i.emEdge }, ref) ? { price: i.emEdge, why: `expected-move edge ${fmt(i.emEdge)}` } : null;
  if (third) why.push(third.why);
  return { tp1, tp2, tp3: third?.price ?? null, why };
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

/**
 * The entry zone: never wider than MAX_ZONE_ATR, kept at the edge price
 * reaches first, and wholly on the safe side of the stop -- at least
 * ZONE_STOP_GAP_ATR from it. A retest zone could reach past its own stop
 * (three 1m setups on 30 Sep - 1 Oct 2026, a long with its stop above the
 * zone's low); clamped, a zone left as a sliver has a tiny risk, which the
 * stop band gate refuses.
 */
export function zoneOf(dir: 1 | -1, z0: number, z1: number, stop: number, a: number): { lo: number; hi: number } {
  let lo = dir === 1 ? Math.max(z0, z1 - MAX_ZONE_ATR * a) : z0;
  let hi = dir === 1 ? z1 : Math.min(z1, z0 + MAX_ZONE_ATR * a);
  if (dir === 1) lo = Math.min(hi, Math.max(lo, stop + ZONE_STOP_GAP_ATR * a));
  else hi = Math.max(lo, Math.min(hi, stop - ZONE_STOP_GAP_ATR * a));
  return { lo, hi };
}

function planOf(setup: Setup, spec: TargetSpec, slRule: string, a: number, bars: readonly Candle[], ctx: EntryContext): Plan {
  const dir = setup.dir;
  const [z0, z1] = setup.zone[0] <= setup.zone[1] ? setup.zone : [setup.zone[1], setup.zone[0]];
  // Never wider than MAX_ZONE_ATR, kept at the edge price reaches first.
  const stop = dir === 1 ? setup.stop - STOP_BUFFER_ATR * a : setup.stop + STOP_BUFFER_ATR * a;
  const { lo, hi } = zoneOf(dir, z0, z1, stop, a);
  const entry = fillOf({ entryLo: lo, entryHi: hi }, dir);
  const risk = Math.abs(entry - stop);
  // A level closer than a fifth of an ATR past the zone is not a target, it is the zone.
  const beyond = dir === 1 ? hi + 0.2 * a : lo - 0.2 * a;
  const levels = targetLevels(dir, beyond, bars, ctx, setup.targets);
  const o = ctx.options;
  const emEdge = o && o.emDay !== null ? o.spot + dir * o.emDay : null;
  const { tp1, tp2, tp3, why } = pickTargets(spec, levels, { dir, a, entry, risk, ownTp3: setup.tp3, emEdge, minRr: MIN_RR });
  const reasons = {
    stop: `${slRule} ${fmt(setup.stop)} ${dir === 1 ? '−' : '+'} ${STOP_BUFFER_ATR} ATR`,
    tp1: why[0]!, tp2: tp2 === null ? null : why[1]!, tp3: tp3 === null ? null : why[tp2 === null ? 1 : 2]!,
  };
  return { entryLo: lo, entryHi: hi, stop, tp1, tp2, tp3, tpWhy: why, rr: rrOf(entry, stop, tp1), why: reasons };
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

  // The plan against the price now: the live trade where it is fresh, else the entry timeframe's last close.
  const px = ctx.ltp && ctx.now - ctx.ltp.at <= LTP_FRESH_MS ? ctx.ltp.price : i.bars[i.bars.length - 1]!.close;
  const problem = planProblem(plan, dir, px, a);
  g('plan', 'Plan valid', `stop on the losing side, TGT1 not yet reached, entry within ${PLAN_MAX_AWAY_ATR} ATR of the price`,
    problem === null ? 'valid' : 'not valid', problem === null, problem);

  g('spread', 'Spread', `perp spread ≤ ${SPREAD_MAX_PCT}%`,
    ctx.spreadPct === null ? 'not read' : `${ctx.spreadPct.toFixed(3)}%`,
    ctx.spreadPct === null ? null : ctx.spreadPct <= SPREAD_MAX_PCT,
    `the perpetual's spread is ${ctx.spreadPct?.toFixed(3)}%`);

  // Entry, SL and TP are the perpetual's prices; the mark is the fair-price check on them.
  const q = ctx.quote, last = ctx.ltp;
  const fresh = (at: number | undefined) => at !== undefined && ctx.now - at <= QUOTE_FRESH_MS;
  const offMark = q && last && q.mark && fresh(q.at) && fresh(last.at) ? (100 * Math.abs(last.price - q.mark)) / q.mark : null;
  g('mark', 'Perp at mark', `last trade within ${MARK_MAX_PCT}% of the mark price`,
    offMark === null ? 'not read' : `${offMark.toFixed(3)}% off`,
    offMark === null ? null : offMark <= MARK_MAX_PCT,
    `the last trade is ${offMark?.toFixed(2)}% from the mark price -- a wick, not a level`);

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
export function readMethod(m: MethodDef, mode: Mode, tf: Tf, ctx: EntryContext): MethodRead {
  const entryTf: Tf = mode === 'mtf' ? '5m' : tf;
  const base = { id: m.id, n: m.n, code: m.code ?? String(m.n), name: m.name, group: m.group, summary: m.summary, mode, tf: entryTf };
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
  const plan = planOf(setup, m.targets, m.sl, a, bars, ctx);
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
    // The market it formed in, for the record's R&D -- the same for every method on these bars, so read once.
    ...(state !== 'NO_TRADE' ? { regime: regimeFor(bars, ctx) } : {}),
  };
}

const regimes = new WeakMap<readonly Candle[], Regime>();
const regimeFor = (bars: readonly Candle[], ctx: EntryContext): Regime => {
  let r = regimes.get(bars);
  if (!r) { r = regimeOf(bars, ctx); regimes.set(bars, r); }
  return r;
};

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
 *
 * 2h joined on 6 Oct 2026 at the owner's request, between the two timeframes that did best in the paper log
 * and in the real trades (1h and 4h). It is read exactly as they are -- the same 81 methods, gates, stops and
 * targets on its own bars -- and is not a step of the chain, which stays 4H / 1H / 30m / 15m / 5m / 3m / 1m.
 */
export const SINGLE_TFS: readonly Tf[] = ['3m', '5m', '15m', '30m', '1h', '2h', '4h'];

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
