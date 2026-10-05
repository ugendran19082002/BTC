import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The broker accounts over HTTP, on a desk that starts live on the account
 * imported from `.env` -- the deploy this replaces the environment key on.
 */

const ENV_KEY = 'envKEYenvKEYenvKEY9999', ENV_SECRET = 'envSECRETenvSECRETenvSECRETenvSECRETenvSECRET';
const NEW_KEY = 'newKEYnewKEYnewKEY4242', NEW_SECRET = 'newSECRETnewSECRETnewSECRETnewSECRETnewSECRET';
const dir = mkdtempSync(join(tmpdir(), 'accounts-route-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'accounts-route-master';
process.env.DELTA_API_KEY = ENV_KEY;
process.env.DELTA_API_SECRET = ENV_SECRET;
delete process.env.DELTA_LIVE_TRADING;
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, rows } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { brokerAccounts } = await import('../../src/delta/accounts.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { query } = await import('../../src/db/pool.js');

await initTradingService();
await initStrategyStore();
// This file is the accounts' own rules; an account kept for its history is test/http/account-views.test.ts.
await query('UPDATE strategies SET broker_account_id = NULL');
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'accounts-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

/** Delta's answer to a connection test, by the key asked with: nothing leaves the process. */
const tested: string[] = [];
let verdict: Record<string, { ok: boolean; detail: string }> = {};
const accountTest = async (creds: { key: string; secret: string }) => {
  tested.push(creds.key);
  return verdict[creds.key] ?? { ok: true, detail: 'Connected. Wallet balance $12.34.' };
};


/** Two-step sign-in set up, and a clock the test moves: an authenticator code is good once, so each removal takes the next. */
const { base32Encode, totp } = await import('../../src/auth/totp.js');
const { randomBytes } = await import('node:crypto');
const TOTP_SECRET = base32Encode(randomBytes(20));
let clock = Date.now();
const nextCode = () => { clock += 30_000; return totp(TOTP_SECRET, clock); };
/** The code that removed the first account, kept to show it removes nothing else. */
let spent = '';
await auth.enableTotp(new Secrets('accounts-route-master').seal(TOTP_SECRET), -1, Date.now());

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('accounts-route-master'), now: () => clock }), accountTest });
});
/** Remove an account, with a code (a fresh, right one unless given). */
const remove = (id: number, code: string | undefined = nextCode()) => api('POST', `/api/accounts/${id}/remove`, code === undefined ? {} : { code });
after(async () => {
  tradingService().stop();
  await app.close();
  await closePool();
});

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('accounts-session')}` };
const api = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = cookie) => {
  const r = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as Record<string, any>, text: r.body };
};
const named = (body: Record<string, any>, name: string) => (body.accounts as Record<string, any>[]).find((a) => a.name === name)!;

test('[critical] the desk starts on .env\'s key, now a sealed row -- and no answer ever carries a key or a secret', async () => {
  assert.equal(tradingService().mode, 'live', 'live, as it was with the key in the environment');
  const r = await api('GET', '/api/accounts');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.accounts.length, 1);
  assert.equal(r.body.envKeyLeft, true, 'and the screen is told the key is still in .env, to be emptied there');
  const a = r.body.accounts[0];
  assert.deepEqual([a.name, a.isDefault, a.active, a.readable, a.keyHint], ['Delta India (from .env)', true, true, true, '9999']);
  assert.deepEqual(Object.keys(a).sort(), ['active', 'broker', 'createdAt', 'description', 'id', 'isDefault', 'keptBecause', 'keyHint', 'lastTest', 'name', 'readable', 'updatedAt']);
  assert.equal(a.keptBecause, 'This is the only account, and the last one is kept. Deactivate it instead.', 'and why it cannot be removed, before anyone tries');
  assert.ok(!r.text.includes(ENV_KEY) && !r.text.includes(ENV_SECRET));
  assert.equal((await api('GET', '/api/accounts', undefined, {})).status, 401, 'closed without a session');
});

test('[critical] a second account: saved sealed, tested as it is saved, and not the default until chosen', async () => {
  const r = await api('POST', '/api/accounts', { name: 'Second', description: 'the other one', api_key: NEW_KEY, api_secret: NEW_SECRET });
  assert.equal(r.status, 200, r.text);
  const b = named(r.body, 'Second');
  assert.deepEqual([b.isDefault, b.active, b.keyHint, b.description], [false, true, '4242', 'the other one']);
  assert.deepEqual([b.lastTest.ok, b.lastTest.detail], [true, 'Connected. Wallet balance $12.34.']);
  assert.deepEqual(tested, [NEW_KEY]);
  assert.ok(!r.text.includes(NEW_KEY) && !r.text.includes(NEW_SECRET), 'the answer to saving a key does not repeat it');
  const stored = JSON.stringify(await rows('SELECT * FROM broker_accounts'));
  assert.ok(!stored.includes(NEW_KEY) && !stored.includes(NEW_SECRET) && !stored.includes(ENV_SECRET), 'nor does the table');

  const bad = await api('POST', '/api/accounts', { name: 'Second', api_key: `${NEW_KEY}x`, api_secret: NEW_SECRET });
  assert.deepEqual([bad.status, bad.body.error], [409, 'There is already an account named "Second".']);
  assert.equal((await api('POST', '/api/accounts', { name: 'No key' })).status, 422);
});

test('[critical] live on the default: it cannot be removed or switched off, and a key that fails its test cannot become the default', async () => {
  const list = (await api('GET', '/api/accounts')).body;
  const main = named(list, 'Delta India (from .env)'), second = named(list, 'Second');

  assert.equal(main.keptBecause, 'The desk is trading live on this account. Switch to paper first.');
  assert.equal(second.keptBecause, null);
  const gone = await remove(main.id);
  assert.deepEqual([gone.status, gone.body.error], [409, 'The desk is trading live on this account. Switch to paper first.']);
  const off = await api('POST', `/api/accounts/${main.id}/active`, { active: false });
  assert.equal(off.status, 409);
  assert.equal(brokerAccounts().default()!.id, main.id, 'nothing changed');

  verdict = { [NEW_KEY]: { ok: false, detail: 'The API secret does not match the key. (Signature Mismatch)' } };
  const failed = await api('POST', `/api/accounts/${second.id}/default`);
  assert.equal(failed.status, 422);
  assert.match(failed.body.error, /Not made the default: its connection test failed\. The API secret does not match the key/);
  assert.equal(named(failed.body, 'Second').lastTest.ok, false, 'and the row says what the test said');
  assert.equal(brokerAccounts().default()!.id, main.id);

  // Working again, and nothing open: the desk moves to it, still live.
  verdict = {};
  const moved = await api('POST', `/api/accounts/${second.id}/default`);
  assert.equal(moved.status, 200, moved.text);
  assert.deepEqual([named(moved.body, 'Second').isDefault, named(moved.body, 'Delta India (from .env)').isDefault], [true, false]);
  assert.deepEqual(brokerAccounts().defaultCreds(), { key: NEW_KEY, secret: NEW_SECRET });
  assert.equal(tradingService().mode, 'live');

  // The one no longer in use, with nothing on record, can go -- but only with a fresh authenticator code.
  const noCode = await api('POST', `/api/accounts/${main.id}/remove`, {});
  assert.deepEqual([noCode.status, noCode.body.error], [422, 'Enter the 6-digit code from your authenticator app.']);
  const wrong = await remove(main.id, '000000');
  assert.deepEqual([wrong.status, wrong.body.error], [403, 'The authenticator code is not right. Use the newest code in the app.']);
  assert.equal(brokerAccounts().get(main.id)!.name, 'Delta India (from .env)', 'still there after a wrong code');
  spent = nextCode();
  assert.equal((await remove(main.id, spent)).status, 200);
  assert.equal(brokerAccounts().get(main.id), null);
  // The removal and the refused attempt are in the security log, with the account's name and never its key.
  const log = await rows<{ kind: string; detail: string | null }>("SELECT kind, detail FROM auth_events WHERE kind LIKE 'broker_account_removed%' ORDER BY id");
  assert.deepEqual(log.map((e) => e.kind), ['broker_account_removed_refused', 'broker_account_removed']);
  assert.match(log[1]!.detail!, /"Delta India \(from \.env\)" \(key ending 9999\)/);
});

test('[critical] test, rename -- and the last account is never deleted: it is switched off, and comes back in one tap', async () => {
  const second = named((await api('GET', '/api/accounts')).body, 'Second');
  const t = await api('POST', `/api/accounts/${second.id}/test`);
  assert.deepEqual([t.status, t.body.test.ok, t.body.test.id], [200, true, second.id]);
  const renamed = await api('POST', `/api/accounts/${second.id}`, { name: 'Trading', description: '' });
  assert.equal(named(renamed.body, 'Trading').description, '');
  assert.equal((await api('POST', '/api/accounts/999/test')).status, 404);
  assert.equal((await api('POST', `/api/accounts/${second.id}/active`, { active: 'no' })).status, 400);

  // The only account left: not removed, live or on paper -- and the answer says what to do instead.
  const kept = 'This is the only account, and the last one is kept. Deactivate it instead.';
  const liveTry = await remove(second.id);
  assert.deepEqual([liveTry.status, liveTry.body.error], [409, kept]);
  assert.equal((await tradingService().setMode('paper')).ok, true);
  const paperTry = await remove(second.id);
  assert.deepEqual([paperTry.status, paperTry.body.error], [409, kept]);
  assert.equal(brokerAccounts().list().length, 1);

  // Switched off instead: kept, not used, and live is not reachable.
  const off = await api('POST', `/api/accounts/${second.id}/active`, { active: false });
  assert.deepEqual([off.status, named(off.body, 'Trading').active, named(off.body, 'Trading').isDefault], [200, false, false]);
  assert.equal(tradingService().canGoLive, false);
  assert.equal((await tradingService().setMode('live')).ok, false);

  // On again: the default again, and live is reachable again.
  const on = await api('POST', `/api/accounts/${second.id}/active`, { active: true });
  assert.deepEqual([on.status, named(on.body, 'Trading').active, named(on.body, 'Trading').isDefault], [200, true, true]);
  assert.equal(tradingService().canGoLive, true);

  // A key is replaced by adding the new one first; then the old one can go.
  const fresh = await api('POST', '/api/accounts', { name: 'Fresh', api_key: `${NEW_KEY}2`, api_secret: NEW_SECRET });
  assert.equal(named(fresh.body, 'Fresh').isDefault, false);
  assert.equal((await api('POST', `/api/accounts/${named(fresh.body, 'Fresh').id}/default`)).status, 200);
  // A code is good once: the one that removed the first account does not remove another.
  assert.equal((await remove(second.id, spent)).status, 403);
  const gone = await remove(second.id);
  assert.deepEqual([gone.status, gone.body.accounts.map((a: { name: string }) => a.name)], [200, ['Fresh']]);
});
