import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf, signsOf, walletDayOf, type WalletEntry } from '../../src/ledger/wallet.js';

/**
 * A day of Delta's wallet summed (29 Oct 2026, the ledger): by what each entry is, its sign read off Delta's own
 * balance column -- nothing assumed about how Delta writes a fee (decision 0002).
 */
const AT = Date.UTC(2026, 9, 28, 6, 0);
let n = 0;
const e = (type: string, amount: number, balance: number, asset = 'USD'): WalletEntry => ({ id: String(++n), at: AT + n * 1_000, type, amount, balance, asset });

// Opened at 1,000. A fee written as a positive debit (the balance falls by it), as a wallet may write it.
const DAY = [
  e('deposit', 100, 1_100),
  e('cashflow', 0.2, 1_100.2),
  e('commission', 0.07, 1_100.13),
  e('cashflow', -0.05, 1_100.08),
  e('commission', 0.03, 1_100.05),
  e('referral_bonus', 1, 1_101.05),
  e('a_type_added_later', 0.5, 1_101.55),
  e('cashflow', 500, 500, 'INR'),
];
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} against ${b}`);

test('[critical] a day by what each entry is: trading, charges, funding apart from transfers and credits; the net is trading less charges', () => {
  const d = walletDayOf(DAY);
  near(d.tradingUsd, 0.15, 'trading');
  near(d.chargesUsd, -0.10, 'charges, a debit written positive counted as paid');
  near(d.fundingUsd, 0, 'funding');
  near(d.transfersUsd, 100, 'the deposit, not P&L');
  near(d.othersUsd, 1.5, 'the bonus and the unknown type');
  near(d.netUsd, 0.05, 'the net: trading + charges + funding');
  near(d.openingUsd!, 1_000, 'opening balance: before the first entry');
  near(d.closingUsd!, 1_101.55, 'closing balance: after the last');
  assert.equal(d.entries, 7, 'the INR entry is not counted');
  assert.equal(d.otherAssets, 1);
  assert.deepEqual(d.unknownTypes, ['a_type_added_later']);
  assert.deepEqual(d.byType.commission, { n: 2, usd: d.byType.commission!.usd });
  near(d.byType.commission!.usd, -0.10, 'by type');
  assert.equal(d.complete, true);
});

test('[critical] each type\'s sign from the balance: a fee the balance fell by is −1, a credit it rose by +1, a type never measured +1', () => {
  const s = signsOf(DAY.filter((x) => x.asset === 'USD'));
  assert.equal(s.get('commission'), -1);
  assert.equal(s.get('cashflow'), 1);
  assert.equal(s.get('referral_bonus'), 1);
  assert.equal(s.get('deposit'), undefined, 'the first entry has none before it to be measured against');
  // Written signed already, a fee is counted as it is.
  const signed = [e('cashflow', 1, 11), e('commission', -0.07, 10.93), e('cashflow', 1, 11.93)];
  assert.equal(signsOf(signed).get('commission'), 1);
  near(walletDayOf(signed).chargesUsd, -0.07, 'the same charge either way');
});

test('an empty day, and an unfinished read said as such', () => {
  const d = walletDayOf([]);
  assert.deepEqual([d.netUsd, d.entries, d.openingUsd, d.closingUsd], [0, 0, null, null]);
  assert.equal(walletDayOf(DAY, false).complete, false);
});

test('every type Delta lists has its bucket; an unknown one is an other, and said', () => {
  for (const [t, b] of [['commission', 'charges'], ['commission_rebate', 'charges'], ['settlement', 'trading'], ['funding', 'funding'],
    ['withdrawal', 'transfers'], ['sub_account_transfer', 'transfers'], ['incident_compensation', 'others']] as const) {
    assert.deepEqual(bucketOf(t), { bucket: b, known: true }, t);
  }
  assert.deepEqual(bucketOf('nothing_like_it'), { bucket: 'others', known: false });
});
