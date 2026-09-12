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

test('[critical] the safety gate still has its say over a strike picked by position', () => {
  // OTM 1 is 79,000 at 80% and 78,200 at 81%: both below the 95% bar.
  const sel = selectLegs(strat({ strikeRule: 'strict', strikeStep: 1, doubleWhenOneSided: false }), BOARD);
  assert.equal(sel.legs.length, 0);
  assert.match(sel.refusals.join(' '), /79000 is 80\.0%/);
});

/* ------------------------------------------------------------- the gate --- */

test('both legs clearing the gate are both sold, one lot each', () => {
  // atMost $15 -> C 80,200 at 0.96 and P 77,400 at 0.95. Both clear 0.95.
  const sel = selectLegs(strat({ premium: { mode: 'atMost', usd: 15 }, lots: 10 }), BOARD);
  assert.equal(sel.legs.length, 2);
  assert.deepEqual(sel.legs.map((l) => l.lots), [10, 10]);
  assert.deepEqual(sel.refusals, []);
});

test('[critical] a leg below the bar is refused, and the survivor doubles', () => {
  // atLeast $15 -> C 79,800 at 0.94 (refused) and P 77,400 at 0.95 (kept).
  const sel = selectLegs(strat({ premium: { mode: 'atLeast', usd: 15 }, lots: 10 }), BOARD);
  assert.equal(sel.legs.length, 1);
  assert.equal(sel.legs[0]!.cp, 'P');
  assert.equal(sel.legs[0]!.lots, 20, 'the survivor carries the refused leg\'s lot');
  assert.match(sel.refusals.join(' '), /CE: 79800 is 94.0%/);
});

test('the refusal says both numbers, so it can be acted on', () => {
  const sel = selectLegs(strat({ premium: { mode: 'atLeast', usd: 15 } }), BOARD);
  assert.match(sel.refusals[0]!, /94\.0%/);
  assert.match(sel.refusals[0]!, /95\.0% bar/);
});

test('with the gate off, a leg below the bar is sold anyway', () => {
  const sel = selectLegs(
    strat({ premium: { mode: 'atLeast', usd: 15 }, probGate: null, doubleWhenOneSided: false }),
    BOARD,
  );
  assert.equal(sel.legs.length, 2);
  assert.deepEqual(sel.legs.map((l) => l.lots), [10, 10]);
});

test('[critical] a leg with no probability is refused, not passed', () => {
  // A gate that silently passes what it cannot check is not a gate.
  // The put must clear the $15 cap too, or it is refused for price and the
  // test proves nothing about the probability check.
  const board = [leg('C', 80_200, 12, null), leg('P', 77_000, 9, 0.97)];
  const sel = selectLegs(strat({ premium: { mode: 'atMost', usd: 15 } }), board);
  assert.equal(sel.legs.length, 1);
  assert.equal(sel.legs[0]!.cp, 'P');
  assert.match(sel.refusals.join(' '), /no probability/);
});

test('neither leg qualifying sells nothing and says why twice', () => {
  const sel = selectLegs(strat({ premium: { mode: 'atLeast', usd: 15 }, probGate: 0.999 }), BOARD);
  assert.equal(sel.legs.length, 0);
  assert.equal(sel.refusals.length, 2);
});

test('a single-leg strategy never doubles, even alone', () => {
  const sel = selectLegs(
    strat({ legs: 'PE', premium: { mode: 'atMost', usd: 15 }, lots: 10 }),
    BOARD,
  );
  assert.equal(sel.legs.length, 1);
  assert.equal(sel.legs[0]!.lots, 10, 'a CE-only strategy is always one-sided; doubling it would double every day');
});

test('a board with no puts refuses the put and doubles the call', () => {
  const callsOnly = BOARD.filter((l) => l.cp === 'C');
  const sel = selectLegs(strat({ premium: { mode: 'atMost', usd: 15 }, lots: 10 }), callsOnly);
  assert.equal(sel.legs.length, 1);
  assert.equal(sel.legs[0]!.lots, 20);
  assert.match(sel.refusals.join(' '), /PE: nothing out of the money/);
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

test('the description carries the refusal when only one leg sold', () => {
  const sel = selectLegs(strat({ premium: { mode: 'atLeast', usd: 15 }, lots: 10 }), BOARD);
  assert.match(describeSelection(sel), /PE 77400 x20 .*below the/s);
});

test('selling nothing still says why', () => {
  const sel = selectLegs(strat({ premium: { mode: 'atLeast', usd: 999 } }), BOARD);
  assert.match(describeSelection(sel), /nothing out of the money paying \$999/);
});
