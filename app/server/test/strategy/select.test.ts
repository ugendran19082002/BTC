import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSelection, pickStrike, selectLegs, type Candidate } from '../../src/strategy/select.js';
import { DEFAULT_CONFIG, type Strategy, type StrategyConfig } from '../../src/strategy/types.js';

/**
 * What gets sold, decided from the board alone.
 *
 * The premium rules are opposites and one click apart in the form, so the tests
 * that matter most are the ones that pin which strike each of them takes.
 */
const leg = (
  cp: 'C' | 'P', strike: number, sellPrice: number | null, pOtm: number | null,
  moneyness: Candidate['moneyness'] = 'OTM',
): Candidate => ({ cp, strike, sellPrice, pOtm, moneyness });

/** A board around spot 78,600: calls above, puts below, cheaper further out. */
const BOARD: Candidate[] = [
  leg('C', 78_600, 300, 0.50, 'ATM'),
  leg('C', 79_000, 60, 0.80),
  leg('C', 79_400, 30, 0.90),
  leg('C', 79_800, 18, 0.94),
  leg('C', 80_200, 12, 0.96),
  leg('C', 80_600, 7, 0.98),
  leg('C', 81_000, 3, 0.99),
  leg('P', 78_600, 300, 0.50, 'ATM'),
  leg('P', 78_200, 55, 0.81),
  leg('P', 77_800, 28, 0.91),
  leg('P', 77_400, 16, 0.95),
  leg('P', 77_000, 9, 0.97),
];

const cfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({ ...DEFAULT_CONFIG, ...over });
const strat = (c: Partial<StrategyConfig> = {}): Strategy => ({
  id: 's', name: 'test', enabled: true, config: cfg(c), createdAt: 0, updatedAt: 0,
});

test('[critical] "at least" takes the furthest strike still paying it', () => {
  // $15 floor: 18 and 30 and 60 all pay it; the furthest is the cheapest of them.
  const got = pickStrike(BOARD, 'C', cfg({ premium: { mode: 'atLeast', usd: 15 } }));
  assert.equal(got?.strike, 79_800);
  assert.equal(got?.sellPrice, 18);
});

test('[critical] "at most" takes the richest strike under it', () => {
  const got = pickStrike(BOARD, 'C', cfg({ premium: { mode: 'atMost', usd: 15 } }));
  assert.equal(got?.strike, 80_200);
  assert.equal(got?.sellPrice, 12);
});

test('[critical] the two rules never pick the same strike on this board', () => {
  const a = pickStrike(BOARD, 'C', cfg({ premium: { mode: 'atLeast', usd: 15 } }));
  const b = pickStrike(BOARD, 'C', cfg({ premium: { mode: 'atMost', usd: 15 } }));
  assert.notEqual(a?.strike, b?.strike, 'one click apart in the form, and different trades');
  assert.ok(b!.strike > a!.strike, 'the cap rule sits further out');
});

test('an in-the-money strike is never sold, however well it pays', () => {
  const withItm = [...BOARD, leg('C', 78_000, 700, 0.20, 'ITM')];
  const got = pickStrike(withItm, 'C', cfg({ premium: { mode: 'atLeast', usd: 15 } }));
  assert.equal(got?.strike, 79_800);
});

test('a strike with no sellable price is skipped', () => {
  const board = [leg('C', 79_800, null, 0.94), leg('C', 80_200, 12, 0.96)];
  const got = pickStrike(board, 'C', cfg({ premium: { mode: 'atMost', usd: 15 } }));
  assert.equal(got?.strike, 80_200);
});

test('nothing paying the floor returns nothing rather than the nearest thing', () => {
  assert.equal(pickStrike(BOARD, 'C', cfg({ premium: { mode: 'atLeast', usd: 500 } })), null);
});

test('nothing under the cap returns nothing', () => {
  assert.equal(pickStrike(BOARD, 'C', cfg({ premium: { mode: 'atMost', usd: 1 } })), null);
});

/* ---------------------------------------------------- by strike, not price --- */

/*
 * The second rule, asked for on 12 September: name the strike instead of the
 * price. ATM, OTM 1..n, ITM 1..n -- and whatever it pays, that is the one sold.
 */
const byStrike = (strikeStep: number, over: Partial<StrategyConfig> = {}) =>
  cfg({ strikeRule: 'strict', strikeStep, ...over });

test('[critical] "by strike" takes the strike named, counting out from the money', () => {
  assert.equal(pickStrike(BOARD, 'C', byStrike(0))?.strike, 78_600, 'ATM');
  assert.equal(pickStrike(BOARD, 'C', byStrike(1))?.strike, 79_000, 'OTM 1');
  assert.equal(pickStrike(BOARD, 'C', byStrike(3))?.strike, 79_800, 'OTM 3');
});

test('[critical] a put counts outward downwards, so its OTM 1 is below the money', () => {
  assert.equal(pickStrike(BOARD, 'P', byStrike(0))?.strike, 78_600);
  assert.equal(pickStrike(BOARD, 'P', byStrike(1))?.strike, 78_200);
  assert.equal(pickStrike(BOARD, 'P', byStrike(4))?.strike, 77_000);
});

test('[critical] ITM 1 is the nearest strike in the money -- refused by the premium rule, allowed by this one', () => {
  const board = [...BOARD, leg('C', 78_200, 500, 0.30, 'ITM'), leg('C', 77_800, 900, 0.15, 'ITM')];
  assert.equal(pickStrike(board, 'C', byStrike(-1))?.strike, 78_200);
  assert.equal(pickStrike(board, 'C', byStrike(-2))?.strike, 77_800);
  // the same board, under the premium rule, still never sells one
  assert.equal(pickStrike(board, 'C', cfg({ premium: { mode: 'atLeast', usd: 15 } }))?.strike, 79_800);
});

test('[critical] it counts the strikes Delta listed, not grid steps', () => {
  // Delta lists $200 apart near the money and $400 out, and does not list every
  // step: with 79,400 missing, OTM 2 is the next one that exists.
  const gappy = BOARD.filter((l) => l.strike !== 79_400);
  assert.equal(pickStrike(gappy, 'C', byStrike(2))?.strike, 79_800);
});

test('a strike that is not on the board is refused, never substituted', () => {
  assert.equal(pickStrike(BOARD, 'C', byStrike(9)), null, 'only six calls are listed out');
  assert.equal(pickStrike(BOARD, 'C', byStrike(-1)), null, 'nothing in the money on this board');
});

test('a strike with no price does not take the slot', () => {
  const board = [leg('C', 79_000, null, 0.80), leg('C', 79_400, 30, 0.90)];
  assert.equal(pickStrike(board, 'C', byStrike(1))?.strike, 79_400);
});

test('[critical] the premium numbers are not read at all under a strict rule', () => {
  // $999 refuses every strike on this board under the premium rule.
  assert.equal(pickStrike(BOARD, 'C', byStrike(1, { premium: { mode: 'atLeast', usd: 999 } }))?.strike, 79_000);
});

test('the refusal names the strike that was asked for', () => {
  const sel = selectLegs(strat({ strikeRule: 'strict', strikeStep: 9 }), BOARD);
  assert.equal(sel.legs.length, 0);
  assert.match(sel.refusals.join(' '), /CE: no OTM 9 strike listed with a price/);
});

/* ------------------------------------------------------------- sizing --- */

test('both legs are sold, each at the strategy\'s own lots', () => {
  // atMost $15 -> C 80,200 and P 77,400.
  const sel = selectLegs(strat({ premium: { mode: 'atMost', usd: 15 }, lots: 10 }), BOARD);
  assert.equal(sel.legs.length, 2);
  assert.deepEqual(sel.legs.map((l) => l.lots), [10, 10]);
  assert.deepEqual(sel.refusals, []);
});

test('an empty board sells nothing rather than throwing', () => {
  const sel = selectLegs(strat(), []);
  assert.equal(sel.legs.length, 0);
  assert.equal(sel.refusals.length, 2);
});

/* --------------------------------------------------------------- words ---- */

test('the description names what was sold', () => {
  const sel = selectLegs(strat({ premium: { mode: 'atMost', usd: 15 }, lots: 10 }), BOARD);
  const s = describeSelection(sel);
  assert.match(s, /CE 80200 x10/);
  assert.match(s, /PE 77000 x10/);
});

test('selling nothing still says why', () => {
  const sel = selectLegs(strat({ premium: { mode: 'atLeast', usd: 999 } }), BOARD);
  assert.match(describeSelection(sel), /nothing out of the money paying \$999/);
});

/**
 * The open-interest wall.
 *
 * Differently untested from the other two rules, and the code says so: the
 * premium rule carries a 733-day record, `strict` carries none but is only a
 * way of naming a strike a person already chose, and this one is a *claim* --
 * that the strike carrying the most open interest is a better one to sell.
 * Open interest is the thing `feature_screen.py` tested and rejected.
 *
 * So what is pinned here is that it does what it says, refuses cleanly when it
 * cannot, and never quietly reaches into the money.
 */
// A floor under every fixture's price: the rule now refuses a wall that does not pay.
const wall = (over: Partial<StrategyConfig> = {}): StrategyConfig =>
  ({ ...DEFAULT_CONFIG, strikeRule: 'oiWall', premium: { mode: 'atLeast', usd: 5 }, ...over }) as StrategyConfig;

const withOi = (cp: 'C' | 'P', strike: number, sellPrice: number, oi: number | null, moneyness: 'ITM' | 'ATM' | 'OTM' = 'OTM', emBuffer: number | null = 1) =>
  ({ cp, strike, sellPrice, pOtm: 0.98, moneyness, ask: sellPrice + 1, oi, emBuffer }) as Candidate;

test('[critical] takes the heaviest strike on that side', () => {
  const board = [
    withOi('C', 79_000, 20, 12_000),
    withOi('C', 80_000, 12, 425_000),
    withOi('C', 81_000, 6, 40_000),
  ];
  assert.equal(pickStrike(board, 'C', wall())?.strike, 80_000);
});

test('each side gets its own wall', () => {
  const board = [
    withOi('C', 80_000, 12, 425_000),
    withOi('P', 74_400, 14, 59_000),
    withOi('P', 73_000, 5, 9_000),
  ];
  assert.equal(pickStrike(board, 'C', wall())?.strike, 80_000);
  assert.equal(pickStrike(board, 'P', wall())?.strike, 74_400);
});

test('[critical] never reaches into the money, however heavy the wall', () => {
  // a short that starts in the money is a directional bet, not this strategy
  const board = [
    withOi('C', 70_000, 900, 9_000_000, 'ITM'),
    withOi('C', 80_000, 12, 1_000),
  ];
  assert.equal(pickStrike(board, 'C', wall())?.strike, 80_000);
});

test('[critical] a strike with no open interest to read is left out, not ranked last', () => {
  // absent is not zero: an unreadable strike must not win by default when
  // every other one is unreadable too
  const board = [withOi('C', 80_000, 12, null), withOi('C', 81_000, 6, null)];
  assert.equal(pickStrike(board, 'C', wall()), null);
});

test('a readable strike beats an unreadable one', () => {
  const board = [withOi('C', 80_000, 12, null), withOi('C', 81_000, 6, 500)];
  assert.equal(pickStrike(board, 'C', wall())?.strike, 81_000);
});

test('an unpriced strike is no more sellable under this rule than any other', () => {
  const board = [
    { cp: 'C' as const, strike: 80_000, sellPrice: null, pOtm: 0.98, moneyness: 'OTM' as const, oi: 9_000_000 },
    withOi('C', 81_000, 6, 500),
  ];
  assert.equal(pickStrike(board as Candidate[], 'C', wall())?.strike, 81_000);
});

test('the refusal says what was missing, not just that there was nothing', () => {
  const s = { id: 'x', name: 'wall', enabled: true, config: wall({ legs: 'both' }) } as unknown as Strategy;
  const out = selectLegs(s, [withOi('C', 80_000, 12, null)]);
  assert.equal(out.legs.length, 0);
  assert.ok(
    out.refusals.some((r) => /no wall within 2 expected moves that pays \$5/.test(r)),
    out.refusals.join(' | '),
  );
});

/*
 * 18 September, asked which pair the rule takes: 71,000 – 89,000 or 76,000 –
 * 77,800. It took the first -- the heaviest anywhere on the board, paying
 * $0.20 and $0.10. The wall is looked for inside the desk's level band now,
 * and it has to clear the premium floor like any other strike.
 */
test('[critical] the wall is the heaviest within reach, not the heaviest on the board', () => {
  const board = [
    withOi('C', 77_800, 24, 134_000, 'OTM', 1.9),
    withOi('C', 78_000, 20, 245_000, 'OTM', 2.4),      // heavier, just outside two expected moves
    withOi('C', 89_000, 0.1, 455_000, 'OTM', 11),      // the heaviest on the board, paying nothing
  ];
  assert.equal(pickStrike(board, 'C', wall({ premium: { mode: 'atLeast', usd: 15 } }))?.strike, 77_800);
  // a wider band lets the next one in
  assert.equal(pickStrike(board, 'C', wall({ premium: { mode: 'atLeast', usd: 15 } }), { wallWithinEm: 3 })?.strike, 78_000);
});

test('[critical] a wall that pays under the floor is a level, not a trade', () => {
  const board = [
    withOi('C', 78_000, 3, 245_000, 'OTM', 1.5),
    withOi('C', 77_400, 30, 60_000, 'OTM', 0.8),
  ];
  assert.equal(pickStrike(board, 'C', wall({ premium: { mode: 'atLeast', usd: 15 } }))?.strike, 77_400);
  // nothing in reach pays: stand aside, and say so
  const s = { id: 's', name: 's', enabled: true, createdAt: 0, updatedAt: 0, config: wall({ legs: 'CE', premium: { mode: 'atLeast', usd: 50 } }) };
  const sel = selectLegs(s as never, board, { wallWithinEm: 2 });
  assert.equal(sel.legs.length, 0);
  assert.match(sel.refusals[0]!, /no wall within 2 expected moves that pays \$50/);
});

test('a strike with no distance to read is not thrown out by the band', () => {
  const board = [withOi('C', 80_000, 20, 425_000, 'OTM', null)];
  assert.equal(pickStrike(board, 'C', wall({ premium: { mode: 'atLeast', usd: 15 } }))?.strike, 80_000);
});

/* ------------------------------------------------------------------ premium fallback */

/** A board where every out-of-the-money strike pays more than $20: the near ones only, on a wild day. */
const RICH: Candidate[] = [
  leg('C', 79_000, 90, 0.7), leg('C', 79_400, 62, 0.8), leg('C', 79_800, 44, 0.86), leg('C', 80_200, 31, 0.9),
  leg('P', 78_200, 85, 0.7), leg('P', 77_800, 48, 0.85), leg('P', 77_400, 26, 0.9),
];

test('[critical] at most $20 finds nothing, so the fallback takes the last strike at or below $50', () => {
  const c = cfg({ premium: { mode: 'atMost', usd: 20, fallbackUsd: 50 } });
  assert.equal(pickStrike(RICH, 'C', c)?.strike, 79_800, 'richest at or below 50: 44');
  assert.equal(pickStrike(RICH, 'P', c)?.strike, 77_800, 'richest at or below 50: 48');
});

test('[critical] the fallback is never used while the number itself finds a strike', () => {
  const c = cfg({ premium: { mode: 'atMost', usd: 20, fallbackUsd: 50 } });
  assert.equal(pickStrike(BOARD, 'C', c)?.sellPrice, 18, 'the $18 call is at or below $20 -- not the richer $30');
});

test('at least $20 finds nothing, so a lower fallback floor takes the furthest still paying it', () => {
  const thin: Candidate[] = [leg('C', 79_800, 14, 0.94), leg('C', 80_200, 11, 0.96), leg('C', 80_600, 6, 0.98)];
  const c = cfg({ premium: { mode: 'atLeast', usd: 20, fallbackUsd: 10 } });
  assert.equal(pickStrike(thin, 'C', c)?.sellPrice, 11);
});

test('no fallback is the rule as it always was: nothing found, nothing sold', () => {
  assert.equal(pickStrike(RICH, 'C', cfg({ premium: { mode: 'atMost', usd: 20 } })), null);
  assert.equal(pickStrike(RICH, 'C', cfg({ premium: { mode: 'atMost', usd: 20, fallbackUsd: null } })), null);
});

test('[critical] a leg sold on the fallback says so in the journal', () => {
  const sel = selectLegs(strat({ premium: { mode: 'atMost', usd: 20, fallbackUsd: 50 } }), RICH);
  assert.equal(sel.legs.length, 2);
  assert.ok(sel.legs.every((l) => l.fallbackUsd === 50));
  assert.match(describeSelection(sel), /CE 79800 x10 @ 44 \(fallback \$50\)/);
});

test('a leg found by the number itself carries no fallback mark', () => {
  const sel = selectLegs(strat({ premium: { mode: 'atMost', usd: 20, fallbackUsd: 50 } }), BOARD);
  assert.ok(sel.legs.every((l) => l.fallbackUsd === undefined));
  assert.doesNotMatch(describeSelection(sel), /fallback/);
});

test('when the fallback finds nothing either, the refusal names both numbers', () => {
  const sel = selectLegs(strat({ legs: 'CE', premium: { mode: 'atMost', usd: 20, fallbackUsd: 25 } }), RICH);
  assert.deepEqual(sel.refusals, ['CE: nothing out of the money at or below $20, nor $25']);
});

