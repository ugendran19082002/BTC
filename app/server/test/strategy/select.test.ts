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

test('each leg carries the offer beside its bid, so the spread it sold into is on the record', () => {
  const sel = selectLegs(strat({ legs: 'CE', premium: { mode: 'atMost', usd: 20 } }), [
    { ...leg('C', 79_800, 18, 0.94), ask: 18.6 },
  ]);
  assert.equal(describeSelection(sel), 'CE 79800 x10 @ 18, ask 18.6');
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


// --- the strike nearest the money, when it has no intrinsic value ----------

/**
 * 29 Sep 2026, 17:01 IST, spot 84,150: the board as the 17:01 strategy saw it.
 * 84,200 is the strike nearest spot, so both of its legs read ATM -- but the
 * call is above spot and worth nothing now. AlgoTest sold CE 84,200 at 7.58 and
 * PE 84,000 at 11.11; the desk skipped the call and went to 84,400 at 0.80.
 */
const AT_1701: Candidate[] = [
  leg('C', 84_000, 150, 0.30, 'ITM'),
  leg('C', 84_200, 7.6, 0.70, 'ATM'),
  leg('C', 84_400, 0.8, 0.97),
  leg('P', 84_200, 60, 0.30, 'ATM'),
  leg('P', 84_000, 9, 0.80),
  leg('P', 83_800, 2, 0.95),
];
const atMost42 = { strikeRule: 'premium', premium: { mode: 'atMost', usd: 42 } } as Partial<StrategyConfig>;

test('[critical] a call at the money but above spot is out of the money, and "at most" sells it', () => {
  const sel = selectLegs(strat(atMost42), AT_1701, { spot: 84_150 });
  assert.deepEqual(sel.legs.map((l) => `${l.cp} ${l.strike}`), ['C 84200', 'P 84000']);
});

test('[critical] a put at the money but above spot is in the money, and is never sold', () => {
  assert.equal(pickStrike(AT_1701, 'P', cfg(atMost42), { spot: 84_150 })?.strike, 84_000);
});

test('a strike exactly at spot is not out of the money on either side', () => {
  assert.equal(pickStrike(AT_1701, 'C', cfg(atMost42), { spot: 84_200 })?.strike, 84_400);
  assert.equal(pickStrike(AT_1701, 'P', cfg(atMost42), { spot: 84_200 })?.strike, 84_000);
});

test('without spot the nearest strike is left out, as it always was', () => {
  assert.equal(pickStrike(AT_1701, 'C', cfg(atMost42))?.strike, 84_400);
});

test('the open-interest rule may take the nearest strike too, when it has no intrinsic value', () => {
  const board = AT_1701.map((l) => ({ ...l, oi: l.strike === 84_200 ? 900 : 100, emBuffer: 0.1 }));
  const got = pickStrike(board, 'C', cfg({ strikeRule: 'oiWall', premium: { mode: 'atLeast', usd: 5 } }), { spot: 84_150 });
  assert.equal(got?.strike, 84_200);
});

// ------------------------------------------------------------ the nearest strike a premium rule may sell

/*
 * "At least OTM n" on a premium rule (4 Oct 2026). On BOARD the calls run
 * OTM 1 79,000 @ 60 · OTM 2 79,400 @ 30 · OTM 3 79,800 @ 18 · OTM 4 80,200 @ 12 ·
 * OTM 5 80,600 @ 7 · OTM 6 81,000 @ 3. The premium picks as it always did; its
 * pick stands at the floor or further out, and the floor's own strike is sold
 * when the pick sits nearer the money, or there is none.
 */
const floor = (mode: 'atLeast' | 'atMost', usd: number, minOtm: number | null, fallbackUsd: number | null = null) =>
  cfg({ premium: { mode, usd, fallbackUsd, minOtm } });

test('[critical] a premium pick further out than the floor stands: OTM 3 under "at least OTM 2" is sold as OTM 3', () => {
  // at least $15 picks 79,800 @ 18, the third strike out
  assert.equal(pickStrike(BOARD, 'C', floor('atLeast', 15, 2))?.strike, 79_800);
  assert.equal(pickStrike(BOARD, 'C', floor('atLeast', 15, 1))?.strike, 79_800);
});

test('[critical] a pick exactly at the floor stands: equal counts', () => {
  assert.equal(pickStrike(BOARD, 'C', floor('atLeast', 15, 3))?.strike, 79_800);
  assert.equal(pickStrike(BOARD, 'C', floor('atMost', 15, 4))?.strike, 80_200);
});

test('[critical] a pick nearer the money than the floor is replaced by the floor\'s own strike', () => {
  // at least $15 would sell OTM 3; the floor is OTM 5, so 80,600 @ 7 is sold -- whatever it pays
  const got = pickStrike(BOARD, 'C', floor('atLeast', 15, 5));
  assert.equal(got?.strike, 80_600);
  assert.equal(got?.sellPrice, 7);
  // at most $15 would sell OTM 4 @ 12; under OTM 6 it is 81,000 @ 3
  assert.equal(pickStrike(BOARD, 'C', floor('atMost', 15, 6))?.strike, 81_000);
  // and the put side counts down the board the same way: at least $15 picks OTM 3 (77,400), the floor is OTM 4
  assert.equal(pickStrike(BOARD, 'P', floor('atLeast', 15, 4))?.strike, 77_000);
});

test('[critical] no strike meets the premium at all: the floor\'s strike is sold rather than nothing', () => {
  assert.equal(pickStrike(BOARD, 'C', floor('atLeast', 500, null)), null, 'without a floor: nothing');
  assert.equal(pickStrike(BOARD, 'C', floor('atLeast', 500, 2))?.strike, 79_400);
});

test('the strike at the money, sold by a premium rule when it has no intrinsic value, is nearer than any floor', () => {
  // spot just under 78,600: the call there is out of the money and pays the most
  assert.equal(pickStrike(BOARD, 'C', floor('atLeast', 200, null), { spot: 78_550 })?.strike, 78_600);
  assert.equal(pickStrike(BOARD, 'C', floor('atLeast', 200, 1), { spot: 78_550 })?.strike, 79_000, 'OTM 1, not the money');
});

test('[critical] a floor beyond the last listed strike refuses the leg, and says why', () => {
  // four puts out of the money; OTM 6 is not on the board
  const sel = selectLegs(strat({ legs: 'PE', premium: { mode: 'atLeast', usd: 15, minOtm: 6 } }), BOARD);
  assert.deepEqual(sel.legs, []);
  assert.equal(sel.refusals[0], "PE: rule failed — the premium's strike 77400 @ 16 is nearer than OTM 6 — and the else strike OTM 6 is not listed with a price");
});

test('[critical] the run says when the floor chose the strike -- and does not call it the fallback', () => {
  // at most $2 finds nothing; the fallback, at most $10, finds OTM 5 @ 7; the floor is OTM 6
  const sel = selectLegs(strat({ legs: 'CE', lots: 3, premium: { mode: 'atMost', usd: 2, fallbackUsd: 10, minOtm: 6 } }), BOARD);
  assert.equal(sel.legs[0]!.strike, 81_000);
  assert.equal(sel.legs[0]!.minOtm, 6);
  assert.equal(sel.legs[0]!.fallbackUsd, undefined);
  assert.equal(sel.legs[0]!.elseOtm, 6);
  assert.equal(describeSelection(sel), 'CE 81000 x3 @ 3 (rule failed: the premium\'s strike 80600 @ 7 is nearer than OTM 6 — sold the else strike OTM 6)');
  // the premium's own pick, further out than the floor: no note at all
  const own = selectLegs(strat({ legs: 'CE', premium: { mode: 'atLeast', usd: 15, minOtm: 2 } }), BOARD);
  assert.equal(own.legs[0]!.minOtm, undefined);
  assert.equal(describeSelection(own), 'CE 79800 x10 @ 18');
  // a fallback pick at or beyond the floor is still said as the fallback
  const viaFb = selectLegs(strat({ legs: 'CE', premium: { mode: 'atMost', usd: 2, fallbackUsd: 10, minOtm: 5 } }), BOARD);
  assert.equal(viaFb.legs[0]!.strike, 80_600);
  assert.equal(viaFb.legs[0]!.fallbackUsd, 10);
  assert.equal(viaFb.legs[0]!.minOtm, undefined);
});

test('off -- null or absent -- is the premium rule as it always was', () => {
  for (const minOtm of [null, undefined]) {
    assert.equal(pickStrike(BOARD, 'C', cfg({ premium: { mode: 'atLeast', usd: 15, minOtm } }))?.strike, 79_800);
    assert.equal(pickStrike(BOARD, 'C', cfg({ premium: { mode: 'atMost', usd: 15, minOtm } }))?.strike, 80_200);
  }
});

test('a by-strike rule names its strike and does not read the floor', () => {
  assert.equal(pickStrike(BOARD, 'C', cfg({ strikeRule: 'strict', strikeStep: 1, premium: { mode: 'atLeast', usd: 15, minOtm: 5 } }))?.strike, 79_000);
});

// ------------------------------------------------------------ the else strike: its own, the same or a different one

/*
 * The else has a strike of its own (4 Oct 2026): "at least OTM 5, else OTM 6".
 * The rule and the else are two strikes, each named the way a by-strike rule
 * names one, and they may be equal or different. The else is read only when the
 * premium's strike does not meet the rule.
 */
const orElse = (mode: 'atLeast' | 'atMost', usd: number, minOtm: number, elseOtm: number | null | undefined) =>
  cfg({ premium: { mode, usd, fallbackUsd: null, minOtm, elseOtm } });

test('[critical] else further out than the rule: at least $15 picks OTM 3, the rule is OTM 5, the else sells OTM 6', () => {
  const got = pickStrike(BOARD, 'C', orElse('atLeast', 15, 5, 6));
  assert.equal(got?.strike, 81_000);
  assert.equal(got?.sellPrice, 3);
});

test('[critical] else equal to the rule sells the rule\'s own strike; an else nearer than the rule is sold as named', () => {
  assert.equal(pickStrike(BOARD, 'C', orElse('atLeast', 15, 5, 5))?.strike, 80_600);
  assert.equal(pickStrike(BOARD, 'C', orElse('atLeast', 15, 5, 2))?.strike, 79_400, 'OTM 2: nearer than the rule, and still what the else names');
});

test('[critical] a premium strike that meets the rule is sold, and the else is not read', () => {
  // at least $15 picks OTM 3; the rule is OTM 2 or OTM 3 -- met either way, whatever the else says
  assert.equal(pickStrike(BOARD, 'C', orElse('atLeast', 15, 2, 6))?.strike, 79_800);
  assert.equal(pickStrike(BOARD, 'C', orElse('atLeast', 15, 3, 1))?.strike, 79_800);
  const sel = selectLegs(strat({ legs: 'CE', premium: { mode: 'atLeast', usd: 15, minOtm: 3, elseOtm: 6 } }), BOARD);
  assert.equal(sel.legs[0]!.elseOtm, undefined);
  assert.equal(describeSelection(sel), 'CE 79800 x10 @ 18');
});

test('an else strike that was never named is the rule\'s own: a strategy saved before the else had one', () => {
  for (const elseOtm of [null, undefined]) assert.equal(pickStrike(BOARD, 'C', orElse('atLeast', 15, 5, elseOtm))?.strike, 80_600);
});

test('[critical] the run names the else strike and the rule it answered -- even when the else lands on the premium\'s own strike', () => {
  const far = selectLegs(strat({ legs: 'CE', lots: 3, premium: { mode: 'atLeast', usd: 15, minOtm: 5, elseOtm: 6 } }), BOARD);
  assert.deepEqual([far.legs[0]!.strike, far.legs[0]!.minOtm, far.legs[0]!.elseOtm], [81_000, 5, 6]);
  assert.deepEqual(far.legs[0]!.premiumPick, { strike: 79_800, price: 18 });
  assert.equal(describeSelection(far), 'CE 81000 x3 @ 3 (rule failed: the premium\'s strike 79800 @ 18 is nearer than OTM 5 — sold the else strike OTM 6)');
  // the premium picks OTM 3, the rule wants OTM 5, and the else names OTM 3: the same strike, sold by the else
  const same = selectLegs(strat({ legs: 'CE', lots: 3, premium: { mode: 'atLeast', usd: 15, minOtm: 5, elseOtm: 3 } }), BOARD);
  assert.deepEqual([same.legs[0]!.strike, same.legs[0]!.elseOtm], [79_800, 3]);
  assert.equal(describeSelection(same), 'CE 79800 x3 @ 18 (rule failed: the premium\'s strike 79800 @ 18 is nearer than OTM 5 — sold the else strike OTM 3)');
  // no strike met the premium at all: said as that, not as a strike that was too near
  const none = selectLegs(strat({ legs: 'CE', lots: 3, premium: { mode: 'atLeast', usd: 500, minOtm: 5, elseOtm: 6 } }), BOARD);
  assert.equal(none.legs[0]!.premiumPick, null);
  assert.equal(describeSelection(none), 'CE 81000 x3 @ 3 (rule failed: no strike met the premium — sold the else strike OTM 6)');
});

test('[critical] an else strike that is not on the board refuses the leg, and names it', () => {
  // puts: at least $15 picks OTM 3; the rule is OTM 4; the else, OTM 6, is not listed
  const sel = selectLegs(strat({ legs: 'PE', premium: { mode: 'atLeast', usd: 15, minOtm: 4, elseOtm: 6 } }), BOARD);
  assert.deepEqual(sel.legs, []);
  assert.equal(sel.refusals[0], "PE: rule failed — the premium's strike 77400 @ 16 is nearer than OTM 4 — and the else strike OTM 6 is not listed with a price");
  // and when the premium found nothing either, the refusal says that half too
  const nothing = selectLegs(strat({ legs: 'PE', premium: { mode: 'atLeast', usd: 500, fallbackUsd: 400, minOtm: 4, elseOtm: 6 } }), BOARD);
  assert.equal(nothing.refusals[0], 'PE: rule failed — nothing out of the money paying $500, nor $400 — and the else strike OTM 6 is not listed with a price');
  // the rule's own strike is listed, and is not sold: the else named another
  assert.equal(pickStrike(BOARD, 'P', orElse('atLeast', 15, 4, 4))?.strike, 77_000);
});

test('both sides read the same two strikes, each counted out from the money on its own side', () => {
  const sel = selectLegs(strat({ legs: 'both', lots: 1, premium: { mode: 'atMost', usd: 100, minOtm: 3, elseOtm: 4 } }), BOARD);
  // at most $100: the call at OTM 1 (60) and the put at OTM 1 (55) -- both nearer than OTM 3, both sold at OTM 4
  assert.deepEqual(sel.legs.map((l) => [l.cp, l.strike, l.elseOtm]), [['C', 80_200, 4], ['P', 77_000, 4]]);
});
