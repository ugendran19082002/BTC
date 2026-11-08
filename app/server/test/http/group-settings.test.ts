import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A group's own settings through the API (owner, 8 Nov 2026: "change them for each group; best practice, UI, backend, DB").
 * Each of the seven account settings saved for a group lands under the group's own key, the account's untouched; the list
 * gives each group its own values (null: its account's) and what it holds now; null takes a group back to its account's;
 * a group's at most open is held under its account's; a removed group's settings go with it, a clone's come along.
 */

const dir = mkdtempSync(join(tmpdir(), 'group-settings-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'group-settings-master';
process.env.DELTA_API_KEY = 'gstKEYgstKEYgstKEY2222';
process.env.DELTA_API_SECRET = 'gstSECRETgstSECRETgstSECRETgstSECRETgstSECRET';
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, query } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore, strategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { brokerAccounts } = await import('../../src/delta/accounts.js');
const { StrategyStore } = await import('../../src/strategy/store.js');

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'gset-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('group-settings-master'), now: Date.now }) });
});
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('gset-session')}` };
const api = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: cookie, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};
const main = () => brokerAccounts().default()!.id;
const config = {
  trigger: 'signal', signal: { mode: 'single', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen: 1 }, liveOrders: true,
  entryTime: '09:00', exitTime: '17:00', lots: 1, legs: 'both', strikeRule: 'premium', premium: { mode: 'atMost', usd: 20 },
  entryPrice: 'offer', crossAfterSec: 5, takeProfitPct: 0.9, stopLossPct: 2, weekdays: [0, 1, 2, 3, 4, 5, 6], graceMin: 60,
};

let second = 0;

const groupOf = async (id: string) => (await api('GET', `/api/strategies?account=${main()}`)).body.groups.find((g: { id: string }) => g.id === id);

test('[critical] each of the seven saved for a group lands under the group\'s key; the account\'s is not touched', async () => {
  await tradingService().settings.set(`signal_max_open@${main()}`, '300');
  const made = await api('POST', '/api/strategy-groups', { name: 'Own limits', accountId: main() });
  assert.equal(made.status, 200);
  const g = made.body.group.id as string;
  assert.deepEqual(made.body.group.own, { maxOpen: null, ce: null, pe: null, strikeMax: null, strikeFull: null, zoneFresh: null, momentum: null, reentry: null }, 'a new group: all its account\'s');
  const saves: [string, object][] = [
    ['/api/strategies/side-max', { side: 'CE', pct: 60 }],
    ['/api/strategies/strike-max', { pct: 5 }],
    ['/api/strategies/strike-full', { mode: 'skip' }],
    ['/api/strategies/zone-fresh', { seconds: { '5m': 120 } }],
    ['/api/strategies/momentum-guard', { guard: { on: true, pts: 250 } }],
    ['/api/strategies/reentry', { reentry: { sl: { on: true, from: '07:00', to: '12:00', entries: 2 }, tgt: { on: false, from: '07:00', to: '10:00', entries: 1 } } }],
  ];
  for (const [url, body] of saves) {
    const r = await api('POST', url, { ...body, groupId: g });
    assert.equal(r.status, 200, `${url} ${JSON.stringify(r.body)}`);
  }
  const own = (await groupOf(g)).own;
  assert.equal(own.ce, 60);
  assert.equal(own.pe, null, 'the other side: still the account\'s');
  assert.deepEqual([own.strikeMax, own.strikeFull, own.zoneFresh['5m'], own.momentum, own.reentry.sl.entries], [5, 'skip', 120, { on: true, pts: 250 }, 2]);
  for (const k of ['signal_ce_max_pct', 'signal_strike_max_pct', 'signal_strike_full', 'signal_zone_fresh_s', 'signal_momentum_guard', 'signal_reentry']) {
    assert.notEqual(tradingService().settings.get(`${k}@g:${g}`), null, `${k} kept for the group`);
    assert.equal(tradingService().settings.get(`${k}@${main()}`) ?? null, null, `${k}: the account's not touched`);
  }
  // A group that is not there: refused, nothing saved.
  const none = await api('POST', '/api/strategies/strike-max', { pct: 7, groupId: 'g-nowhere' });
  assert.equal(none.status, 404);
  assert.equal(tradingService().settings.get('signal_strike_max_pct@g:g-nowhere'), null);
});

test('[critical] a group\'s at most open: 1 to its account\'s, null back to the account\'s; the account\'s own is unchanged', async () => {
  const g = (await api('POST', '/api/strategy-groups', { name: 'Capped', accountId: main() })).body.group.id as string;
  const over = await api('POST', '/api/strategies/max-open', { max: 301, groupId: g });
  assert.equal(over.status, 422);
  assert.match(over.body.error, /The account allows 300 at once: a group's own limit above it changes nothing/);
  const zero = await api('POST', '/api/strategies/max-open', { max: 0, groupId: g });
  assert.equal(zero.status, 422);
  assert.match(zero.body.error, /1 or more: clear it/);
  const ok = await api('POST', '/api/strategies/max-open', { max: 120, groupId: g });
  assert.deepEqual([ok.status, ok.body.group.own.maxOpen], [200, 120]);
  assert.equal(tradingService().settings.get(`signal_max_open@${main()}`), '300', 'the account\'s: as it was');
  assert.deepEqual((await groupOf(g)).openNow, { all: 0, CE: 0, PE: 0 });
  const back = await api('POST', '/api/strategies/max-open', { max: null, groupId: g });
  assert.deepEqual([back.status, back.body.group.own.maxOpen], [200, null]);
  // Null without a group is still refused: an account always has a number.
  assert.equal((await api('POST', '/api/strategies/max-open', { max: null })).status, 422);
});

test('[critical] a clone takes its group\'s own settings along; a removed group\'s go with it', async () => {
  const g = (await api('POST', '/api/strategy-groups', { name: 'To clone', accountId: main() })).body.group.id as string;
  await api('POST', '/api/strategies/max-open', { max: 90, groupId: g });
  await api('POST', '/api/strategies/side-max', { side: 'PE', pct: 40, groupId: g });
  const clone = await api('POST', `/api/strategy-groups/${g}/clone`, {});
  assert.equal(clone.status, 200);
  assert.deepEqual([clone.body.group.own.maxOpen, clone.body.group.own.pe], [90, 40]);
  const gone = await api('DELETE', `/api/strategy-groups/${g}`);
  assert.equal(gone.status, 200);
  for (const k of ['signal_max_open', 'signal_pe_max_pct']) assert.equal(tradingService().settings.get(`${k}@g:${g}`) || null, null, `${k} gone with it`);
  assert.equal((await groupOf(clone.body.group.id)).own.maxOpen, 90, 'the clone keeps its own');
});
