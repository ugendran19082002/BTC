import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ladder, readiness, TIER_OF, TIER_WEIGHT, DEAD_BAND, ADX_TRENDING, type Row,
} from '../../src/domain/hierarchy.js';
import type { TimeframeRead, Timeframe } from '../../src/market/moves.js';

/** A readable frame, pointing the way asked, with everything else neutral unless overridden. */
function frame(tf: Timeframe, way: 'up' | 'down' | 'flat', over: Partial<TimeframeRead> = {}): TimeframeRead {
  const dir = way === 'up' ? 1 : way === 'down' ? -1 : 0;
  return {
    tf,
    bars: 220,
    close: 84_000,
    ema9: null,
    ema21: null,
    ema50: null,
    rsi14: way === 'up' ? 62 : way === 'down' ? 38 : 50,
    rsiSlope: null,
    adx14: 25,
    vwap: 84_000,
    vwapDistPct: 0,
    structure: dir as -1 | 0 | 1,
    resistance: [],
    support: [],
    atrPct: 0.5,
    trend: dir as -1 | 0 | 1,
    label: way,
    ...over,
  };
}

const rowFor = (l: ReturnType<typeof ladder>, tf: Timeframe): Row =>
  l.rows.find((r) => r.tf === tf) ?? assert.fail(`no row for ${tf}`);

describe('the tier of each frame', () => {
  test('[critical] every frame New.md names has a job, and 1M\'s job carries no weight', () => {
    assert.equal(TIER_OF['12h'], 'direction');
    assert.equal(TIER_OF['6h'], 'direction');
    assert.equal(TIER_OF['4h'], 'structure');
    assert.equal(TIER_OF['2h'], 'structure');
    assert.equal(TIER_OF['1h'], 'setup');
    assert.equal(TIER_OF['30m'], 'setup');
    assert.equal(TIER_OF['15m'], 'pattern');
    assert.equal(TIER_OF['5m'], 'trigger');
    assert.equal(TIER_OF['1m'], 'execution');
    assert.equal(TIER_WEIGHT.execution, 0);
  });

  test('the setup tier is lighter than direction, structure, pattern and trigger', () => {
    assert.ok(TIER_WEIGHT.setup < TIER_WEIGHT.direction);
    assert.ok(TIER_WEIGHT.setup < TIER_WEIGHT.structure);
    assert.ok(TIER_WEIGHT.setup < TIER_WEIGHT.pattern);
    assert.ok(TIER_WEIGHT.setup < TIER_WEIGHT.trigger);
  });
});

describe('the weighted read', () => {
  test('[critical] a 1M candle cannot flip a 12H bias — the thing equal votes got wrong', () => {
    // Everything slow says DOWN; the execution frame screams UP.
    const down = ladder([
      frame('12h', 'down'), frame('6h', 'down'), frame('4h', 'down'),
      frame('1m', 'up', { rsi14: 90 }),
    ]);
    assert.equal(down.bias, 'DOWN');
    // And it contributed nothing at all, rather than a little.
    assert.equal(rowFor(down, '1m').weight, 0);
    assert.equal(down.against.includes('1m'), false);
  });

  test('[critical] five fast frames up against four slow ones down is not UP', () => {
    /*
     * Under a flat majority this is 5 rows up against 4 down and prints UP.
     * Weighted it is 10 up against 12 down -- near enough balanced that the
     * honest answer is neither, which is what the dead band is for. The
     * property being pinned is that it is *not* the fast frames' answer.
     */
    const l = ladder([
      frame('12h', 'down'), frame('6h', 'down'), frame('4h', 'down'), frame('2h', 'down'),
      frame('1h', 'up'), frame('30m', 'up'), frame('15m', 'up'), frame('5m', 'up'), frame('1m', 'up'),
    ]);
    assert.notEqual(l.bias, 'UP');
    assert.equal(l.bias, 'SIDE');
    assert.ok(l.score < 0, 'the weight still leans the slow frames\' way');
  });

  test('[critical] once the slow frames clearly outweigh the fast ones, they win outright', () => {
    // direction 3+3 + structure 3+3 = 12 down against pattern 3 + trigger 3 = 6 up.
    const l = ladder([
      frame('12h', 'down'), frame('6h', 'down'), frame('4h', 'down'), frame('2h', 'down'),
      frame('15m', 'up'), frame('5m', 'up'), frame('1m', 'up'),
    ]);
    assert.equal(l.bias, 'DOWN');
    assert.deepEqual(l.against, ['15m', '5m']);
  });

  test('a frame with no side at all contributes nothing and is not counted against', () => {
    const l = ladder([frame('12h', 'down'), frame('6h', 'flat')]);
    assert.equal(rowFor(l, '6h').way, 'SIDE');
    assert.equal(l.against.length, 0);
  });

  test('[critical] an unreadable frame is absent, never a vote for SIDE', () => {
    const l = ladder([frame('12h', 'down'), frame('6h', 'down')]);
    assert.equal(l.rows.length, 2);
    assert.equal(l.rows.some((r) => r.tf === '4h'), false);
    assert.equal(l.bias, 'DOWN');
  });

  test('conviction scales the vote: one indicator out of four counts less than four of four', () => {
    const whole = ladder([frame('12h', 'down', { vwapDistPct: -1 })]);
    // trend flat, rsi neutral, structure flat, vwap below: one vote of four.
    const partial = ladder([frame('12h', 'flat', { vwapDistPct: -1 })]);
    assert.ok(Math.abs(whole.score) > Math.abs(partial.score));
    assert.equal(rowFor(whole, '12h').conviction, 1);
    assert.equal(rowFor(partial, '12h').conviction, 1 / 4);
  });

  test('VWAP inside a tenth of a percent is noise and does not get a vote', () => {
    const near = ladder([frame('12h', 'flat', { vwapDistPct: 0.05 })]);
    assert.equal(near.rows[0]!.way, 'SIDE');
    const far = ladder([frame('12h', 'flat', { vwapDistPct: 0.5 })]);
    assert.equal(far.rows[0]!.way, 'UP');
  });

  test('[critical] a near-balanced book reads SIDE rather than a weak direction', () => {
    const l = ladder([frame('12h', 'up'), frame('6h', 'down')]);
    assert.equal(l.bias, 'SIDE');
    assert.ok(Math.abs(l.normalised) <= DEAD_BAND);
    assert.match(l.text, /no side/);
  });

  test('normalised is bounded and signed the way the market is', () => {
    const up = ladder([frame('12h', 'up'), frame('6h', 'up'), frame('5m', 'up')]);
    assert.ok(up.normalised > 0 && up.normalised <= 1);
    const down = ladder([frame('12h', 'down'), frame('6h', 'down'), frame('5m', 'down')]);
    assert.ok(down.normalised < 0 && down.normalised >= -1);
  });

  test('rows come back coarsest first, whatever order they arrived in', () => {
    const l = ladder([frame('5m', 'up'), frame('12h', 'up'), frame('1h', 'up')]);
    assert.deepEqual(l.rows.map((r) => r.tf), ['12h', '1h', '5m']);
  });

  test('the text names how much weight agreed, not how many rows', () => {
    const l = ladder([frame('12h', 'down'), frame('6h', 'down'), frame('1h', 'up')]);
    assert.match(l.text, /of \d+ weight/);
  });

  test('every disagreeing frame is named — the read never hides its dissent', () => {
    const l = ladder([frame('12h', 'down'), frame('6h', 'down'), frame('4h', 'down'), frame('15m', 'up')]);
    assert.equal(l.bias, 'DOWN');
    assert.deepEqual(l.against, ['15m']);
  });
});

describe('whether the ladder allows a trade', () => {
  const aligned = [
    frame('12h', 'down'), frame('6h', 'down'), frame('4h', 'down'), frame('2h', 'down'),
    frame('1h', 'down'), frame('30m', 'down'), frame('15m', 'down'), frame('5m', 'down'),
  ];

  test('[critical] New.md\'s PE-sell example is ready, and says DOWN', () => {
    const r = readiness(ladder(aligned));
    assert.equal(r.ready, true);
    assert.equal(r.side, 'DOWN');
    assert.deepEqual(r.blockers, []);
  });

  test('[critical] the trigger disagreeing with the direction blocks it, and says so', () => {
    const r = readiness(ladder([...aligned.slice(0, 7), frame('5m', 'up')]));
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => /5M trigger is UP/.test(b)));
  });

  test('structure against the direction blocks it', () => {
    const r = readiness(ladder([
      frame('12h', 'down'), frame('6h', 'down'), frame('4h', 'up'), frame('2h', 'up'), frame('5m', 'down'),
    ]));
    assert.ok(r.blockers.some((b) => /structure is UP/.test(b)));
  });

  test('12H and 6H pointing opposite ways is not a direction', () => {
    const r = readiness(ladder([frame('12h', 'up'), frame('6h', 'down'), frame('5m', 'down')]));
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => /not pointing the same way/.test(b)));
  });

  test('[critical] a market with no trend anywhere is refused however well it lines up', () => {
    const flat = aligned.map((f) => ({ ...f, adx14: ADX_TRENDING - 5 }));
    const r = readiness(ladder(flat));
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => /ADX/.test(b)));
  });

  test('no readable direction frame is a blocker, not a silent pass', () => {
    const r = readiness(ladder([frame('5m', 'down'), frame('1m', 'down')]));
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => /No direction frame/.test(b)));
  });

  test('every blocker is a sentence a person can act on', () => {
    const r = readiness(ladder([frame('12h', 'up'), frame('6h', 'down'), frame('5m', 'up')]));
    for (const b of r.blockers) {
      assert.ok(b.length > 15, `too terse: ${b}`);
      assert.match(b, /[A-Za-z]/);
    }
  });
});
