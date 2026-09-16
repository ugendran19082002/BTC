import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEST_TRADE_WEIGHTS, bestTrade, liquidityScore, rankOf,
} from '../src/domain/best-trade.js';
import type { EvLeg } from '../src/domain/ev.js';

/**
 * One trade, named.
 *
 * The board ranks strikes five ways at once and leaves the last step to
 * somebody at half past five in the morning. This does that step — and the two
 * properties that matter are that it never names a strike failing a hard rule,
 * and that **touch never votes**. A touch is a drawdown, not a loss; ranking on
 * it would refuse the strike that pays for exactly the risk a seller is in
 * business to take.
 */

const leg = (over: Partial<EvLeg> & { strike: number; cp: 'C' | 'P' }): EvLeg => ({
  bid: 12, ask: 13, mark: 12.5, sellPrice: 12,
  oi: 40_000, volume: 5_000, ageMin: 3,
  delta: -0.07, pOtm: 0.96, iv: 0.3,
  zero: { adjusted: 0.958, model: 0.96, sample: 900, outsideTable: false },
  probs: { expireWorthless: 0.96, touch: 0.24, nearZero: 0.91 },
  emBuffer: 1.54,
  ev: { tier: 'candidate', chargesUsd: 0.01, evUsd: 0.05, score: 70, checks: [] },
  ...over,
} as unknown as EvLeg);

const snap = { spot: 75_820, expectedMove: 756 };
const hedgeAt = (widthUsd: number, askUsd: number) => () => ({ strike: 0, askUsd, widthUsd });

// ------------------------------------------------------------- eligibility

test('[critical] a strike failing a hard rule is never picked, however well it ranks', () => {
  // Perfect on every part the ranking reads, and `avoid` because a rule that
  // matters is failing. Eligibility is not a weight; it is a refusal.
  const out = bestTrade({
    legs: [
      leg({ cp: 'P', strike: 75_400, ev: { tier: 'avoid', chargesUsd: 0.01, evUsd: 5, score: 99, checks: [] } as EvLeg['ev'] }),
      leg({ cp: 'P', strike: 74_800, ev: { tier: 'watch', chargesUsd: 0.01, evUsd: 0.01, score: 52, checks: [] } as EvLeg['ev'] }),
    ],
    snap,
    lots: 10,
  });
  assert.equal(out.pick?.strike, 74_800);
  assert.equal(out.eligible, 1);
  assert.equal(out.bestOfNone, false, 'one strike cleared, so nothing falls back');
});

test('[critical] an empty board is an answer, not a crash', () => {
  const out = bestTrade({ legs: [], snap, lots: 10 });
  assert.equal(out.pick, null);
  assert.equal(out.eligible, 0);
  assert.match(out.why!, /Nothing on this board pays \$5 or more/);
});

test('[critical] a strike paying under the floor is not a candidate, however safe', () => {
  // The 73,600 put on 17 September: 100% to expire worthless, paying $2.60.
  // Almost certain to keep it all, and not worth selling -- the margin at risk
  // does not shrink because the option is cheaper.
  const cheapAndSafe = leg({ cp: 'P', strike: 73_600, sellPrice: 2.6, bid: 2.6, emBuffer: 3.67 });
  const paying = leg({ cp: 'P', strike: 74_400, sellPrice: 5.5, bid: 5.5, emBuffer: 2.41 });
  const out = bestTrade({ legs: [cheapAndSafe, paying], snap, lots: 10 });
  assert.equal(out.pick!.strike, 74_400);
  assert.equal(out.minPremiumUsd, 5, 'the desk’s own floor by default');
  assert.ok(!out.runnersUp.some((r) => r.strike === 73_600), 'and it is not even a runner-up');
  const lowered = bestTrade({ legs: [cheapAndSafe, paying], snap, lots: 10, minPremiumUsd: 2 });
  assert.equal(lowered.runnersUp.length, 1, 'a lower floor lets it back in');
});

test('[critical] a morning when nothing clears still names the closest, and what it fails', () => {
  // An empty card cannot say which strike came nearest or why it was refused,
  // and those are the only two things worth knowing on that morning.
  const failing = {
    tier: 'avoid', chargesUsd: 0.01, evUsd: -0.2, score: 44,
    checks: [
      { ok: false, severity: 'block', text: 'Traded 2% of its open interest today, under the 10% bar.' },
      { ok: false, severity: 'block', text: 'Last traded 41 minutes ago.' },
      { ok: true, severity: 'block', text: '3.4% out of the money, past the 3% bar.' },
      { ok: false, severity: 'warn', text: 'A warning, which is not a refusal.' },
    ],
  } as unknown as EvLeg['ev'];
  const out = bestTrade({
    legs: [leg({ cp: 'P', strike: 75_400, ev: failing }), leg({ cp: 'P', strike: 75_000, ev: failing })],
    snap,
    lots: 10,
  });
  assert.equal(out.bestOfNone, true);
  assert.equal(out.eligible, 0, 'and it is honest that nothing was eligible');
  assert.ok(out.pick !== null);
  assert.deepEqual(out.pick!.failing, [
    'Traded 2% of its open interest today, under the 10% bar.',
    'Last traded 41 minutes ago.',
  ], 'the blocks it failed, and not the warnings or the ones it passed');
  assert.match(out.why!, /came closest/);
});

test('an eligible board never falls back, and carries no failures', () => {
  const out = bestTrade({ legs: [leg({ cp: 'P', strike: 75_400 })], snap, lots: 10 });
  assert.equal(out.bestOfNone, false);
  assert.equal(out.eligible, 1);
  assert.deepEqual(out.pick!.failing, []);
});

test('a strike with no bid cannot be sold, so it is not ranked at all', () => {
  const out = bestTrade({ legs: [leg({ cp: 'P', strike: 75_400, sellPrice: null, bid: null })], snap, lots: 10 });
  assert.equal(out.pick, null);
  assert.match(out.why!, /nothing worth selling/);
});

// ---------------------------------------------------------------- the money

test('[critical] credit and max loss come from the hedge that would actually be bought', () => {
  // 10 lots, 0.001 BTC each: a $12 premium is $0.12, less a penny of charges.
  // A 400-wide hedge costing $3 leaves 400 × 0.01 − (0.11 − 0.03) = $3.92.
  const out = bestTrade({
    legs: [leg({ cp: 'P', strike: 75_400 })],
    snap,
    lots: 10,
    hedgeFor: hedgeAt(400, 3),
  });
  const p = out.pick!;
  assert.ok(Math.abs(p.creditUsd - (12 * 10 * 0.001 - 0.01)) < 1e-9, `${p.creditUsd}`);
  assert.ok(Math.abs(p.maxLossUsd! - (400 * 10 * 0.001 - (p.creditUsd - 3 * 10 * 0.001))) < 1e-9, `${p.maxLossUsd}`);
  assert.ok(Math.abs(p.creditRisk! - p.creditUsd / p.maxLossUsd!) < 1e-12);
});

test('[critical] no hedge means no cap and no credit-to-risk, not a zero', () => {
  const out = bestTrade({ legs: [leg({ cp: 'P', strike: 75_400 })], snap, lots: 10 });
  assert.equal(out.pick!.maxLossUsd, null);
  assert.equal(out.pick!.creditRisk, null);
  assert.ok(out.pick!.rank > 0, 'and it is still ranked, on the parts that can be read');
});

// --------------------------------------------------------------- the ranking

test('[critical] touch does not vote', () => {
  // Two strikes identical but for the touch probability. A touch is a drawdown,
  // not a loss, and a day that reaches the strike and comes back settles
  // worthless like any other -- so the ranking must not separate these.
  const calm = leg({ cp: 'P', strike: 75_400, probs: { expireWorthless: 0.96, touch: 0.05, nearZero: 0.9 } });
  const choppy = leg({ cp: 'P', strike: 75_200, probs: { expireWorthless: 0.96, touch: 0.55, nearZero: 0.9 } });
  const out = bestTrade({ legs: [choppy, calm], snap, lots: 10 });
  assert.equal(out.pick!.rank, out.runnersUp[0]!.rank, 'the same rank either way');
  assert.equal(out.pick!.touch, 0.55, 'and the number is still carried onto the card');
});

test('[critical] a better credit against risk wins, all else equal', () => {
  const a = leg({ cp: 'P', strike: 75_400 });
  const b = leg({ cp: 'P', strike: 75_200 });
  const wide = bestTrade({ legs: [a], snap, lots: 10, hedgeFor: hedgeAt(400, 3) }).pick!;
  const tight = bestTrade({ legs: [b], snap, lots: 10, hedgeFor: hedgeAt(200, 3) }).pick!;
  assert.ok(tight.creditRisk! > wide.creditRisk!, 'a narrower spread risks less for the same credit');
  assert.ok(tight.rank > wide.rank);
});

test('safer, further and more liquid all raise the rank on their own', () => {
  const base = { creditRisk: 0.3, expiryOtm: 0.93, emBuffer: 1, liquidity: 50 };
  assert.ok(rankOf({ ...base, expiryOtm: 0.99 }) > rankOf(base));
  assert.ok(rankOf({ ...base, emBuffer: 2.5 }) > rankOf(base));
  assert.ok(rankOf({ ...base, liquidity: 95 }) > rankOf(base));
  assert.ok(rankOf({ ...base, creditRisk: 0.5 }) > rankOf(base));
});

test('the weights are declared, and add up to one', () => {
  const total = Object.values(BEST_TRADE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `${total}`);
});

test('a part that cannot be read is dropped, and the rest renormalised', () => {
  // Not scored zero: a board with no calibration would otherwise rank every
  // strike near the bottom and call the least-bad one "best".
  const noOdds = rankOf({ creditRisk: 0.5, expiryOtm: null, emBuffer: 2, liquidity: 100 });
  assert.equal(noOdds, 100, 'everything readable is full marks');
});

// ------------------------------------------------------------- the liquidity

test('[critical] liquidity reads the book, the turnover, the depth and the freshness', () => {
  const good = liquidityScore({ bid: 11.9, ask: 12.1, oi: 60_000, volume: 9_000, ageMin: 1 });
  const bad = liquidityScore({ bid: 8, ask: 14, oi: 200, volume: 1, ageMin: 90 });
  assert.ok(good > 85, `${good}`);
  assert.ok(bad < 25, `${bad}`);
  // a tight quote on a strike nobody has traded is a quote, not a market
  const quoteOnly = liquidityScore({ bid: 11.95, ask: 12.05, oi: 300, volume: 0, ageMin: 240 });
  assert.ok(quoteOnly < good - 30, `${quoteOnly} should be well under ${good}`);
});

test('a missing figure is treated as poor-but-unknown, never as perfect', () => {
  const blind = liquidityScore({ bid: null, ask: null, oi: null, volume: null, ageMin: null });
  assert.ok(blind > 0 && blind < 50, `${blind}`);
});

// --------------------------------------------------------- what it says back

test('[critical] the reasons name the numbers it was chosen on', () => {
  const out = bestTrade({ legs: [leg({ cp: 'P', strike: 75_400 })], snap, lots: 10, hedgeFor: hedgeAt(400, 3) });
  const why = out.pick!.reasons.join(' · ');
  assert.match(why, /pays \d+% of what it can lose/);
  assert.match(why, /95\.8% to expire worthless/);
  assert.match(why, /1\.54× the expected move away/);
  assert.match(why, /liquidity \d+\/100/);
});

test('it says when the tested engine picked the same strike, and when it did not', () => {
  const legs = [leg({ cp: 'P', strike: 75_400 })];
  const same = bestTrade({ legs, snap, lots: 10, enginePicks: [{ side: 'PE', strike: 75_400 }] });
  assert.equal(same.agreesWithEngine, true);
  const other = bestTrade({ legs, snap, lots: 10, enginePicks: [{ side: 'PE', strike: 74_800 }] });
  assert.equal(other.agreesWithEngine, false);
});

test('the two behind it are carried, so "why not that one" is answerable', () => {
  const out = bestTrade({
    legs: [
      leg({ cp: 'P', strike: 75_400, emBuffer: 1.5 }),
      leg({ cp: 'P', strike: 75_000, emBuffer: 2.6 }),
      leg({ cp: 'P', strike: 74_800, emBuffer: 3.2 }),
      leg({ cp: 'C', strike: 78_000, emBuffer: 2.9 }),
    ],
    snap,
    lots: 10,
  });
  assert.equal(out.runnersUp.length, 2);
  assert.ok(out.pick!.rank >= out.runnersUp[0]!.rank);
  assert.ok(out.runnersUp[0]!.rank >= out.runnersUp[1]!.rank);
});

test('a call and a put are ranked against each other, not one per side', () => {
  const out = bestTrade({
    legs: [
      leg({ cp: 'P', strike: 75_400, emBuffer: 0.8, zero: { adjusted: 0.88, model: 0.88, sample: 9, outsideTable: false } }),
      leg({ cp: 'C', strike: 78_000, emBuffer: 3.0, zero: { adjusted: 0.99, model: 0.99, sample: 900, outsideTable: false } }),
    ],
    snap,
    lots: 10,
  });
  assert.equal(out.pick!.side, 'CE', 'the safer, further strike wins whichever side it is on');
});
