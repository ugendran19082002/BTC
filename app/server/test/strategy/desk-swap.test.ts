import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDeskSwap } from '../../src/strategy/runner.js';
import type { SwapCandidate } from '../../src/strategy/types.js';

/**
 * Swap on every signal across every account (owner, 27 Nov 2026: "entry on the signal's account, but the swap exit --
 * all accounts combined, the top TGT% exits"). The pick is pure: the runner gathers the sales of every account's desk,
 * priced on the board, and claims the one picked before anything else runs.
 */

type C = SwapCandidate & { account: number; symbol: string };
const c = (tradeId: string, account: number, soldAt: number, askNow: number | null, side: 'CE' | 'PE' = 'PE'): C =>
  ({ tradeId, side, soldAt, askNow, account, symbol: `${side === 'PE' ? 'P' : 'C'}-BTC-60400-271126` });

// 27 Nov 2026, 12:35, as the desk held it: account 1 at 85.7 / 83.1 / 81.8 / 81.8%, the others 75.5-77%.
const desk: C[] = [
  c('a1-857', 1, 63, 9), c('a1-831', 1, 71, 12), c('a1-818a', 1, 66, 12), c('a1-818b', 1, 66, 12),
  c('a2-755', 2, 49, 12), c('a3-763', 3, 50.6, 12), c('a4-770', 4, 52.2, 12),
];

test('[critical] the sale that has kept the most on ANY account is picked, whichever account the signal came on', () => {
  const p = pickDeskSwap(desk, 75, new Set());
  assert.equal(p?.tradeId, 'a1-857');
  assert.equal(p?.account, 1, 'bought back on its own account (1), though the signal may be on account 4');
  assert.ok(Math.abs(p!.kept - (1 - 9 / 63)) < 1e-9);
});

test('[critical] one signal on all four accounts: each runner claims as it picks, so the four take the top four -- never one sale twice', () => {
  const claimed = new Set<string>();
  const picks: string[] = [];
  for (let i = 0; i < 4; i++) {
    const p = pickDeskSwap(desk, 75, claimed)!;
    claimed.add(p.tradeId);
    picks.push(p.tradeId);
  }
  assert.deepEqual(picks.slice(0, 2), ['a1-857', 'a1-831']);
  assert.deepEqual(new Set(picks.slice(2)), new Set(['a1-818a', 'a1-818b']));
  assert.equal(new Set(picks).size, 4, 'four different sales');
  // The fifth: account 1 has nothing left at the top -- account 4's 77% next, then 3, then 2.
  const fifth = pickDeskSwap(desk, 75, claimed)!;
  assert.equal(fifth.tradeId, 'a4-770');
});

test('[critical] the share asked holds desk-wide; none far enough, or none priced: no swap', () => {
  assert.equal(pickDeskSwap(desk, 90, new Set()), null, 'nothing anywhere has kept 90%');
  assert.equal(pickDeskSwap(desk, 85, new Set())?.tradeId, 'a1-857', '85.7% is over 85');
  assert.equal(pickDeskSwap([c('x', 2, 50, null)], 50, new Set()), null, 'no price: never picked');
  assert.equal(pickDeskSwap([], 75, new Set()), null);
});

test('one account alone: the same pick as before -- its own top sale', () => {
  const mine = desk.filter((x) => x.account === 4);
  assert.equal(pickDeskSwap(mine, 75, new Set())?.tradeId, 'a4-770');
});

test('calls and puts alike: the every-signal swap is not held to a side', () => {
  const both = [c('pe', 1, 50, 10, 'PE'), c('ce', 2, 50, 5, 'CE')];
  assert.equal(pickDeskSwap(both, 75, new Set())?.tradeId, 'ce');
});
