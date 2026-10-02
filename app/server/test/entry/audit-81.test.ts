import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { planProblem, PLAN_MAX_AWAY_ATR } from '../../src/entry/engine.js';
import { METHODS } from '../../src/entry/methods.js';
import { GateLocked, gateSettings, setGate } from '../../src/entry/gates.js';
import { closePool } from '../../src/db/pool.js';
import { T0, ctxOf, path } from './bars.js';

after(closePool);

/**
 * The 81-method audit (1 Oct 2026): every TRADE plan of every method, both
 * ways, replayed over six months of 5m BTCUSD and checked against the rules a
 * plan must keep. Most held everywhere; these are what did not, each pinned.
 */

// ------------------------------------------------------------ the plan against the price

const A = 100; // one ATR
/** A long: entry 84,000-84,025 (fills at 84,025), stop 83,900, TGT1 84,300. */
const long = { entryLo: 84_000, entryHi: 84_025, stop: 83_900, tp1: 84_300 };
const short = { entryLo: 84_000, entryHi: 84_025, stop: 84_150, tp1: 83_700 };

test('[critical] a plan in play is valid: the stop behind, TGT1 ahead, the price near', () => {
  assert.equal(planProblem(long, 1, 84_050, A), null);
  assert.equal(planProblem(short, -1, 83_980, A), null);
});

test('[critical] a stop on the winning side is refused -- risk as a distance had let it through', () => {
  // Two liquidity-sweep longs in the replay: zone 71,828, stop 72,041 -- above the fill.
  const why = planProblem({ entryLo: 71_828, entryHi: 71_828, stop: 72_041, tp1: 72_238 }, 1, 72_097, A);
  assert.match(why ?? '', /wrong side/);
});

test('[critical] a TGT1 the price has already reached is refused -- the "expired, ran to TGT1" rows', () => {
  // Order-block retest short: zone 67,115-67,159, TGT1 66,920, the price already at 66,482.
  const why = planProblem({ entryLo: 67_115, entryHi: 67_159, stop: 67_244, tp1: 66_920 }, -1, 66_482, 250);
  assert.match(why ?? '', /already reached TGT1/);
  assert.match(planProblem(long, 1, 84_300, A) ?? '', /already reached/, 'at TGT1 exactly is reached');
});

test(`[critical] an entry more than ${PLAN_MAX_AWAY_ATR} ATR behind the price is refused; inside it, or entering at once, is not`, () => {
  assert.match(planProblem({ ...long, tp1: 84_600 }, 1, 84_025 + 2.1 * A, A) ?? '', /ATR from the price/);
  assert.equal(planProblem({ ...long, tp1: 84_600 }, 1, 84_025 + 1.9 * A, A), null);
  // Price already inside or past the zone the trade's way: it fills at once, which is not "behind".
  assert.equal(planProblem(long, 1, 83_990, A), null);
});

test('[critical] Plan valid is a locked gate: listed, on, and cannot be switched off', async () => {
  const plan = (await gateSettings()).find((g) => g.key === 'plan');
  assert.ok(plan && plan.enabled && plan.locked, 'listed, on, locked');
  await assert.rejects(setGate('plan', false), GateLocked);
});

// ------------------------------------------------------------ timeframes, not five-minute bars

const detect = (id: string) => METHODS.find((m) => m.id === id)!.detect;
/** A quiet opening range from 00:00 UTC (the Asia session), then a close out above it. */
function orbBars(step: number) {
  const inRange = 1800 / step;
  const closes = [...Array.from({ length: inRange + 2 }, (_, i) => 84_000 + (i % 2) * 4), 84_200];
  return path(closes, { step, w: 5, volume: 100, t0: T0 }).map((b, i, xs) => (i === xs.length - 1 ? { ...b, volume: 400 } : b));
}

test('[critical] the opening-range breakout reads the same 30 minutes on 3m and 15m as on 5m', () => {
  for (const step of [180, 300, 900]) {
    const s = detect('orb')({ bars: orbBars(step), a: 50, trend: 0, ctx: ctxOf({ now: (T0 + 4 * 3600) * 1000 }) });
    assert.equal(s?.dir, 1, `${step / 60}m: the break is read`);
  }
});

test('on a timeframe longer than the window, the opening range does not form -- null, not a guess', () => {
  const s = detect('orb')({ bars: path([84_000, 84_004, 84_200], { step: 3600, t0: T0 }), a: 50, trend: 0, ctx: ctxOf() });
  assert.equal(s, null);
});

test('the initial-balance break reads the first hour on 3m and 15m as on 5m', () => {
  for (const step of [180, 300, 900]) {
    const inIb = 3600 / step;
    const closes = [...Array.from({ length: inIb + 2 }, (_, i) => 84_000 + (i % 2) * 4), 84_200];
    const bars = path(closes, { step, w: 5, t0: T0 }).map((b, i, xs) => (i === xs.length - 1 ? { ...b, volume: 400 } : b));
    const s = detect('ib-break')({ bars, a: 50, trend: 0, ctx: ctxOf() });
    assert.equal(s?.dir, 1, `${step / 60}m`);
  }
});
