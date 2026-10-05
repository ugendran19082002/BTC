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
const { initTradingService, journal, runAsDesk, tradingService, tradingServiceFor } = await import('../../src/trading/service.js');
const { initStrategyStore, strategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { brokerAccounts } = await import('../../src/delta/accounts.js');
const { DEFAULT_CONFIG } = await import('../../src/strategy/types.js');
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

  // A second account, saved on the screen: switched on, so it has a desk of its own at once and trades beside the first.
  const made = await api('POST', '/api/accounts', { name: 'Second', api_key: 'newKEYnewKEYnewKEY4242', api_secret: 'newSECRETnewSECRETnewSECRETnewSECRETnewSECRET' });
  assert.equal(made.status, 200, made.text);
  second = made.body.accounts.find((a: { name: string }) => a.name === 'Second').id;
  assert.deepEqual(made.body.accounts.map((a: { name: string; trading: boolean; isDefault: boolean }) => [a.name, a.trading, a.isDefault]),
    [['Delta India (from .env)', true, true], ['Second', true, false]], 'both trade; the default is only which comes first');
  assert.ok(tradingServiceFor(second) && tradingServiceFor(second) !== tradingServiceFor(main()), 'a desk each');
  const all = await api('GET', '/api/strategies');
  const mine = await api('GET', `/api/strategies?account=${main()}`);
  const theirs = await api('GET', `/api/strategies?account=${second}`);
  assert.equal(mine.body.strategies.length, all.body.strategies.length);
  assert.deepEqual(theirs.body.strategies, [], 'a new account starts with none');
  assert.equal((await api('GET', '/api/strategies?account=999')).body.strategies.length, all.body.strategies.length, 'an account that is not one: every account');
});

test('[critical] a strategy is made for one account, keeps it when saved again, and trades on that account -- not at all while it is switched off', async () => {
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
  const OFF = 'not entering: its account is switched off';
  assert.ok(theirs.body.strategies.every((s: { status: string }) => s.status !== OFF), 'its account is on: its strategies are in play, at the same time as the other account\'s');
  const mine = await api('GET', `/api/strategies?account=${main()}`);
  assert.ok(mine.body.strategies.some((s: { id: string }) => s.id === 'main-only'));
  assert.ok(!mine.body.strategies.some((s: { id: string }) => s.id === 'second-only'));
  assert.ok(mine.body.strategies.every((s: { status: string }) => s.status !== OFF));

  // Switched off, the account has no desk: its strategies say so, and the other account's are untouched.
  assert.equal((await api('POST', `/api/accounts/${second}/active`, { active: false })).status, 200);
  assert.equal(tradingServiceFor(second), null);
  assert.ok((await api('GET', `/api/strategies?account=${second}`)).body.strategies.every((s: { status: string }) => s.status === OFF));
  assert.ok((await api('GET', `/api/strategies?account=${main()}`)).body.strategies.every((s: { status: string }) => s.status !== OFF));
  assert.equal((await api('POST', `/api/accounts/${second}/active`, { active: true })).status, 200);
  assert.ok(tradingServiceFor(second), 'on again: its desk is back');
  assert.equal(brokerAccounts().default()!.id, main(), 'and the default did not move');
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
  assert.equal(await journal().countFor(main()), 1);
  assert.equal(await journal().countFor(second), 0);

  /*
   * The other account trades at the same moment, on a desk of its own: its own (paper) exchange, its own
   * engine, and a journal that shows each desk only its own trade.
   */
  const theirs = tradingServiceFor(second)!;
  theirs.paper()!.addProduct({
    symbol: SYMBOL, productId: 9001, underlying: 'BTC', optionSide: 'PE', strike: 83_800, expiryTs: EXPIRY_TS,
    tickSize: 0.1, lotSize: 1, contractValue: 0.001, state: 'live',
  });
  theirs.paper()!.setQuote({ symbol: SYMBOL, bid: 20, ask: 20.5, bidSize: 5_000, askSize: 5_000, mark: 20.25, ts: Date.now() });
  const res2 = await runAsDesk(theirs, () => tradingService().place({ symbol: SYMBOL, optionSide: 'PE', strike: 83_800, expiryTs: EXPIRY_TS, lots: 2, leverage: 200, limitPrice: 20, takeProfitPct: 0.8, stopPrice: 70 }));
  assert.equal(res2.ok, true, JSON.stringify(res2));
  const row2 = await one<{ broker_account_id: string | null }>('SELECT broker_account_id FROM trades WHERE trade_id = $1', [res2.state.tradeId]);
  assert.equal(Number(row2!.broker_account_id), second, 'stamped with its own account');
  const openOf = async (id: number) => (await tradingServiceFor(id)!.openTrades()).map((t) => t.state.tradeId);
  assert.deepEqual(await openOf(main()), [res.state.tradeId], 'the first account\'s desk sees its own trade and not the other\'s');
  assert.deepEqual(await openOf(second), [res2.state.tradeId], 'and the second its own: neither engine can step the other\'s trade');
  assert.equal(await tradingServiceFor(main())!.trade(res2.state.tradeId), null, 'asked by id, the wrong desk has no such trade');

  // Over HTTP: the status is the named account's; with none named, the default account's.
  const statusOf = async (q: string) => ((await api('GET', `/api/trade/status${q}`)).body.open as { tradeId: string }[]).map((t) => t.tradeId);
  // (Each desk refreshes its own status once a second: wait for the answer that has the new trade in it.)
  const settled = async (q: string, want: string[]) => {
    for (let i = 0; i < 40; i++) {
      if (JSON.stringify(await statusOf(q)) === JSON.stringify(want)) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.deepEqual(await statusOf(q), want);
  };
  await settled(`?account=${second}`, [res2.state.tradeId]);
  await settled('', [res.state.tradeId]);
  assert.deepEqual(await ids(`?account=${second}`), [res2.state.tradeId]);
  assert.deepEqual((await ids('')).sort(), [res.state.tradeId, res2.state.tradeId].sort(), 'All accounts: both');
  // An act on a trade reaches the desk that holds it, named by nothing but the trade.
  assert.equal((await api('GET', `/api/trade/${res2.state.tradeId}`)).status, 200);
  const held = await api('POST', `/api/accounts/${second}/active`, { active: false });
  assert.deepEqual([held.status, held.body.error], [409, 'Close 1 open position on "Second" first — while it holds one, its desk has to keep running to manage it.']);
  const closed = await api('POST', '/api/trade/close', { tradeId: res2.state.tradeId });
  assert.equal(closed.status, 200, closed.text);
  for (let i = 0; i < 40 && (await openOf(second)).length; i++) await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await openOf(second), [], 'the second account\'s position is closed, on its own exchange');
  const events = await rows<{ kind: string }>('SELECT kind FROM trade_events WHERE trade_id = $1 ORDER BY seq', [res2.state.tradeId]);
  assert.ok(events.some((e) => e.kind === 'exit_submitted'), 'by its own engine: the close is in its journal');
  assert.deepEqual(await openOf(main()), [res.state.tradeId], 'and the first account\'s is untouched');

  /*
   * Close all is the named account's (5 Oct 2026): pressed on the second account's tab it squared off the
   * default account -- the button sent no account. Named, it closes that account's positions and no one else's.
   */
  const res3 = await runAsDesk(theirs, () => tradingService().place({ symbol: SYMBOL, optionSide: 'PE', strike: 83_800, expiryTs: EXPIRY_TS, lots: 1, leverage: 200, limitPrice: 20, takeProfitPct: 0.8, stopPrice: 70 }));
  assert.equal(res3.ok, true, JSON.stringify(res3));
  const all = await api('POST', '/api/trade/close-all', { accountId: second });
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(all.body.closed, [res3.state.tradeId], 'the second account\'s own position, and only it');
  for (let i = 0; i < 40 && (await openOf(second)).length; i++) await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await openOf(second), [], 'closed, on its own exchange');
  assert.deepEqual(await openOf(main()), [res.state.tradeId], 'the default account was not touched');
  // An account that is not the one the desk would close: refused, nothing closed.
  const wrong = await api('POST', '/api/trade/close-all', { accountId: 987_654 });
  assert.equal(wrong.status, 409, wrong.text);
  assert.deepEqual(await openOf(main()), [res.state.tradeId], 'still nothing closed on the default account');

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
  await query(`UPDATE trades SET state = jsonb_set(jsonb_set(state, '{fills}', $1::jsonb), '{position}', '0'), phase = 'flat' WHERE broker_account_id = ${main()}`, [JSON.stringify([
    { orderId: 'a', clientOrderId: 'a', role: 'entry', side: 'sell', size: 1, price: 20, ts: Date.now() - 1_000 },
    { orderId: 'b', clientOrderId: 'b', role: 'stop_loss', side: 'buy', size: 1, price: 50, ts: Date.now() },
  ])]);
  await query('UPDATE trades SET updated_at = $1', [Date.now()]);
  const lost = await journal().realisedSince(0, main());
  assert.ok(lost < -0.02, `the first account booked its stop: ${lost}`);
  // The second account's own day is its own small paper round trip, and nothing of the first account's stop.
  const theirDay = await journal().realisedSince(0, second);
  assert.ok(theirDay > lost / 2 && theirDay <= 0, `the other account's day is its own: ${theirDay}`);
  assert.ok(Math.abs((await journal().realisedSince(0)) - (lost + theirDay)) < 1e-9, 'no account asked for: every account\'s together');
  // Each desk's daily-loss gate reads its own account's day, whatever it is asked.
  assert.equal(await tradingServiceFor(main())!.store.realisedSince(0), lost);
  assert.equal(await tradingServiceFor(second)!.store.realisedSince(0), theirDay);
  assert.equal(await tradingServiceFor(second)!.store.realisedSince(0, main()), theirDay, 'even asked for the other account by name');
});

test('[critical] an account with trades or strategies on record is kept, not removed; one with none can go', async () => {
  const kept = await api('POST', `/api/accounts/${second}/remove`, { code: nextCode() });
  assert.deepEqual([kept.status, kept.body.error], [409, 'This account has 1 trade and 3 strategies on record, so it is kept. Deactivate it instead.']);
  const third = (await brokerAccounts().create({ name: 'Third', apiKey: 'thirdKEYthirdKEY7777', apiSecret: 'thirdSECRETthirdSECRETthirdSECRETthirdSECRET' })).id;
  assert.equal((await api('POST', `/api/accounts/${third}/remove`, { code: nextCode() })).status, 200);
  assert.equal(await strategyStore().countFor(second), 3);
});

test('an account the desk is not on, as Delta has it: its wallet and what it holds there, read with its own key', async () => {
  const s = await api('GET', `/api/accounts/${second}/summary`);
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(s.body.wallet, { balance: 120.5, available: 100 });
  assert.deepEqual(s.body.positions.map((p: { symbol: string; size: number }) => [p.symbol, p.size]), [['P-BTC-83800-230926', -3]], 'flat rows left out');
  assert.deepEqual([s.body.trades, s.body.strategies, s.body.note], [1, 3, null]);
  assert.ok(!s.text.includes('newSECRET'));
  assert.equal((await api('GET', '/api/accounts/999/summary')).status, 404);
});
