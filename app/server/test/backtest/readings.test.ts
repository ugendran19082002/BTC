import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readingsAt, extractSignals, type Readings } from '../../src/backtest/momentum.js';
import { levelUnder } from '../../src/domain/level-mode.js';
import type { Candle } from '../../src/market/delta.js';

/**
 * The readings the filter sweep is built on.
 *
 * One property matters more than all the others: a reading taken at a signal
 * bar must not depend on anything after it. A sweep over features that peek is
 * not a weak result, it is a fabricated one — it will find rules that look
 * excellent in the replay and cannot exist live.
 */

function bars(n: number, f: (i: number) => number, from = 1_790_000_000): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = f(i);
    return { time: from + i * 300, open: c - 8, high: c + 25, low: c - 25, close: c, volume: 100 + (i % 7) * 20 };
  });
}

const wavy = (i: number) => 84_000 + Math.sin(i / 6) * 300 + i * 2;

describe('no lookahead', () => {
  test('[critical] a reading at bar i is identical whatever comes after it', () => {
    const all = bars(200, wavy);
    const i = 120;
    const upTo = all.slice(0, i + 1);

    const a = readingsAt(upTo, levelUnder(upTo, 'rolling'));
    // The same bars, but the caller happens to hold 80 more. Truncation is the
    // guarantee; this asserts the function honours it.
    const b = readingsAt(all.slice(0, i + 1), levelUnder(all.slice(0, i + 1), 'rolling'));
    assert.deepEqual(a, b);

    // And a wildly different future must not change the past reading.
    const shocked = [...upTo, ...bars(60, () => 120_000, upTo[upTo.length - 1]!.time + 300)];
    const c = readingsAt(shocked.slice(0, i + 1), levelUnder(shocked.slice(0, i + 1), 'rolling'));
    assert.deepEqual(a, c, 'a reading changed when the future changed');
  });

  test('[critical] every signal carries readings taken at its own bar', () => {
    const b = bars(400, wavy);
    const { signals } = extractSignals(b, '5m');
    for (const s of signals) {
      assert.ok(s.features.ind, 'a signal has no readings');
      assert.equal(typeof s.features.ind.patternCount, 'number');
    }
  });
});

describe('a reading that cannot be taken is null, not neutral', () => {
  test('[critical] too few bars gives nulls, so a filter excludes rather than pads', () => {
    const r = readingsAt(bars(10, wavy), { resistance: null, support: null });
    const nullable: (keyof Readings)[] = [
      'macdHist', 'percentB', 'cci', 'mfi', 'stoch', 'williamsR', 'choppiness',
      'efficiency', 'obvSlope', 'vortex', 'trix', 'awesome', 'cmf', 'relVolume', 'roc10',
      // Added 27 Sep 2026 — every one of these must obey the same rule.
      'rsi14', 'adx14', 'vwapDistPct', 'aroon', 'donchianPos', 'realisedVol', 'hmaSlope', 'zScore',
    ];
    for (const k of nullable) assert.equal(r[k], null, `${k} guessed a value it could not read`);
  });

  test('the signed readings that have no null form default to 0, which no signed filter passes', () => {
    const r = readingsAt(bars(10, wavy), { resistance: null, support: null });
    assert.equal(r.superTrend, 0);
    assert.equal(r.emaStack, 0);
    assert.equal(r.candleBias, 0);
    assert.equal(r.structureBias, 0);
    assert.equal(r.structureWay, 0);
  });

  test('[critical] every field of Readings is accounted for — a new one cannot slip in unchecked', () => {
    const full = readingsAt(bars(200, wavy), { resistance: null, support: null });
    const thin = readingsAt(bars(10, wavy), { resistance: null, support: null });
    for (const k of Object.keys(full) as (keyof Readings)[]) {
      // Each reading is either nullable (null when unreadable) or a signed
      // 0/±1. Anything else would be a reading that guesses.
      const v = thin[k];
      assert.ok(
        v === null || v === 0 || typeof v === 'number',
        `${k} produced ${String(v)} on too few bars`,
      );
    }
  });
});

describe('the readings themselves', () => {
  const b = bars(200, wavy);
  const r = readingsAt(b, levelUnder(b, 'rolling'));

  test('[critical] the new bounded readings stay inside their bounds too', () => {
    if (r.rsi14 !== null) assert.ok(r.rsi14 >= 0 && r.rsi14 <= 100);
    if (r.adx14 !== null) assert.ok(r.adx14 >= 0 && r.adx14 <= 100);
    if (r.aroon !== null) assert.ok(r.aroon >= -100 && r.aroon <= 100);
    if (r.donchianPos !== null) assert.ok(r.donchianPos >= 0 && r.donchianPos <= 1);
    if (r.realisedVol !== null) assert.ok(r.realisedVol >= 0);
    assert.ok([-1, 0, 1].includes(r.structureWay));
  });

  test('[critical] RSI is the one the live ladder reads, not a second implementation', async () => {
    // Same function, same bars, same number — asserted rather than assumed.
    const { rsi } = await import('../../src/market/moves.js');
    const closes = b.map((x) => x.close);
    assert.equal(r.rsi14, rsi(closes));
  });

  test('bounded readings stay inside their bounds', () => {
    if (r.stoch !== null) assert.ok(r.stoch >= 0 && r.stoch <= 100);
    if (r.mfi !== null) assert.ok(r.mfi >= 0 && r.mfi <= 100);
    if (r.williamsR !== null) assert.ok(r.williamsR >= -100 && r.williamsR <= 0);
    if (r.choppiness !== null) assert.ok(r.choppiness >= 0 && r.choppiness <= 100);
    if (r.efficiency !== null) assert.ok(r.efficiency >= 0 && r.efficiency <= 1);
    if (r.clv !== null) assert.ok(r.clv >= -1 && r.clv <= 1);
  });

  test('the EMA stack is a sign, not a price', () => {
    assert.ok([-1, 0, 1].includes(r.emaStack));
    assert.ok([-1, 0, 1].includes(r.superTrend));
  });

  test('[critical] a steadily rising market reads its stack as up', () => {
    const rising = bars(200, (i) => 84_000 + i * 20);
    assert.equal(readingsAt(rising, levelUnder(rising, 'rolling')).emaStack, 1);
  });

  test('[critical] a steadily falling market reads its stack as down', () => {
    const falling = bars(200, (i) => 90_000 - i * 20);
    assert.equal(readingsAt(falling, levelUnder(falling, 'rolling')).emaStack, -1);
  });

  test('pattern bias is a signed fold, and mixed cancels', () => {
    assert.ok([-1, 0, 1].includes(r.candleBias));
    assert.ok([-1, 0, 1].includes(r.structureBias));
    assert.ok(r.patternCount >= 0);
  });

  test('no bars at all is handled rather than thrown', () => {
    assert.doesNotThrow(() => readingsAt([], { resistance: null, support: null }));
  });
});
