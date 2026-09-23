import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIAS_WEIGHTS, NEUTRAL_BAND, biasFrom, type BiasInput } from '../../src/domain/bias.js';
import type { Pattern } from '../../src/domain/patterns.js';
import type { Indicator } from '../../src/domain/indicators.js';

/*
 * The one question a chart is opened to answer is which way, and the desk
 * knows a hundred things at once. This is the vote that turns them into a
 * word -- and the reason it is a vote, and says so, is that it is not a
 * probability and must never be shown as one.
 */

const pattern = (over: Partial<Pattern> = {}): Pattern =>
  ({ name: 'Higher Lows', bias: 'BULLISH', kind: 'structure', note: '', barsAgo: 0, ...over });
const reading = (over: Partial<Indicator> = {}): Indicator =>
  ({ key: 'rsi', label: 'RSI (14)', value: 62, text: '62', read: 'Bullish', bias: 'BULLISH', gauge: 0.62, ...over });

const input = (over: Partial<BiasInput> = {}): BiasInput => ({
  state: null, patterns: [], indicators: [], mtf: null,
  oiChangePct: null, cvdSlope: null, aggressorBuyPct: null, regime: null, ...over,
});

test('[critical] nothing measured is not a call in either direction', () => {
  // The honest answer to an empty board is "no idea", and a badge that says UP
  // on no evidence is worse than no badge.
  const r = biasFrom(input());
  assert.equal(r.side, 'NEUTRAL');
  assert.equal(r.strength, 0);
  assert.deepEqual(r.reasons, []);
});

test('[critical] evenly split is neutral, however much evidence there is', () => {
  const r = biasFrom(input({
    patterns: [pattern(), pattern({ name: 'Lower Highs', bias: 'BEARISH' })],
    indicators: [reading(), reading({ key: 'macd', label: 'MACD', bias: 'BEARISH' })],
  }));
  assert.equal(r.side, 'NEUTRAL');
  assert.ok(r.strength < NEUTRAL_BAND);
  assert.ok(r.up > 0 && r.down > 0, 'both sides are still counted and shown');
});

test('[critical] the weight is where the evidence is, not where it is loudest', () => {
  /*
   * Six timeframes agreeing outranks one candle shape. A confirmed state --
   * the market having actually done something -- outranks a drawing.
   */
  const timeframes = biasFrom(input({ mtf: { up: 6, down: 0, total: 6 } }));
  const candle = biasFrom(input({ patterns: [pattern({ kind: 'candle', name: 'Hammer' })] }));
  assert.equal(timeframes.side, 'UP');
  assert.equal(candle.side, 'UP');
  assert.ok(timeframes.up > candle.up);

  const confirmed = biasFrom(input({ state: { side: 'UP', confirmed: true, event: 'BREAKOUT_CONFIRMED' } }));
  const watching = biasFrom(input({ state: { side: 'UP', confirmed: false, event: 'BREAKOUT_WATCH' } }));
  assert.equal(confirmed.up, BIAS_WEIGHTS.state);
  assert.equal(watching.up, BIAS_WEIGHTS.state / 2, 'a setup is half of a fact');
});

test('a pattern fades with the bars behind it', () => {
  // A hammer three bars back is a fact about three bars back.
  const now = biasFrom(input({ patterns: [pattern({ barsAgo: 0 })] }));
  const older = biasFrom(input({ patterns: [pattern({ barsAgo: 3 })] }));
  assert.ok(older.up < now.up);
  assert.ok(older.up > 0, 'it is faded, not forgotten');
});

test('[critical] a reading that could not be taken votes for nobody', () => {
  // Counting an unmeasured indicator as agreement is how a badge ends up
  // confident about a feed that is down.
  const r = biasFrom(input({ indicators: [reading({ value: null, text: '—' })] }));
  assert.equal(r.side, 'NEUTRAL');
  assert.equal(r.up, 0);
});

test('four of six timeframes counts for less than six of six', () => {
  const some = biasFrom(input({ mtf: { up: 4, down: 2, total: 6 } }));
  const all = biasFrom(input({ mtf: { up: 6, down: 0, total: 6 } }));
  assert.ok(some.up < all.up);
  assert.equal(some.side, 'UP');
});

test('the tape and the board are heard, and only when they are saying something', () => {
  const quiet = biasFrom(input({ aggressorBuyPct: 51, cvdSlope: 0 }));
  assert.equal(quiet.side, 'NEUTRAL', 'a 51/49 split is not a direction');
  const buying = biasFrom(input({ aggressorBuyPct: 62, cvdSlope: 140 }));
  assert.equal(buying.side, 'UP');
  assert.ok(buying.reasons.some((r) => r.text.includes('offer')));
});

test('[critical] the strength is the lean, and it is never dressed as a probability', () => {
  /*
   * Seventy here means seven tenths of the weight pointed one way just now.
   * Whether that goes on to happen seven times in ten is a different question
   * and needs the matched-state history to answer.
   */
  const r = biasFrom(input({
    state: { side: 'DOWN', confirmed: true, event: 'BREAKDOWN_CONFIRMED' },
    mtf: { up: 1, down: 5, total: 6 },
    regime: 'TREND_DOWN',
    patterns: [pattern({ name: 'Lower Highs', bias: 'BEARISH' })],
  }));
  assert.equal(r.side, 'DOWN');
  assert.equal(r.strength, Math.round((Math.abs(r.up - r.down) / (r.up + r.down)) * 100));
  assert.equal(r.strength, 100, 'nothing argued the other way');
  assert.ok(r.reasons.length > 0 && r.reasons.length <= 4);
  assert.ok(r.reasons.every((x) => x.side === 'DOWN'), 'the badge does not argue with itself');
});
