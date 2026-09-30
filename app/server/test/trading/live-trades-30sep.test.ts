import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorExits, type TradeRecord } from '../../src/trading/engine.js';
import { orderPlan } from '../../src/trading/order-plan.js';
import { slippageOf } from '../../src/trading/money.js';

/**
 * The desk's six live trades of 30 Sep 2026, replayed through the functions
 * that priced them: the numbers below are the production journal's
 * (`trades`, `trade_events`, `strategy_runs`), read on the day.
 *
 * Three strategies (15:29, 15:55, 17:01), each "at most $42, else at most
 * $70", entry at the offer walking to the bid, stop 185%, target 99% -- two
 * legs of ten lots. If a change to the exits would have priced any of these
 * differently, this is where it shows.
 */

type Live = {
  leg: string; cp: 'CE' | 'PE'; strike: number;
  /** The bid the strike was chosen at, and the offer the entry rested at. */
  bid: number; ask: number;
  fill: number; sl: number; tp: number;
  exit: number; how: 'target' | 'manual';
};

const DAY: Live[] = [
  { leg: '15:29 CE 84000', cp: 'CE', strike: 84_000, bid: 29.2, ask: 36, fill: 29.2, sl: 83.2, tp: 0.3, exit: 75, how: 'manual' },
  { leg: '15:29 PE 83200', cp: 'PE', strike: 83_200, bid: 15.2, ask: 16, fill: 15.2, sl: 43.3, tp: 0.2, exit: 0.2, how: 'target' },
  { leg: '15:55 CE 84200', cp: 'CE', strike: 84_200, bid: 18.2, ask: 20, fill: 20, sl: 57, tp: 0.2, exit: 0.2, how: 'target' },
  { leg: '15:55 PE 83400', cp: 'PE', strike: 83_400, bid: 15.3, ask: 20, fill: 20, sl: 57, tp: 0.2, exit: 0.2, how: 'target' },
  { leg: '17:01 CE 84000', cp: 'CE', strike: 84_000, bid: 5, ask: 6, fill: 6, sl: 17.1, tp: 0.1, exit: 0.1, how: 'target' },
  { leg: '17:01 PE 83800', cp: 'PE', strike: 83_800, bid: 36, ask: 39, fill: 42, sl: 119.7, tp: 0.4, exit: 0.4, how: 'target' },
];

const EXPIRY = 1_790_768_000;

function replay(t: Live): TradeRecord {
  const plan = orderPlan({
    symbol: `${t.cp[0]}-BTC-${t.strike}-300926`, optionSide: t.cp, strike: t.strike, expiryTs: EXPIRY, lots: 10,
    limitPrice: t.ask, chaseSeconds: 5, maxCrossSpreadPct: 0.15, stopLossPct: 1.85, takeProfitPct: 0.99,
    strategyId: 'replay', origin: 'strategy',
  }, `replay-${t.leg}`);
  const rec = { plan, state: { entryAvgPrice: t.fill, wantsProtection: true }, events: [] } as unknown as TradeRecord;
  return anchorExits(rec);
}

for (const t of DAY) {
  test(`[critical] ${t.leg}: sold at ${t.fill}, SL ${t.sl}, target ${t.tp} -- as the desk priced it`, () => {
    const r = replay(t);
    assert.equal(r.plan.stopPrice, t.sl, 'stop: 185% over the actual fill');
    assert.equal(r.plan.takeProfitPrice, t.tp, 'target: 1% of the actual fill, never under a tick');
    assert.ok(r.plan.stopPrice! > t.fill && r.plan.takeProfitPrice! < t.fill, 'a short: stop over the entry, target under it');
    assert.ok(t.fill >= t.bid, 'a sell never fills under the bid it was chosen at');
    if (t.how === 'target') assert.equal(slippageOf('take_profit', t.tp, t.exit)!.points, 0, 'bought back at exactly the target');
    else assert.ok(t.exit < t.sl, 'closed by hand before the stop was reached');
  });
}

test('[critical] 17:01 PE 83800: the 39 limit filled at 42 -- a sell limit fills at its price or better, and the exits follow the fill', () => {
  const t = DAY[5]!;
  const onLimit = orderPlan({
    symbol: 'P-BTC-83800-300926', optionSide: 'PE', strike: 83_800, expiryTs: EXPIRY, lots: 10,
    limitPrice: 39, chaseSeconds: 5, stopLossPct: 1.85, takeProfitPct: 0.99,
  }, 'limit-only');
  assert.equal(onLimit.stopPrice, 111.2, 'first read off the 39 limit');
  assert.equal(replay(t).plan.stopPrice, 119.7, 're-read off the 42 fill');
});

test('the day in points: five targets and one hand close, 10 lots each', () => {
  const points = DAY.map((t) => Math.round((t.fill - t.exit) * 10) / 10);
  assert.deepEqual(points, [-45.8, 15, 19.8, 19.8, 5.9, 41.6]);
});
