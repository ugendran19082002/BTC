import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowsOf, walletOf, MONEY_TYPES, type FlowDay } from '../../src/ledger/flows.js';

/** Money in and out of an account (owner, 20 Nov 2026: "total withdraw, total investment"), from the ledger days kept. */

const day = (account: number, d: string, byType: FlowDay['byType'], closingUsd: number | null = null): FlowDay => ({ account, day: d, byType, closingUsd });
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

test('[critical] deposits and money moved in are in; withdrawals and money moved out are out; trading and charges are neither', () => {
  const f = flowsOf([
    day(1, '2026-11-01', { deposit: { n: 1, usd: 500 }, cashflow: { n: 40, usd: 30 }, commission: { n: 40, usd: -4 } }),
    day(1, '2026-11-05', { withdrawal: { n: 2, usd: -200 }, sub_account_transfer: { n: 1, usd: 102.68 } }),
    day(1, '2026-11-09', { sub_account_transfer: { n: 3, usd: -46.56 }, settlement: { n: 1, usd: -0.64 } }),
  ]);
  near(f.inUsd, 602.68, 'in: the deposit and the transfer in');
  near(f.outUsd, 246.56, 'out: the withdrawals and the transfer out');
  near(f.netUsd, 356.12, 'net put in');
  assert.equal(f.moves, 7);
  assert.equal(f.firstMoveDay, '2026-11-01');
  assert.equal(f.lastMoveDay, '2026-11-09');
});

test('[critical] a day kept since 20 Nov has both directions of one kind; an older day only the net, read by its sign', () => {
  // Two transfers in one day, 300 in and 100 out: the new day keeps both, the old one only +200.
  const fresh = flowsOf([day(2, '2026-11-20', { sub_account_transfer: { n: 2, usd: 200, inUsd: 300, outUsd: 100 } })]);
  near(fresh.inUsd, 300, 'gross in'); near(fresh.outUsd, 100, 'gross out'); near(fresh.netUsd, 200, 'net');
  const old = flowsOf([day(2, '2026-11-10', { sub_account_transfer: { n: 2, usd: 200 } })]);
  near(old.inUsd, 200, 'only the net, as in'); near(old.outUsd, 0, 'nothing known out'); near(old.netUsd, 200, 'the net is the same either way');
});

test('a day with no money moved, or never read, adds nothing; nothing at all is zero', () => {
  const none = flowsOf([day(1, '2026-11-01', { cashflow: { n: 5, usd: 3 } }), day(1, '2026-11-02', null)]);
  assert.deepEqual(none, { inUsd: 0, outUsd: 0, netUsd: 0, moves: 0, firstMoveDay: null, lastMoveDay: null });
  assert.deepEqual(flowsOf([]), none);
});

test('every account together: a transfer between two of them is in for one and out for the other -- the net is unchanged', () => {
  const f = flowsOf([
    day(1, '2026-11-03', { deposit: { n: 1, usd: 1_000 } }),
    day(1, '2026-11-04', { sub_account_transfer: { n: 1, usd: -250 } }),
    day(2, '2026-11-04', { sub_account_transfer: { n: 1, usd: 250 } }),
  ]);
  near(f.netUsd, 1_000, 'only the deposit is new money');
});

test('[critical] the wallet: each account\'s latest day read, summed, as of the earliest of those days', () => {
  const w = walletOf([
    day(1, '2026-11-18', null, 200), day(1, '2026-11-19', null, 232.94),
    day(2, '2026-11-17', null, 300), day(2, '2026-11-18', null, null),
  ]);
  near(w.balanceUsd!, 532.94, 'High on the 19th, Medium on the 17th');
  assert.equal(w.asOf, '2026-11-17');
  assert.equal(w.accounts, 2);
  assert.deepEqual(walletOf([day(1, '2026-11-18', null, null)]), { balanceUsd: null, asOf: null, accounts: 0 });
});

test('only money types count: Delta\'s deposit and withdrawal names, and transfers between accounts', () => {
  for (const t of ['deposit', 'withdrawal', 'sub_account_transfer']) assert.ok(MONEY_TYPES.includes(t), t);
  for (const t of ['cashflow', 'commission', 'settlement', 'funding', 'liquidation_fee']) assert.ok(!MONEY_TYPES.includes(t), t);
});
