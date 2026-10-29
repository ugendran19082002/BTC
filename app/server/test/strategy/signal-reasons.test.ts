import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL_REASONS, signalCounts, signalReasons } from '../../src/strategy/signal-reasons.js';

/**
 * Why a signal was not taken, as keys (20 Oct 2026, owner: "Not taken: sub-tabs by reason"). The sentences are the
 * runner's own, as the journal kept them on the live desk over 13-20 Oct (5,926 not taken, every one of them a kind).
 */
const name = '#55 Pulled wall (spoof / pull) SELL | ';
const cases: [string, string, string[]][] = [
  ['skipped', 'SL too near: the perp entry 81645 to the SL 81705 is 61 pts — this strategy takes 5m signals only at 250 pts or more', ['sl-min']],
  ['skipped', 'SL too near: the perp entry 81645 to the SL 81705 is 61 pts — this strategy takes 5m signals only at 250 pts or more; TGT too near: the perp entry 81645 to the TGT 81578 is 67 pts — this strategy takes 5m signals only at 100 pts or more', ['sl-min', 'tgt-min']],
  ['skipped', 'SL too far: the perp entry 81645 to the SL 82705 is 1061 pts — this strategy takes timeframe-chain signals only at 900 pts or less', ['sl-max']],
  ['skipped', 'TGT too far: the perp entry 81645 to the TGT 80000 is 1645 pts — this strategy takes 1h signals only at 1200 pts or less', ['tgt-max']],
  ['skipped', 'inside the no-entry window 4:00 PM – 5:25 PM — no new entry until 5:25 PM', ['no-entry']],
  ['skipped', 'the desk already has 200 open (positions and working orders, all strategies) -- at most 200 at once across all', ['desk-max']],
  ['skipped', 'the desk already has 160 PE open -- at most 160 PE at once (80% of the 200)', ['side-max']],
  ['skipped', 'the desk already has 10 open on PE 83000 -- at most 10 on one strike (10% of the 100)', ['strike-max']],
  ['skipped', 'the desk already has 10 open on CE 85200 -- at most 9 on one strike (10% of the 88) · block 2, from 1:00 PM', ['strike-max']],
  ['skipped', 'already 5 of its trades open (5 live) -- at most 5', ['own-max']],
  ['skipped', 'already 1 of its trade open (1 would-sell) -- at most 1', ['own-max']],
  ['skipped', 'the perp filled at 81645 300s ago -- too late to enter (a 5m signal within 120s)', ['late']],
  ['skipped', 'the perp filled at 81645 and was out (SL) in the same moment', ['over']],
  ['skipped', "the perp is at 81900 now, already at the signal's SL 81791 -- over before it could be entered", ['over']],
  ['skipped', 'no live option board', ['no-board']],
  ['skipped', 'the nearest expiry is not the daily contract', ['no-board']],
  // A refusal: the order's own SL and TGT are not reasons -- only what follows "refused:".
  ['refused', 'sell PE 81400 x1 @ 9 (delta 0.08) · perp filled 81645 · perp SL 81791 · TGT 81578 -- refused: This one pays 9 and the desk will not sell below 10 — the same margin is at risk either way, so a cheaper option is the same risk for less pay.', ['premium']],
  ['refused', 'sell CE 82400 x1 @ 13 (delta 0.1) · perp filled 81645 · perp SL 81791 · TGT 81578 -- refused: Spread is 12.5%, limit is 10% for an order that crosses it.; This one pays 9 and the desk will not sell below 10 — the same margin is at risk either way, so a cheaper option is the same risk for less pay.', ['spread', 'premium']],
  ['refused', 'sell PE 81400 x1 @ 13 · perp filled 81645 · perp SL 81791 · TGT 81578 -- refused: Worst case $40 exceeds the $-2 left in today\'s loss budget.', ['loss-limit']],
  ['refused', 'sell CE 82400 x1 @ 13 (delta 0.1) · perp filled 81645 · perp SL skipped · TGT skipped -- refused: Delta refused the request (max_orders_count_exceeded).', ['delta']],
  ['refused', 'sell PE 81400 x1 @ 13 -- refused: could not set 10x leverage: Delta refused the request (market_disrupted_cancel_only_mode).', ['delta']],
  ['refused', 'PE: no strike out of the money with a delta at or under 0.1 · high volatility (ATM IV): Δ ≤ 0.08', ['no-strike']],
  ['refused', 'refused: PE 81400 has no offer to buy at', ['no-strike']],
  ['failed', 'something nobody wrote a kind for', ['other']],
];

test('[critical] each of the runner\'s sentences read back into its kinds, a refusal by what follows "refused:" alone', () => {
  for (const [status, detail, want] of cases) assert.deepEqual(signalReasons(status, `${name}${detail}`), want, detail.slice(0, 80));
  for (const k of cases.flatMap((c) => c[2])) assert.ok((SIGNAL_REASONS as readonly string[]).includes(k), k);
});

test('a signal taken has no reason', () => {
  for (const s of ['placed', 'would-place', 'claimed']) assert.deepEqual(signalReasons(s, `${name}live orders off: would sell PE 81400`), []);
});

test('[critical] a range counted: taken and its real orders, not taken, and each kind -- a signal with two under both', () => {
  const lines = [
    { status: 'placed', detail: 'sell PE 81400 x1 @ 13' },
    { status: 'would-place', detail: 'live orders off: would sell PE 81400' },
    ...cases.map(([status, detail]) => ({ status, detail: `${name}${detail}` })),
  ];
  const c = signalCounts(lines);
  assert.equal(c.all, cases.length + 2);
  assert.equal(c.taken, 2);
  assert.equal(c.placed, 1, 'only the real order');
  assert.equal(c.notTaken, cases.length);
  assert.equal(c.byReason['sl-min'], 2, 'the SL-and-TGT signal is under SL too');
  assert.equal(c.byReason['tgt-min'], 1);
  assert.equal(c.byReason.premium, 2, 'the spread-and-premium refusal is under premium too');
  assert.equal(c.byReason.other, 1);
  assert.equal(Object.values(c.byReason).reduce((a, n) => a + (n ?? 0), 0), cases.flatMap((x) => x[2]).length);
  assert.deepEqual(signalCounts([]), { all: 0, taken: 0, placed: 0, notTaken: 0, byReason: {} });
});
