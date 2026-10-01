import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetFor, stopFor, protectionFor } from '../../src/trading/order-plan.js';
import { targetTickFor } from '../../src/trading/money.js';
import { rig, ceProduct, planFor, quote } from './harness.js';

/**
 * Where the exits land, over every entry the desk can sell at (1 Oct 2026 audit).
 *
 * Every position is a short, so a target must sit under the entry and a stop
 * over it, both on the 0.1 tick. Rounding could put either on the entry itself:
 * a target on a 0.1 entry (nothing under it but zero), anything asked for in
 * less than a tick, a 10% stop on a 0.1-0.4 premium. A target on the entry buys
 * back at the price sold -- nothing earned, fees paid twice -- and a stop on it
 * is reached by the offer the moment the entry fills.
 *
 * The sweep below is the probe that found them, kept as the test: 1,000 entry
 * prices, each also half a tick over (the average of fills at two prices), on
 * every percentage and every distance in points.
 */

const TARGET_PCTS = [0.01, 0.05, 0.1, 0.25, 0.5, 0.8, 0.9, 0.95, 0.99];
const STOP_PCTS = [0.01, 0.05, 0.1, 0.5, 1, 1.85, 2, 5, 20];
const POINTS = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 55, 500];

const entries = (): number[] => {
  const out: number[] = [];
  for (let i = 1; i <= 1000; i++) out.push(i / 10, Math.round((i / 10 + 0.05) * 100) / 100);
  return out;
};

const onTick = (p: number) => Math.abs(p * 10 - Math.round(p * 10)) < 1e-9;

test('[critical] a target is under the entry and on the tick, or there is none -- every entry, every ask', () => {
  const bad: string[] = [];
  for (const e of entries()) {
    const asks = [
      ...TARGET_PCTS.map((p) => ({ takeProfitPct: p })),
      ...POINTS.map((q) => ({ takeProfitPoints: q })),
    ];
    for (const ask of asks) {
      const t = targetFor(e, ask);
      if (t === null) { if (e > 0.1 + 1e-9) bad.push(`${e} ${JSON.stringify(ask)}: none, though ticks lie under it`); continue; }
      if (!(t < e) || t < 0.1 || !onTick(t)) bad.push(`${e} ${JSON.stringify(ask)} -> ${t}`);
      const placed = targetTickFor(t, 0.1, e);
      if (placed === null || !(placed < e)) bad.push(`${e} ${JSON.stringify(ask)} placed at ${placed}`);
    }
  }
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} bad targets`);
});

test('[critical] a stop is over the entry and on the tick -- every entry, every ask', () => {
  const bad: string[] = [];
  for (const e of entries()) {
    const asks = [
      ...STOP_PCTS.map((p) => ({ stopLossPct: p })),
      ...POINTS.map((q) => ({ stopLossPoints: q })),
    ];
    for (const ask of asks) {
      const s = stopFor(e, ask);
      if (s === null || !(s > e) || !onTick(s)) bad.push(`${e} ${JSON.stringify(ask)} -> ${s}`);
    }
  }
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} bad stops`);
});

test('[critical] the cases the sweep found, by name', () => {
  assert.equal(targetFor(0.1, { takeProfitPct: 0.95 }), null, 'nothing under a 0.1 entry but zero: no target');
  assert.equal(targetFor(0.1, { takeProfitPoints: 5 }), null);
  assert.equal(targetFor(5, { takeProfitPoints: 0.05 }), 4.9, 'less than a tick asked: one tick under');
  assert.equal(stopFor(0.3, { stopLossPct: 0.1 }), 0.4, '10% of 0.3 rounds onto the entry: one tick over');
  assert.equal(stopFor(2.3, { stopLossPoints: 0.05 }), 2.4);
  assert.equal(targetTickFor(0.05, 0.1, 0.1), null, 'the engine will not rest a target on the entry either');
});

test('the levels the desk actually trades are unchanged (30 Sep 2026, the six live trades)', () => {
  // 185% stop, 99% target, re-read off the fill: 42 -> 119.7 / 0.4.
  assert.deepEqual(protectionFor(42, { stopLossPct: 1.85, takeProfitPct: 0.99 }), { stopPrice: 119.7, takeProfitPrice: 0.4 });
  assert.deepEqual(protectionFor(19.82, { stopLossPct: 1.85, takeProfitPct: 0.99 }), { stopPrice: 56.5, takeProfitPrice: 0.2 });
  assert.deepEqual(protectionFor(15, { stopLossPoints: 10, takeProfitPoints: 10 }), { stopPrice: 25, takeProfitPrice: 5 });
});

test('[critical] a one-tick fill keeps its stop and gets no target, rather than one on the entry', () => {
  // Sold at 0.1: the only way down is to zero, which is settlement, not a buy-back.
  // These are the levels `anchorExits` writes onto the plan once the fill is known.
  assert.deepEqual(protectionFor(0.1, { takeProfitPct: 0.95, stopLossPct: 1 }), { takeProfitPrice: null, stopPrice: 0.2 });
});

test('a target typed as a price on the entry is refused before anything is sent', async () => {
  // The other road to the same place, already shut by the precheck: kept so it stays shut.
  const CE = ceProduct().symbol;
  const r = rig({ quotes: [quote(CE, 0.1, 0.2)] });
  const plan = planFor(ceProduct(), {
    lots: 10,
    entry: { type: 'limit', limitPrice: 0.1, timeoutMs: 5_000, marketFallback: false },
    takeProfitPrice: 0.1, stopPrice: 0.3, minPremiumUsd: 0.1,
  });
  const opened = await r.engine.open(plan);
  assert.equal(opened.ok, false);
  assert.ok(!opened.ok && opened.precheck.failures.some((f) => f.code === 'EXIT_WRONG_SIDE_OF_ENTRY'));
  assert.deepEqual(await r.ex.getOpenOrders(CE), [], 'nothing reached the book');
});
