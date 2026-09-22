import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStrikeStep, withinWindow, WHOLE_BOARD } from '../../src/market/chain.js';
import { pickStrike, type Candidate } from '../../src/strategy/select.js';
import { DEFAULT_CONFIG, type StrategyConfig } from '../../src/strategy/types.js';

/**
 * The open-interest rule, and the board it is allowed to see.
 *
 * 16 September 2026, 05:40. The rule picked the 80,000 call; the desk's own
 * card said the call wall was 81,600 with 395k open. Both were reading their
 * own board: `liveChain`'s default keeps 25 strike steps either side of the
 * money, which at $200 steps around 75,805 stops at 80,800 -- and the wall was
 * past the edge. The rule was right about everything it could see.
 *
 * So the board these tests build is the real one from that morning, with the
 * open interest Delta was reporting, and what is pinned is that a rule whose
 * whole job is "find the heaviest strike" is given every strike.
 */

/** Strikes and call/put open interest as Delta reported them at 05:40 IST. */
const SPOT = 75_804.9;
const OI: Record<number, { c: number; p: number }> = {
  73_600: { c: 0, p: 174_089 },
  74_000: { c: 0, p: 133_030 },
  74_400: { c: 0, p: 138_611 },
  75_400: { c: 0, p: 64_329 },
  78_000: { c: 110_982, p: 0 },
  79_000: { c: 182_613, p: 0 },
  80_000: { c: 277_786, p: 0 },
  81_600: { c: 394_748, p: 0 },
};
/** Every strike listed that morning: $200 apart near the money, wider out. */
const LISTED = [
  ...Array.from({ length: 26 }, (_, i) => 73_600 + i * 200),   // 73,600 .. 78,600
  79_000, 79_400, 80_000, 80_400, 81_000, 81_600,
];

/** The board as the strategy would receive it, windowed to `width` steps. */
function board(width: number): Candidate[] {
  const step = detectStrikeStep(LISTED, SPOT);
  const atm = Math.round(SPOT / step) * step;
  const out: Candidate[] = [];
  for (const strike of LISTED) {
    if (!withinWindow(strike, atm, step, width)) continue;
    const oi = OI[strike] ?? { c: 0, p: 0 };
    // Further out is cheaper; the exact number only has to be above zero.
    const dist = Math.abs(strike - atm);
    const price = Math.max(0.3, 300 - dist / 20);
    if (strike > atm) out.push({ cp: 'C', strike, sellPrice: price, pOtm: 0.97, moneyness: 'OTM', ask: price + 0.2, oi: oi.c });
    if (strike < atm) out.push({ cp: 'P', strike, sellPrice: price, pOtm: 0.97, moneyness: 'OTM', ask: price + 0.2, oi: oi.p });
  }
  return out;
}

/*
 * A floor the fixture's far strikes clear. Since 18 September the rule also
 * refuses a wall that pays under the premium floor and one outside the level
 * band -- neither is what this file is about, which is the window the rule is
 * allowed to see. The fixture carries no distance, so the band does not apply.
 */
const wall = (over: Partial<StrategyConfig> = {}): StrategyConfig =>
  ({ ...DEFAULT_CONFIG, strikeRule: 'oiWall', premium: { mode: 'atLeast', usd: 5 }, ...over }) as StrategyConfig;

test('[critical] the 16 September board: the default window hides the call wall', () => {
  const windowed = board(25);
  assert.ok(!windowed.some((l) => l.strike === 81_600), 'the wall is past the edge of a 25-step board');
  assert.equal(pickStrike(windowed, 'C', wall())?.strike, 80_000, 'so the rule picks the heaviest it can see');
});

test('[critical] the whole board picks the wall the desk shows: 81,600 and 73,600', () => {
  const all = board(WHOLE_BOARD);
  assert.equal(pickStrike(all, 'C', wall())?.strike, 81_600);
  assert.equal(pickStrike(all, 'P', wall())?.strike, 73_600);
});

test('the put wall was inside the window all along -- only the call side was cut off', () => {
  // Worth pinning: the symptom showed on one side, and a fix that only looked
  // at the side that failed would have looked correct on the other one.
  assert.equal(pickStrike(board(25), 'P', wall())?.strike, 73_600);
});

test('WHOLE_BOARD is wider than any day Delta lists', () => {
  const step = detectStrikeStep(LISTED, SPOT);
  const atm = Math.round(SPOT / step) * step;
  assert.ok(LISTED.every((k) => withinWindow(k, atm, step, WHOLE_BOARD)));
});

test('the window is symmetric and counts steps, not dollars', () => {
  assert.equal(withinWindow(75_800, 75_800, 200, 0), true);
  assert.equal(withinWindow(76_000, 75_800, 200, 1), true);
  assert.equal(withinWindow(75_600, 75_800, 200, 1), true);
  assert.equal(withinWindow(76_200, 75_800, 200, 1), false);
  // a strike between two steps rounds to the nearer one
  assert.equal(withinWindow(76_100, 75_800, 200, 1), false);
  assert.equal(withinWindow(76_050, 75_800, 200, 1), true);
});

