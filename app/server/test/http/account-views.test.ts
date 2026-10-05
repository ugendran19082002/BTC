import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Orders, P&L and strategies by broker account (owner, 5 Oct 2026).
 *
 * A desk with the account imported from `.env`, on paper: what it already had
 * belongs to that account, what it places is stamped with it, a second account
 * has its own strategies and its own (empty) record, and no account asked for
 * is every account, as every one of these routes answered before.
 */

const dir = mkdtempSync(join(tmpdir(), 'account-views-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'account-views-master';
process.env.DELTA_API_KEY = 'envKEYenvKEYenvKEY9999';
process.env.DELTA_API_SECRET = 'envSECRETenvSECRETenvSECRETenvSECRETenvSECRET';
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, one, query, rows } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore, strategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { brokerAccounts } = await import('../../src/delta/accounts.js');
const { DEFAULT_CONFIG, onDeskAccount } = await import('../../src/strategy/types.js');
const { istDate } = await import('../../src/strategy/schedule.js');

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'views-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });


/** Two-step sign-in set up, and a clock the test moves: an authenticator code is good once, so each removal takes the next. */
const { base32Encode, totp } = await import('../../src/auth/totp.js');
const { randomBytes } = await import('node:crypto');
const TOTP_SECRET = base32Encode(randomBytes(20));
let clock = Date.now();
const nextCode = () => { clock += 30_000; return totp(TOTP_SECRET, clock); };
await auth.enableTotp(new Secrets('account-views-master').seal(TOTP_SECRET), -1, Date.now());

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({
    auth: new AuthService({ store: auth, secrets: new Secrets('account-views-master'), now: () => clock }),
    accountTest: async () => ({ ok: true, detail: 'Connected.' }),
    accountSummary: async () => [{ balance: 120.5, available: 100 }, [
      { symbol: 'P-BTC-83800-230926', productId: 1, size: -3, entryPrice: 20, unrealisedPnl: 1.5, markPrice: 19.5 },
      { symbol: 'C-BTC-90000-230926', productId: 2, size: 0, entryPrice: null, unrealisedPnl: null, markPrice: null },
    ] as never],
  });
});
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('views-session')}` };
const api = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: cookie, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as Record<string, any>, text: r.body };
};
const main = () => brokerAccounts().default()!.id;
let second = 0;

test('[critical] what the desk already had belongs to the account it had: its strategies are that account\'s', async () => {
  assert.equal(tradingService().accountId, main(), 'the desk stamps what it does with the default account');
  const stored = await rows<{ id: string; broker_account_id: string | null }>('SELECT id, broker_account_id FROM strategies ORDER BY id');
  assert.ok(stored.length >= 3);
  assert.ok(stored.every((s) => Number(s.broker_account_id) === main()), 'every strategy there was is given the first account');

  second = (await brokerAccounts().create({ name: 'Second', apiKey: 'newKEYnewKEYnewKEY4242', apiSecret: 'newSECRETnewSECRETnewSECRETnewSECRETnewSECRET' })).id;
  const all = await api('GET', '/api/strategies');
  const mine = await api('GET', `/api/strategies?account=${main()}`);
  const theirs = await api('GET', `/api/strategies?account=${second}`);
  assert.equal(mine.body.strategies.length, all.body.strategies.length);
  assert.deepEqual(theirs.body.strategies, [], 'a new account starts with none');
  assert.equal((await api('GET', '/api/strategies?account=999')).body.strategies.length, all.body.strategies.length, 'an account that is not one: every account');
});

test('[critical] a strategy is made for one account, keeps it when saved again, and does not enter while the desk is on another', async () => {
  const made = await api('POST', '/api/strategies', { name: 'Second only', config: DEFAULT_CONFIG, accountId: second });
  assert.equal(made.status, 200, made.text);
  assert.equal(made.body.strategy.accountId, second);
  const forMain = await api('POST', '/api/strategies', { name: 'Main only', config: DEFAULT_CONFIG });
  assert.equal(forMain.body.strategy.accountId, main(), 'no account named: the one the desk is on');
  assert.equal((await api('POST', '/api/strategies', { name: 'Nobody', config: DEFAULT_CONFIG, accountId: 999 })).status, 422);

  // Saved again from another tab's form: it stays where it was made.
  const again = await api('POST', '/api/strategies', { id: 'second-only', name: 'Second only', config: DEFAULT_CONFIG, accountId: main() });
  assert.equal(again.body.strategy.accountId, second);
  const copy = await api('POST', '/api/strategies/second-only/clone', { name: 'Second copy' });
  assert.equal(copy.body.strategy.accountId, second, 'a copy belongs where its source does');

  const theirs = await api('GET', `/api/strategies?account=${second}`);
  assert.deepEqual(theirs.body.strategies.map((s: { id: string }) => s.id).sort(), ['second-copy', 'second-only']);
  assert.ok(theirs.body.strategies.every((s: { status: string }) => s.status === 'not entering: the desk is trading on another account'));
  const mine = await api('GET', `/api/strategies?account=${main()}`);
  assert.ok(mine.body.strategies.some((s: { id: string }) => s.id === 'main-only'));
  assert.ok(!mine.body.strategies.some((s: { id: string }) => s.id === 'second-only'));
  assert.ok(mine.body.strategies.every((s: { status: string }) => s.status !== 'not entering: the desk is trading on another account'));

  // The rule the scheduler and the signals run on.
  assert.equal(onDeskAccount({ accountId: second }, main()), false, 'another account\'s: not entered');
  assert.equal(onDeskAccount({ accountId: main() }, main()), true);
  assert.equal(onDeskAccount({ accountId: null }, main()), true, 'a strategy of no account enters wherever the desk is');
  assert.equal(onDeskAccount({ accountId: second }, null), true, 'a desk with no account holds nothing back');
});

test('[critical] an order is stamped with the account it was placed as, and the orders and the P&L are read by it', async () => {
  const svc = tradingService();
  const EXPIRY_TS = Math.floor(Date.now() / 1000) + 86_400;
  const SYMBOL = 'P-BTC-83800-230926';
  svc.paper()!.addProduct({
    symbol: SYMBOL, productId: 9001, underlying: 'BTC', optionSide: 'PE', strike: 83_800, expiryTs: EXPIRY_TS,
    tickSize: 0.1, lotSize: 1, contractValue: 0.001, state: 'live',
  });
  svc.paper()!.setQuote({ symbol: SYMBOL, bid: 20, ask: 20.5, bidSize: 5_000, askSize: 5_000, mark: 20.25, ts: Date.now() });
  const res = await svc.place({ symbol: SYMBOL, optionSide: 'PE', strike: 83_800, expiryTs: EXPIRY_TS, lots: 1, leverage: 200, limitPrice: 20, takeProfitPct: 0.8, stopPrice: 70 });
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = await one<{ broker_account_id: string | null; plan: { accountId?: number } }>('SELECT broker_account_id, plan FROM trades WHERE trade_id = $1', [res.state.tradeId]);
  assert.equal(Number(row!.broker_account_id), main());
  assert.equal(row!.plan.accountId, main());

  const ids = async (q: string) => ((await api('GET', `/api/trade/history${q}`)).body.trades as { tradeId: string }[]).map((o) => o.tradeId);
  assert.deepEqual(await ids(''), [res.state.tradeId], 'no account asked for: every account');
  assert.deepEqual(await ids(`?account=${main()}`), [res.state.tradeId]);
  assert.deepEqual(await ids(`?account=${second}`), [], 'the other account placed nothing');
  assert.equal(await svc.store.countFor(main()), 1);
  assert.equal(await svc.store.countFor(second), 0);

  // The day's line is taken as the account the desk is on, and read back by it.
  await svc.sampleMtm();
  const today = istDate(Date.now());
  const line = async (q: string) => (await api('GET', `/api/report/mtm?day=${today}${q}`)).body;
  assert.equal((await line('')).samples.length, 1);
  assert.equal((await line(`&account=${main()}`)).samples.length, 1);
  assert.deepEqual([(await line(`&account=${second}`)).samples, (await line(`&account=${second}`)).days], [[], []]);
  const days = await api('GET', `/api/report/days?account=${second}`);
  assert.equal(days.status, 200, days.text);
});

test('[critical] the limits are each account\'s own: the most open at once, the most lots short, and today\'s booked P&L', async () => {
  const svc = tradingService();
  const setting = async (key: string) => (await one<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]))?.value ?? null;

  // The most open at once: set on an account's tab, kept under that account, held to that account's strategies.
  await api('POST', '/api/strategies/second-only/enabled', { enabled: true });
  const sig = { mode: 'mtf', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen: 4, enterOn: 'zone' };
  assert.equal((await api('POST', '/api/strategies', { name: 'Second sig', config: { ...DEFAULT_CONFIG, trigger: 'signal', signal: sig, liveOrders: false }, accountId: second })).status, 200);
  await api('POST', '/api/strategies/second-sig/enabled', { enabled: true });
  const over = await api('POST', '/api/strategies/max-open', { max: 9, accountId: second });
  assert.equal(over.status, 422, 'above what that account\'s own strategies allow: a cap that could never bind');
  assert.equal((await api('POST', '/api/strategies/max-open', { max: 3, accountId: second })).status, 200);
  assert.equal(await setting(`signal_max_open@${second}`), '3');
  assert.equal(await setting('signal_max_open'), null, 'the desk-wide value is not touched');
  assert.equal((await api('GET', `/api/strategies?account=${second}`)).body.signalMaxOpen, 3);
  assert.equal((await api('GET', `/api/strategies?account=${main()}`)).body.signalMaxOpen, 0, 'the other account has none of its own');
  // A value from before there were accounts still holds for an account with none of its own.
  await svc.settings.set('signal_max_open', '7');
  assert.equal((await api('GET', `/api/strategies?account=${main()}`)).body.signalMaxOpen, 7);
  assert.equal((await api('GET', `/api/strategies?account=${second}`)).body.signalMaxOpen, 3, 'its own comes first');

  // Looking at an account the desk is not trading on: the desk's wallet and holdings are not shown as its.
  const theirs = (await api('GET', `/api/strategies?account=${second}`)).body;
  assert.deepEqual([theirs.walletUsd, theirs.marginUsedUsd, theirs.openNow, theirs.shortNow], [null, null, 0, 0]);
  assert.equal((await api('GET', `/api/strategies?account=${main()}`)).body.openNow, 1, 'the trading account\'s own open trade');

  // The most lots short: kept for the account it is set on.
  assert.deepEqual(await svc.setShortCap(40), { ok: true, cap: 40 });
  assert.equal(await setting(`max_short_contracts@${main()}`), '40');
  assert.equal(await setting('max_short_contracts'), null);
  assert.equal(svc.shortCapSetting, 40);
  assert.equal((await api('GET', '/api/settings')).body.settings.max_short_contracts, '40');

  // Today's booked P&L -- what the daily-loss gate reads -- is one account's, not the day's across accounts.
  await query(`UPDATE trades SET state = jsonb_set(jsonb_set(state, '{fills}', $1::jsonb), '{position}', '0'), phase = 'flat'`, [JSON.stringify([
    { orderId: 'a', clientOrderId: 'a', role: 'entry', side: 'sell', size: 1, price: 20, ts: Date.now() - 1_000 },
    { orderId: 'b', clientOrderId: 'b', role: 'stop_loss', side: 'buy', size: 1, price: 50, ts: Date.now() },
  ])]);
  await query('UPDATE trades SET updated_at = $1', [Date.now()]);
  const lost = await svc.store.realisedSince(0, main());
  assert.ok(lost < 0, `the trading account booked a loss: ${lost}`);
  assert.equal(await svc.store.realisedSince(0, second), 0, 'none of it is the other account\'s');
  assert.equal(await svc.store.realisedSince(0), lost, 'no account asked for: every account\'s, as before');
});

test('[critical] an account with trades or strategies on record is kept, not removed; one with none can go', async () => {
  const kept = await api('POST', `/api/accounts/${second}/remove`, { code: nextCode() });
  assert.deepEqual([kept.status, kept.body.error], [409, 'This account has 3 strategies on record, so it is kept. Deactivate it instead.']);
  const third = (await brokerAccounts().create({ name: 'Third', apiKey: 'thirdKEYthirdKEY7777', apiSecret: 'thirdSECRETthirdSECRETthirdSECRETthirdSECRET' })).id;
  assert.equal((await api('POST', `/api/accounts/${third}/remove`, { code: nextCode() })).status, 200);
  assert.equal(await strategyStore().countFor(second), 3);
});

test('an account the desk is not on, as Delta has it: its wallet and what it holds there, read with its own key', async () => {
  const s = await api('GET', `/api/accounts/${second}/summary`);
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(s.body.wallet, { balance: 120.5, available: 100 });
  assert.deepEqual(s.body.positions.map((p: { symbol: string; size: number }) => [p.symbol, p.size]), [['P-BTC-83800-230926', -3]], 'flat rows left out');
  assert.deepEqual([s.body.trades, s.body.strategies, s.body.note], [0, 3, null]);
  assert.ok(!s.text.includes('newSECRET'));
  assert.equal((await api('GET', '/api/accounts/999/summary')).status, 404);
});
