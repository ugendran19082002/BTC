import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The days every methods' pick skips, through the API (owner, 9 Nov 2026: "beside Pick now, skip Nov 4 and so on, many
 * dates chosen, saved on the DB side; the pick runs skipping them"): saved in the settings, read back newest first and
 * each once, refused in words when it cannot be, cleared by an empty list -- and read by every pick.
 */

const dir = mkdtempSync(join(tmpdir(), 'skip-days-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'skip-days-master';
process.env.DELTA_API_KEY = 'skdKEYskdKEYskdKEY2222';
process.env.DELTA_API_SECRET = 'skdSECRETskdSECRETskdSECRETskdSECRETskdSECRET';
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore, autoMethodsDeps } = await import('../../src/http/routes/strategy.routes.js');
const { SKIP_DAYS_KEY } = await import('../../src/strategy/auto-methods.js');
const { DEFAULT_AUTO_METHODS, DEFAULT_CONFIG } = await import('../../src/strategy/types.js');

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'skd-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('skip-days-master'), now: Date.now }) });
});
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('skd-session')}` };
const api = async (method: 'GET' | 'PUT', payload?: unknown) => {
  const r = await app.inject({ method, url: '/api/strategies/auto-methods/skip-days', headers: cookie, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as { days?: string[]; error?: string } };
};

test('[critical] saved in the settings, read back newest first and each once; an empty list skips nothing', async () => {
  assert.deepEqual((await api('GET')).body, { days: [] });
  const put = await api('PUT', { days: ['2026-10-13', '2026-11-04', '2026-11-04'] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.days, ['2026-11-04', '2026-10-13']);
  assert.deepEqual(JSON.parse(tradingService().settings.get(SKIP_DAYS_KEY)!), ['2026-11-04', '2026-10-13']);
  assert.deepEqual((await api('GET')).body.days, ['2026-11-04', '2026-10-13']);
  assert.deepEqual((await api('PUT', { days: [] })).body.days, []);
  assert.equal(tradingService().settings.get(SKIP_DAYS_KEY), '');
});

test('refused in words: not a list, not a date, a day to come -- and nothing saved', async () => {
  await api('PUT', { days: ['2026-11-04'] });
  for (const [days, why] of [['2026-11-04', /list of dates/], [['4 Nov'], /YYYY-MM-DD/], [['2099-01-01'], /still to come/]] as const) {
    const r = await api('PUT', { days });
    assert.equal(r.status, 422, JSON.stringify(days));
    assert.match(r.body.error!, why);
  }
  assert.deepEqual((await api('GET')).body.days, ['2026-11-04'], 'the list before is kept');
});

test('[critical] the desk\'s picks read it: the skipped day is never asked of the record', async () => {
  const day = (back: number) => new Date(Date.now() + 5.5 * 3_600_000 - back * 86_400_000).toISOString().slice(0, 10);
  // Two days back is skipped; the pick's record is never asked for it.
  await api('PUT', { days: [day(2)] });
  const config = { ...DEFAULT_CONFIG, trigger: 'signal' as const, signal: { mode: 'single' as const, tf: '15m' as const, methods: ['bos'], target: 'tp1' as const, maxOpen: 100, action: 'sell' as const, autoMethods: { ...DEFAULT_AUTO_METHODS, on: true, days: 5 } } };
  const run = await autoMethodsDeps().pick(config, config.signal.autoMethods, Date.now());
  // Two days back is inside a 5-day look-back at any hour: before 5:30 PM it ends yesterday, after it today.
  assert.deepEqual(run.skipped, [day(2)]);
  assert.ok(run.from < day(2) && run.to > day(2), `${run.from} to ${run.to}`);
});
