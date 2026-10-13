import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The day's loss budget, set from the screen (owner, 13 Oct 2026).
 *
 * It was half the balance and nothing else. On an afternoon that had already lost more than that, every signal
 * was refused -- "Worst case $0 exceeds the $-82 left in today's loss budget" -- with nothing on the desk to say
 * "carry on". Now each account has a switch and an amount of its own: on at half the account until it is
 * changed, and the gate reads the choice each time it runs.
 */

const dir = mkdtempSync(join(tmpdir(), 'loss-budget-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'loss-budget-master';
process.env.DELTA_API_KEY = 'envKEYenvKEYenvKEY9999';
process.env.DELTA_API_SECRET = 'envSECRETenvSECRETenvSECRETenvSECRETenvSECRET';
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, one } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { roomOf } = await import('../../src/http/routes/trade.routes.js');
const { brokerAccounts } = await import('../../src/delta/accounts.js');
const { DEFAULT_LIMITS, failureCodes, precheckBuy } = await import('../../src/trading/precheck.js');
const { rig, ceProduct, planFor, quote, T0 } = await import('../trading/harness.js');

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'loss-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('loss-budget-master'), now: () => Date.now() }) });
});
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('loss-session')}` };
const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: cookie, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as Record<string, any>, text: r.body };
};
const setting = async (key: string) => (await one<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]))?.value ?? null;
const main = () => brokerAccounts().default()!.id;
/** What the engine's gate is held to, read where the gate reads it. */
const gateLimit = () => (tradingService() as unknown as { engine: { limits: { maxDailyLossUsd: number } } }).engine.limits.maxDailyLossUsd;

test('[critical] untouched, the budget is on at half the account -- as it always was', async () => {
  const svc = tradingService();
  const balance = await svc.balance();
  assert.ok(balance > 2, `the paper account has money: ${balance}`);
  const got = (await api('GET', '/api/settings')).body.lossLimit;
  assert.deepEqual(got, { on: true, inForceUsd: balance / 2, defaultUsd: balance / 2, chosenUsd: null });
  assert.equal(gateLimit(), balance / 2, 'the gate is held to the same figure');
  const status = (await api('GET', '/api/trade/status')).body;
  assert.equal(status.limits.maxDailyLossUsd, balance / 2);
  assert.equal(status.limits.dailyLossOn, true);
  assert.equal(status.room.buy.lossRoomUsd, balance / 2);
});

test('[critical] an amount of your own: kept for the account it is set on, and the gate follows it at once', async () => {
  const svc = tradingService();
  const set = await api('POST', '/api/settings', { key: 'daily_loss_limit_usd', value: '40' });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.body.lossLimit, { on: true, inForceUsd: 40, defaultUsd: svc.dailyLossDefaultUsd, chosenUsd: 40 });
  assert.equal(await setting(`daily_loss_limit_usd@${main()}`), '40');
  assert.equal(await setting('daily_loss_limit_usd'), null, 'not a desk-wide figure');
  assert.equal(gateLimit(), 40);
  assert.equal(svc.lossRoomUsd(-15), 25, '40 less the 15 lost');
  assert.equal(svc.lossRoomUsd(8), 40, 'a profit does not add room');
  // More than half the account is the owner's to choose: there is no ceiling to hold it under.
  const more = await api('POST', '/api/settings', { key: 'daily_loss_limit_usd', value: '2500.5' });
  assert.equal(more.body.lossLimit.inForceUsd, 2500.5);
  assert.equal(gateLimit(), 2500.5);
});

test('[critical] not an amount: refused, and what was in force stays', async () => {
  for (const bad of ['0', '-5', 'ten', '1000001', 'Infinity']) {
    const r = await api('POST', '/api/settings', { key: 'daily_loss_limit_usd', value: bad });
    assert.equal(r.status, 422, `${bad}: ${r.text}`);
    assert.equal(r.body.error, 'The loss budget must be an amount above 0, up to $1,000,000.');
  }
  assert.equal((await api('POST', '/api/settings', { key: 'daily_loss_limit_on', value: 'maybe' })).status, 400);
  assert.equal(gateLimit(), 2500.5);
});

test('[critical] switched off: no day\'s loss refuses an order, the figure is still shown, and on brings it back', async () => {
  const svc = tradingService();
  const off = await api('POST', '/api/settings', { key: 'daily_loss_limit_on', value: '0' });
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.body.lossLimit, { on: false, inForceUsd: 2500.5, defaultUsd: svc.dailyLossDefaultUsd, chosenUsd: 2500.5 });
  assert.equal(await setting(`daily_loss_limit_on@${main()}`), '0');
  assert.equal(gateLimit(), Infinity);
  assert.equal(svc.lossRoomUsd(-9_999), null, 'nothing is left of a budget that is not kept');
  const status = (await api('GET', '/api/trade/status')).body;
  // A number, on or off: an unbounded figure does not survive JSON.
  assert.equal(status.limits.maxDailyLossUsd, 2500.5);
  assert.equal(status.limits.dailyLossOn, false);
  assert.equal(status.room.buy.lossRoomUsd, null);
  assert.ok(status.room.buy.byPremium.every((r: { byLoss: number | null }) => r.byLoss === null));

  const on = await api('POST', '/api/settings', { key: 'daily_loss_limit_on', value: '1' });
  assert.equal(on.body.lossLimit.on, true);
  assert.equal(gateLimit(), 2500.5, 'the amount chosen was kept through the switch');
});

test('back to the default: an empty amount is half the account again', async () => {
  const svc = tradingService();
  const back = await api('POST', '/api/settings', { key: 'daily_loss_limit_usd', value: 'default' });
  assert.equal(back.status, 200, back.text);
  assert.deepEqual(back.body.lossLimit, { on: true, inForceUsd: svc.dailyLossDefaultUsd, defaultUsd: svc.dailyLossDefaultUsd, chosenUsd: null });
  assert.equal(gateLimit(), svc.dailyLossDefaultUsd);
});

test('[critical] the gate itself: a spent budget refuses, the same order goes through with the budget off', async () => {
  const spent = rig({ limits: { maxDailyLossUsd: 5 } });
  spent.setDayPnl(-87);
  const refused = await spent.engine.open(planFor(ceProduct()));
  assert.ok(!refused.ok);
  assert.deepEqual(failureCodes(refused.precheck), ['DAILY_LOSS_LIMIT']);
  // Said as it is, not as "$-82 left".
  assert.equal(refused.precheck.ok ? '' : refused.precheck.failures[0]!.message,
    'Today\'s loss budget is used up: $87.00 lost against a budget of $5.00. '
    + 'New orders wait for tomorrow, a larger budget, or the budget switched off (Account card).');

  const off = rig({ limits: { maxDailyLossUsd: Infinity } });
  off.setDayPnl(-87);
  const placed = await off.engine.open(planFor(ceProduct()));
  assert.ok(placed.ok, JSON.stringify(placed.ok ? '' : placed.precheck));
});

test('the gate with room left says what it always said; a buy is held to the same budget and the same switch', () => {
  const CE = 'C-BTC-80000-080926';
  const base = {
    now: T0, size: 10, expect: { underlying: 'BTC', optionSide: 'CE' as const, strike: 80_000, expiryTs: ceProduct().expiryTs },
    product: ceProduct(), quote: quote(CE, 20, 21), feedHealthy: true, tradingEnabled: true,
    availableUsd: 100, costUsd: 3, existingPosition: 0, dayPnlUsd: -4, limits: { ...DEFAULT_LIMITS, maxDailyLossUsd: 5 },
  };
  const some = precheckBuy(base);
  assert.equal(some.ok ? '' : some.failures[0]!.message, 'Worst case $3.00 (the premium paid) exceeds the $1.00 left in today\'s loss budget.');
  const none = precheckBuy({ ...base, dayPnlUsd: -5 });
  assert.match(none.ok ? '' : none.failures[0]!.message, /^Today's loss budget is used up: \$5\.00 lost against a budget of \$5\.00\./);
  assert.deepEqual(precheckBuy({ ...base, dayPnlUsd: -500, limits: { ...base.limits, maxDailyLossUsd: Infinity } }), { ok: true });
});

test('the room to buy with the budget off: the limit and the free balance are what is left to bind', () => {
  const kept = roomOf({ trades: [], freeUsd: 1_000, spot: 85_000, shortLimit: 100, longLimit: 5_000, lossRoomUsd: 1 });
  const free = roomOf({ trades: [], freeUsd: 1_000, spot: 85_000, shortLimit: 100, longLimit: 5_000, lossRoomUsd: null });
  const at = (r: typeof kept) => r.buy.byPremium.find((x) => x.premium === 200)!;
  assert.equal(at(kept).lots, at(kept).byLoss, 'a dollar of budget binds');
  assert.equal(at(free).byLoss, null);
  assert.equal(at(free).lots, at(free).byFree, 'off, the free balance does');
  assert.equal(free.buy.lossRoomUsd, null);
});
