import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyRatio, bodyStrength, closeLocation, levelsFrom, marketState, planFor, scoreFrom, toleranceFor,
  volumeRatio, volumeRead, wickShare, SCORE_WEIGHTS, type StateInput,
} from '../../src/domain/market-state.js';
import type { Candle } from '../../src/market/delta.js';

/*
 * The numbers are the ones off the 15-minute BTCUSD chart the owner sent on
 * 23 September: resistance 86,800, support 86,200, spot 86,554, ATR about 400.
 * Every test below is a bar drawn against those, so a failure reads as a
 * sentence about that chart rather than about an array.
 */
const R = 86_800;
const S = 86_200;
const ATR = 400;

let t = 0;
const bar = (o: number, h: number, l: number, c: number, volume = 100): Candle =>
  ({ time: ++t, open: o, high: h, low: l, close: c, volume });

/** Twenty quiet bars inside the range, so the level and the median volume exist. */
const background = (volume = 100) =>
  Array.from({ length: 20 }, () => bar(86_400, R, S, 86_500, volume));

const input = (bars: Candle[], over: Partial<StateInput> = {}): StateInput => ({
  bars, level: { resistance: R, support: S }, atr: ATR, tick: 0.5, ...over,
});

// ------------------------------------------------------------------ the pieces

test('the level is the highest high and lowest low of the bars before this one', () => {
  const bars = [...background(), bar(86_500, 88_000, 85_000, 87_900)];
  // The bar being formed is left out: a level that includes the bar you are
  // testing against it can never be broken.
  assert.deepEqual(levelsFrom(bars), { resistance: R, support: S });
});

test('the tolerance is a tenth of the ATR, with five ticks under it', () => {
  assert.equal(toleranceFor(400, 0.5), 40);
  assert.equal(toleranceFor(10, 0.5), 2.5, 'the floor holds when the market is quiet');
  assert.equal(toleranceFor(null, 0.5), 2.5);
});

test('volume is measured against the median of the last twenty, not the mean', () => {
  const bars = [...background(100), bar(1, 1, 1, 1, 180)];
  assert.equal(volumeRatio(bars), 1.8);
  // One violent bar in the background must not lift the bar a spike is judged against.
  const withSpike = [...background(100).slice(0, 19), bar(1, 1, 1, 1, 5_000), bar(1, 1, 1, 1, 180)];
  assert.equal(volumeRatio(withSpike), 1.8);
  assert.equal(volumeRatio([bar(1, 1, 1, 1, 10)]), null, 'five bars at least, or it says nothing');
});

test('volume reads as weak, normal, strong or a burst', () => {
  assert.equal(volumeRead(0.8), 'WEAK');
  assert.equal(volumeRead(1.2), 'NORMAL');
  assert.equal(volumeRead(1.6), 'STRONG');
  assert.equal(volumeRead(2.4), 'BURST');
  assert.equal(volumeRead(null), null);
});

test('the candle is measured by where it closed and how much of it is body', () => {
  const strong = bar(86_500, 86_950, 86_480, 86_930);
  assert.ok(closeLocation(strong)! > 0.9, 'closed on its high');
  assert.equal(Math.round(bodyStrength(strong, ATR)! * 100) / 100, 1.08);
  assert.ok(bodyRatio(strong)! > 0.55, 'mostly body, not wick');
  const wicky = bar(86_700, 86_950, 86_650, 86_710);
  assert.ok(wickShare(wicky, 'UP')! > 0.7, 'most of it is the wick above');
  assert.equal(closeLocation(bar(1, 1, 1, 1)), null, 'a bar with no range has no location');
});

test('the weights sum to one, so a confidence is a percentage of something', () => {
  const total = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(total * 1000) / 1000, 1);
  assert.equal(scoreFrom({ levelBreak: 1, volume: 1, candle: 1, retest: 1, flow: 1, mtf: 1, regime: 1 }), 1);
  assert.equal(scoreFrom({ levelBreak: 0, volume: 0, candle: 0, retest: 0, flow: 0, mtf: 0, regime: 0 }), 0);
});

// ------------------------------------------------------------------ the states

test('[critical] price between the levels is a range, and says what would end it', () => {
  const s = marketState(input([...background(), bar(86_500, 86_560, 86_450, 86_500)]));
  assert.equal(s.event, 'RANGE');
  assert.equal(s.side, null);
  assert.equal(s.confirmed, false);
  assert.equal(s.plan, null, 'nothing to plan while it is mid-range');
  assert.match(s.words, /Between 86,200 and 86,800/);
});

test('[critical] near the level is a watch, not a break', () => {
  const s = marketState(input([...background(), bar(86_500, 86_560, 86_480, 86_554)]));
  assert.equal(s.event, 'BREAKOUT_WATCH');
  assert.equal(s.stage, 'WATCH');
  assert.equal(s.confirmed, false, 'a setup is not a fact');
  assert.equal(s.against, R);
  assert.equal(s.distance, -246, 'the card shows how far it has to go');
  assert.match(s.words, /near resistance/);
});

test('[critical] a close through the level without the volume is a candidate, not a breakout', () => {
  const s = marketState(input([...background(100), bar(86_780, 86_900, 86_770, 86_880, 110)]));
  assert.equal(s.event, 'BREAKOUT_CANDIDATE');
  assert.equal(s.stage, 'CANDIDATE');
  assert.equal(s.confirmed, false);
  assert.match(s.words, /without the volume/);
  assert.equal(s.checks.find((c) => c.label.startsWith('Volume'))!.ok, false);
});

test('[critical] a close through with volume, body and a strong close is confirmed', () => {
  const s = marketState(input([...background(100), bar(86_700, 86_930, 86_680, 86_910, 180)], {
    oiChangePct: 2.4, cvdSlope: 1.2, aggressorBuyPct: 61, mtf: { up: 5, down: 2, total: 7 }, regime: 'TREND_UP',
  }));
  assert.equal(s.event, 'BREAKOUT_CONFIRMED');
  assert.equal(s.stage, 'CONFIRMED');
  assert.equal(s.confirmed, true);
  assert.equal(s.side, 'UP');
  assert.ok(s.confidence >= 80, `everything agreeing should read high, was ${s.confidence}`);
  assert.deepEqual(s.plan, { side: 'UP', trigger: R, target1: 87_200, target2: 87_600, invalidation: 86_400 });
});

test('[critical] a wick through that closes back under is a rejection', () => {
  const s = marketState(input([...background(100), bar(86_700, 86_920, 86_600, 86_610, 170)]));
  assert.equal(s.event, 'REJECTION');
  assert.equal(s.stage, 'FAILED');
  assert.equal(s.side, 'DOWN', 'the news is that it is going the other way');
  assert.match(s.words, /Tested 86,800 and closed back under/);
});

test('[critical] a break that closes back under next bar is a false breakout, not a range', () => {
  /*
   * The branch that matters most. This bar satisfies "close below resistance"
   * exactly like a quiet mid-range bar does, and reading it as one is the
   * whole cost of the trade -- so the failure is checked before the range.
   */
  const bars = [...background(100), bar(86_700, 86_950, 86_690, 86_910, 180), bar(86_900, 86_920, 86_650, 86_700, 150)];
  const s = marketState(input(bars));
  assert.equal(s.event, 'FALSE_BREAKOUT');
  assert.equal(s.stage, 'FAILED');
  assert.equal(s.side, 'DOWN');
  assert.match(s.words, /closed back under it: the break failed/);
});

test('a second close above the level is the retest holding', () => {
  const bars = [...background(100), bar(86_700, 86_930, 86_680, 86_910, 180), bar(86_900, 86_960, 86_820, 86_930, 120)];
  const s = marketState(input(bars));
  assert.equal(s.event, 'RETEST_HOLD');
  assert.equal(s.stage, 'RETEST');
  assert.equal(s.parts.retest, 1);
  assert.equal(s.confirmed, true);
});

test('[critical] a close under support with the tape behind it is a breakdown', () => {
  const s = marketState(input([...background(100), bar(86_300, 86_320, 86_060, 86_080, 190)], {
    oiChangePct: 3.1, cvdSlope: -0.8, aggressorBuyPct: 39, mtf: { up: 2, down: 6, total: 9 },
  }));
  assert.equal(s.event, 'BREAKDOWN_CONFIRMED');
  assert.equal(s.side, 'DOWN');
  assert.equal(s.confirmed, true);
  assert.deepEqual(s.plan, { side: 'DOWN', trigger: S, target1: 85_800, target2: 85_400, invalidation: 86_600 });
});

test('a poke under support that closes back over is a support rejection', () => {
  const s = marketState(input([...background(100), bar(86_300, 86_480, 86_120, 86_460, 160)]));
  assert.equal(s.event, 'SUPPORT_REJECTION');
  assert.equal(s.side, 'UP');
});

test('a breakdown reclaimed next bar is a false breakdown', () => {
  const bars = [...background(100), bar(86_250, 86_260, 86_050, 86_080, 180), bar(86_090, 86_400, 86_080, 86_380, 150)];
  const s = marketState(input(bars));
  assert.equal(s.event, 'FALSE_BREAKDOWN');
  assert.equal(s.side, 'UP');
  assert.match(s.words, /reclaimed it/);
});

// ------------------------------------------------------------------ the score

test('[critical] the same break scores lower when the flow does not agree', () => {
  const bars = [...background(100), bar(86_700, 86_930, 86_680, 86_910, 180)];
  const agreeing = marketState(input(bars, {
    oiChangePct: 2.4, cvdSlope: 1.2, aggressorBuyPct: 61, mtf: { up: 5, down: 2, total: 7 }, regime: 'TREND_UP',
  }));
  const alone = marketState(input(bars, {
    oiChangePct: -1, cvdSlope: -0.4, aggressorBuyPct: 42, mtf: { up: 1, down: 5, total: 7 }, regime: 'TREND_DOWN',
  }));
  assert.equal(agreeing.event, alone.event, 'the same state either way');
  assert.ok(alone.confidence <= agreeing.confidence - 20, `${alone.confidence} vs ${agreeing.confidence}`);
});

test('what could not be measured scores nothing rather than being hidden', () => {
  const bars = [...background(100), bar(86_700, 86_930, 86_680, 86_910, 180)];
  const blind = marketState(input(bars));
  assert.equal(blind.parts.flow, 0);
  assert.equal(blind.parts.mtf, 0);
  assert.equal(blind.parts.regime, 0);
  for (const label of ['Open interest building', 'Timeframes agree']) {
    assert.equal(blind.checks.find((c) => c.label === label)!.ok, null, `${label} is unknown, not false`);
  }
});

test('a plan needs an ATR: a level with no volatility behind it gets none', () => {
  assert.equal(planFor('UP', R, null), null);
  assert.equal(planFor('UP', R, 0), null);
});

test('no bars at all is a quiet range, not a crash', () => {
  const s = marketState({ bars: [], level: { resistance: null, support: null }, atr: null });
  assert.equal(s.event, 'RANGE');
  assert.equal(s.confidence, 0);
  assert.deepEqual(s.checks, []);
});
