import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The ledger (owner, 29 Oct 2026: "day by day -- profit, loss, charges, others; my system's P&L and the Delta app's
 * reconciled, checked every day at 11:59 PM and synced by hand"). The desk's day from its journal, Delta's from a
 * wallet these tests write; judged, kept, shown, and checked by itself at 11:59 PM and for a day it missed.
 */

const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'ledger-master';
process.env.DELTA_API_KEY = 'ldgKEYldgKEYldgKEY1111';
process.env.DELTA_API_SECRET = 'ldgSECRETldgSECRETldgSECRETldgSECRETldgSECRET';
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, query } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { brokerAccounts } = await import('../../src/delta/accounts.js');
const { istDate } = await import('../../src/strategy/schedule.js');
const L = await import('../../src/ledger/ledger.js');
const { ledgerAlert } = await import('../../src/notify/messages.js');

await initTradingService();
await initStrategyStore();
await L.ledgerSchema();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'ledger-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('ledger-master'), now: Date.now }) });
});
after(async () => { L.setWalletReader(null); L.setLedgerPaper(null); tradingService().stop(); await app.close(); await closePool(); });

const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
  const r = await app.inject({ method, url, headers: { cookie: `${COOKIE}=${encodeURIComponent('ledger-session')}` }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};

const DAY_MS = 86_400_000;
const NOW = Date.now();
const YESTERDAY = istDate(NOW - DAY_MS);
const noonOf = (day: string) => Date.parse(`${day}T12:00:00+05:30`);
let seq = 0;
/** A short sold at 40 and bought back at `exit`, on `day` at noon IST. */
async function trade(day: string, exit: number, account: number) {
  const id = `P-BTC-84000-LG-${++seq}`;
  const at = noonOf(day) + seq * 60_000;
  const fills = [
    { orderId: `${id}-e`, role: 'entry', side: 'sell', size: 10, price: 40, ts: at - 600_000 },
    { orderId: `${id}-x`, role: 'take_profit', side: 'buy', size: 10, price: exit, ts: at },
  ];
  const plan = { tradeId: id, symbol: 'P-BTC-84000-281026', origin: 'strategy', strategyId: '15m-time', strategyName: '15m time', accountId: account, lots: 10,
    entry: { type: 'limit', limitPrice: 40, timeoutMs: 5000, marketFallback: false }, takeProfitPrice: 4, stopPrice: 140 };
  const state = { tradeId: id, symbol: plan.symbol, productId: 1, phase: 'flat', position: 0, optionSide: 'PE', contractValue: 0.001, requestedSize: 10,
    entrySize: 10, entryAvgPrice: 40, exitSize: 10, exitAvgPrice: exit, realisedPnl: (40 - exit) * 10 * 0.001, exitWinner: 'take_profit', exitReason: null, fills, updatedAt: at,
    protection: { takeProfit: null, stopLoss: null }, wantsProtection: true };
  await query('INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at, broker_account_id) VALUES ($1, $2, $3, 0, $4, $5, $6, $7)',
    [id, plan.symbol, 'flat', JSON.stringify(plan), JSON.stringify(state), at, account]);
}

/** Delta's wallet for a day that booked `tradingUsd` and charged `chargesUsd`, a fee written as a positive debit. */
const wallet = (tradingUsd: number, chargesUsd: number, at: number) => {
  let bal = 500;
  const rows = [
    { id: 'w1', at, type: 'cashflow', amount: tradingUsd, balance: (bal += tradingUsd) },
    { id: 'w2', at: at + 1, type: 'commission', amount: chargesUsd, balance: (bal -= chargesUsd) },
    { id: 'w3', at: at + 2, type: 'deposit', amount: 50, balance: (bal += 50) },
  ];
  return { entries: rows.map((r) => ({ ...r, asset: 'USD' })), complete: true };
};

let one = 0;
let two = 0;
let desk = { realisedUsd: 0, chargesUsd: 0, netUsd: 0 };

test('[critical] a day checked by hand: the desk\'s profit, loss and charges, Delta\'s wallet beside them, a match within the tolerance', async () => {
  one = brokerAccounts().default()!.id;
  two = (await brokerAccounts().create({ name: 'Second', apiKey: 'ldgKEYtwoKEYtwo2222', apiSecret: 'ldgSECRETtwoSECRETtwoSECRETtwo2222' })).id;
  await trade(YESTERDAY, 4, one);       // +0.36 booked
  await trade(YESTERDAY, 90, one);      // −0.50 booked
  await trade(YESTERDAY, 10, one);      // +0.30 booked
  L.setLedgerPaper(() => false);

  const before = await call('GET', `/api/ledger?from=${YESTERDAY}&to=${YESTERDAY}&account=${one}`);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const d0 = before.body.days[0];
  assert.equal(d0.status, 'unchecked');
  assert.ok(Math.abs(d0.desk.realisedUsd - 0.16) < 1e-9 && Math.abs(d0.desk.profitUsd - 0.66) < 1e-9 && Math.abs(d0.desk.lossUsd - 0.5) < 1e-9, JSON.stringify(d0.desk));
  assert.ok(d0.desk.chargesUsd > 0 && d0.desk.trades === 3);
  desk = d0.desk;

  // Delta booked the same, its fee within a cent of the desk's formula.
  L.setWalletReader(async () => wallet(desk.realisedUsd, desk.chargesUsd + 0.01, noonOf(YESTERDAY)));
  const s = await call('POST', '/api/ledger/sync', { day: YESTERDAY, accountId: one });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.rows.length, 1);
  assert.equal(s.body.rows[0].status, 'match');
  assert.ok(Math.abs(s.body.rows[0].diffUsd - 0.01) < 1e-9);

  const after = (await call('GET', `/api/ledger?from=${YESTERDAY}&to=${YESTERDAY}&account=${one}`)).body;
  const d = after.days[0];
  assert.equal(d.status, 'match');
  assert.equal(d.how, 'manual');
  assert.ok(Math.abs(d.delta.tradingUsd - desk.realisedUsd) < 1e-9);
  assert.ok(Math.abs(d.delta.chargesUsd + desk.chargesUsd + 0.01) < 1e-9, 'Delta\'s fee, a debit written positive, counted as paid');
  assert.equal(d.delta.transfersUsd, 50, 'the deposit beside, not in the net');
  assert.equal(after.totals.matched, 1);
  assert.equal(after.totals.checked, 1);
});

test('[critical] a mismatch says where it lies -- in the charges, or in what the trades booked; an unread wallet is said, never a match', async () => {
  L.setWalletReader(async () => wallet(desk.realisedUsd - 0.5, desk.chargesUsd, noonOf(YESTERDAY)));
  let r = (await call('POST', '/api/ledger/sync', { day: YESTERDAY, accountId: one })).body.rows[0];
  assert.equal(r.status, 'mismatch');
  assert.ok(Math.abs(r.diffUsd - 0.5) < 1e-9);
  assert.match(r.detail, /Charges agree: the difference is in what the trades booked\./);

  L.setWalletReader(async () => wallet(desk.realisedUsd, desk.chargesUsd + 0.4, noonOf(YESTERDAY)));
  r = (await call('POST', '/api/ledger/sync', { day: YESTERDAY, accountId: one })).body.rows[0];
  assert.equal(r.status, 'mismatch');
  assert.match(r.detail, /Charges differ by \$0\.40/);

  L.setWalletReader(async () => { throw new Error('Delta refused the request (unauthorized).'); });
  r = (await call('POST', '/api/ledger/sync', { day: YESTERDAY, accountId: one })).body.rows[0];
  assert.equal(r.status, 'unread');
  assert.match(r.detail, /could not be read: Delta refused the request \(unauthorized\)\./);

  L.setLedgerPaper(() => true);
  r = (await call('POST', '/api/ledger/sync', { day: YESTERDAY, accountId: one })).body.rows[0];
  assert.equal(r.status, 'paper');
  L.setLedgerPaper(() => false);
});

test('[critical] a read that came back short is not judged a mismatch: fewer wallet entries than the desk\'s trades is said as unread, with what the read saw', async () => {
  // 30 Oct 2026, live: one commission entry a day against hundreds of fills, every day called "charges differ".
  const at = noonOf(YESTERDAY);
  L.setWalletReader(async () => ({
    entries: [{ id: 'one', at, type: 'commission', amount: 0.00007, balance: 65.35, asset: 'USD' }], complete: true,
    read: { pages: 1, rows: 214, kept: 1, outside: 0, unparsed: 213, firstAt: '1730271234567890', lastAt: '2026-10-29T06:30:00Z' },
  }));
  const r = (await call('POST', '/api/ledger/sync', { day: YESTERDAY, accountId: one })).body.rows[0];
  assert.equal(r.status, 'unread');
  assert.equal(r.diffUsd, null);
  assert.match(r.detail, /Delta's wallet gave 1 entry for the desk's 3 trades: the read came back short, so the day is not judged\./);
  assert.match(r.detail, /Read: 1 page, 214 rows from Delta, 1 of the day, 0 outside it, 213 with no readable time; times as Delta wrote them: 1730271234567890 … 2026-10-29T06:30:00Z\./);
  assert.equal(r.delta.read.unparsed, 213, 'the read kept with the check');
});

test('[critical] every account: each account\'s verdict beside the sum; a day changed since its check is said', async () => {
  L.setWalletReader(async (id) => (id === one ? wallet(desk.realisedUsd, desk.chargesUsd, noonOf(YESTERDAY)) : { entries: [], complete: true }));
  const s = await call('POST', '/api/ledger/sync', { day: YESTERDAY });
  assert.deepEqual(s.body.rows.map((r: any) => [r.accountId, r.status]).sort(), [[one, 'match'], [two, 'match']].sort(), 'an account with nothing on either side matches');
  const all = (await call('GET', `/api/ledger?from=${YESTERDAY}&to=${YESTERDAY}`)).body;
  const d = all.days[0];
  assert.equal(d.status, 'match');
  assert.deepEqual(d.perAccount.map((p: any) => [p.name, p.status]).sort(), [[brokerAccounts().get(one)!.name, 'match'], ['Second', 'match']].sort());
  assert.equal(d.changed, false);

  // A trade of the day found after the check: the desk's figure moves, the check's does not, and the screen says so.
  await trade(YESTERDAY, 4, one);
  const later = (await call('GET', `/api/ledger?from=${YESTERDAY}&to=${YESTERDAY}&account=${one}`)).body.days[0];
  assert.equal(later.changed, true);
  assert.ok(later.desk.netUsd > later.checkedDeskUsd);
});

test('[critical] checked by itself at 11:59 PM IST, once a day an account; a missed day of the last week caught up, one at a time', async () => {
  await query('DELETE FROM ledger_days');
  L.setWalletReader(async () => ({ entries: [], complete: true }));
  const today = istDate(NOW);
  const at2359 = Date.parse(`${today}T23:59:20+05:30`);
  await L.ledgerTick(at2359);
  let kept = await L.ledgerRows(null, today, today);
  assert.deepEqual(kept.map((r) => [r.accountId, r.how]).sort(), [[one, 'auto'], [two, 'auto']].sort());
  const first = kept.map((r) => r.checkedAt);
  await L.ledgerTick(at2359 + 30_000);
  kept = await L.ledgerRows(null, today, today);
  assert.deepEqual(kept.map((r) => r.checkedAt), first, 'not checked twice');

  // The week's missed days, the oldest first, one account a minute: the second tick above took the first of them.
  const oldest = istDate(at2359 - 7 * DAY_MS);
  let week = await L.ledgerRows(null, oldest, istDate(at2359 - DAY_MS));
  assert.deepEqual(week.map((r) => [r.day, r.accountId, r.how]), [[oldest, one, 'auto']]);
  await L.ledgerTick(at2359 + 35_000);            // still 11:59 PM: past midnight the week would be another one
  week = await L.ledgerRows(null, oldest, istDate(at2359 - DAY_MS));
  assert.deepEqual(week.map((r) => [r.day, r.accountId]).sort(), [[oldest, one], [oldest, two]].sort(), 'then the other account, the same day');
});

test('the check is refused in words: a day to come, a bad date, too far back, an account not switched on', async () => {
  const future = istDate(NOW + 2 * DAY_MS);
  for (const [body, why] of [
    [{ day: future }, /still to come/], [{ day: '28-10-2026' }, /YYYY-MM-DD/], [{ day: istDate(NOW - 200 * DAY_MS) }, /last 92 days/], [{ accountId: 999 }, /No such account/],
  ] as const) {
    const r = await call('POST', '/api/ledger/sync', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
  const r = await call('GET', `/api/ledger?from=${istDate(NOW - 100 * DAY_MS)}&to=${istDate(NOW)}`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /At most 92 days/);
});

test('the phone hears of a mismatch: both nets, the difference and where it lies', () => {
  const a = ledgerAlert({ account: 'High', day: '2026-10-28', deskUsd: 6.24, deltaUsd: 6.08, detail: 'Charges agree: the difference is in what the trades booked.' });
  assert.equal(a.key, 'ledger:High:2026-10-28');
  assert.match(a.text, /LEDGER OFF · High · 2026-10-28/);
  assert.match(a.text, /Desk <b>\+₹530\.40<\/b> \(\+\$6\.24\) · Delta <b>\+₹516\.80<\/b> \(\+\$6\.08\) · off by ₹13\.60 \(\$0\.16\)/);
});
