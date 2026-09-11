import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Signing in, end to end, through the real routes and the real gate.
 *
 *   password ─► (first time) setup: QR ─► code ─► recovery codes ─► desk
 *   password ─► code ─► desk
 *
 * Plus the things around it that matter as much: 24-hour sessions, logging out
 * for real, changing the password, and how many guesses anyone gets.
 */

const dir = mkdtempSync(join(tmpdir(), 'auth-flow-'));
process.env.TRADE_DB = join(dir, 'trades.db');
process.env.ERROR_DB = join(dir, 'errors.db');
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DELTA_LIVE_TRADING = '0';

const { buildApp } = await import('../../src/http/app.js');
const { AuthService, SESSION_MS, LIMITS } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { totp, base32Decode } = await import('../../src/auth/totp.js');

const PASSWORD = 'a long private passphrase';
const T0 = Date.UTC(2026, 8, 11, 6, 0, 0);

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let clock: number;
let store: InstanceType<typeof AuthStore>;
let alerts: string[];

async function fresh() {
  clock = T0;
  alerts = [];
  store = new AuthStore(join(mkdtempSync(join(dir, 'db-')), 'auth.db'));
  store.seedUser('ugendran', hashPassword(PASSWORD), clock);
  const auth = new AuthService({ store, secrets: new Secrets('test-master-secret'), now: () => clock, onAlert: (t) => alerts.push(t) });
  app = await buildApp({ auth, now: () => clock });
}
beforeEach(fresh);

const tick = (ms: number) => { clock += ms; };
const cookieFrom = (r: { headers: Record<string, unknown> }) => {
  const raw = r.headers['set-cookie'];
  const line = Array.isArray(raw) ? raw[0] : raw;
  return typeof line === 'string' ? line : '';
};
const tokenFrom = (r: { headers: Record<string, unknown> }) => {
  const m = new RegExp(`${COOKIE.replace(/[-]/g, '\\-')}=([^;]*)`).exec(cookieFrom(r));
  return m ? decodeURIComponent(m[1]!) : '';
};
const jar = (token: string) => ({ cookie: `${COOKIE}=${encodeURIComponent(token)}` });

const login = (username = 'ugendran', password = PASSWORD, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/login', payload: { username, password }, headers });

/** First sign-in: password, then setup, then the code. Returns the full session and the secret. */
async function firstSignIn() {
  const r1 = await login();
  const setupToken = tokenFrom(r1);
  const setup = await app.inject({ method: 'GET', url: '/api/security/setup', headers: jar(setupToken) });
  const { secret } = setup.json() as { secret: string };
  const r2 = await app.inject({ method: 'POST', url: '/api/security/enable', payload: { code: totp(secret, clock) }, headers: jar(setupToken) });
  return { token: tokenFrom(r2), secret, recoveryCodes: (r2.json() as { recoveryCodes: string[] }).recoveryCodes, setupToken };
}

/** A later sign-in: password, then a fresh code (the clock moves on a step so the code is new). */
async function signIn(secret: string) {
  tick(31_000);
  const r1 = await login();
  const codeToken = tokenFrom(r1);
  const r2 = await app.inject({ method: 'POST', url: '/api/login/code', payload: { code: totp(secret, clock) }, headers: jar(codeToken) });
  return { token: tokenFrom(r2), codeToken, response: r2 };
}

const desk = (token: string) => app.inject({ method: 'GET', url: '/api/strategies', headers: jar(token) });

// ------------------------------------------------------------ first sign-in

test('[critical] first sign-in: the password alone opens only the setup, not the desk', async () => {
  const r = await login();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, next: 'setup' });
  assert.equal((await desk(tokenFrom(r))).statusCode, 401);
  const me = (await app.inject({ method: 'GET', url: '/api/me', headers: jar(tokenFrom(r)) })).json();
  assert.equal(me.stage, 'setup');
  assert.equal(me.signedIn, false);
});

test('[critical] setup shows a QR code and a key for the authenticator app', async () => {
  const token = tokenFrom(await login());
  const r = await app.inject({ method: 'GET', url: '/api/security/setup', headers: jar(token) });
  assert.equal(r.statusCode, 200);
  const body = r.json() as { secret: string; otpauthUrl: string; qrSvg: string };
  assert.equal(base32Decode(body.secret).length, 20);
  assert.match(body.otpauthUrl, /^otpauth:\/\/totp\/BTC%20Desk%3Augendran\?secret=/);
  assert.match(body.qrSvg, /^<svg[\s\S]*<\/svg>\s*$/);
  assert.equal(r.headers['cache-control'], 'no-store');
  // a reload inside the window shows the same QR, so a half-finished scan still works
  const again = (await app.inject({ method: 'GET', url: '/api/security/setup', headers: jar(token) })).json();
  assert.equal(again.secret, body.secret);
});

test('[critical] the secret is stored sealed, never as it was shown', async () => {
  const token = tokenFrom(await login());
  const { secret } = (await app.inject({ method: 'GET', url: '/api/security/setup', headers: jar(token) })).json() as { secret: string };
  const u = store.user()!;
  assert.ok(u.totpPending);
  assert.doesNotMatch(u.totpPending!, new RegExp(secret));
});

test('[critical] a wrong code does not turn it on; the right one does, and opens the desk', async () => {
  const token = tokenFrom(await login());
  const { secret } = (await app.inject({ method: 'GET', url: '/api/security/setup', headers: jar(token) })).json() as { secret: string };
  const wrong = await app.inject({ method: 'POST', url: '/api/security/enable', payload: { code: '000000' === totp(secret, clock) ? '111111' : '000000' }, headers: jar(token) });
  assert.equal(wrong.statusCode, 401);
  assert.equal(store.user()!.totpSecret, null);

  const right = await app.inject({ method: 'POST', url: '/api/security/enable', payload: { code: totp(secret, clock) }, headers: jar(token) });
  assert.equal(right.statusCode, 200);
  const { recoveryCodes } = right.json() as { recoveryCodes: string[] };
  assert.equal(recoveryCodes.length, 10);
  const full = tokenFrom(right);
  assert.notEqual(full, token, 'a new token once the step is passed');
  assert.equal((await desk(full)).statusCode, 200);
  assert.equal((await desk(token)).statusCode, 401, 'the setup token is spent');
  assert.ok(alerts.some((a) => /two-step sign-in was turned on/.test(a)));
});

// ---------------------------------------------------------- every sign-in

test('[critical] after setup, every sign-in needs the code: the password alone opens nothing', async () => {
  await firstSignIn();
  tick(31_000);
  const r = await login();
  assert.deepEqual(r.json(), { ok: true, next: 'code' });
  const codeToken = tokenFrom(r);
  assert.equal((await desk(codeToken)).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/security/setup', headers: jar(codeToken) })).statusCode, 401, 'setup cannot be reached again');
});

test('[critical] password + the current code opens the desk', async () => {
  const { secret } = await firstSignIn();
  const { token, codeToken, response } = await signIn(secret);
  assert.equal(response.statusCode, 200);
  assert.notEqual(token, codeToken);
  assert.equal((await desk(token)).statusCode, 200);
  assert.equal((await desk(codeToken)).statusCode, 401);
});

test('[critical] a code already used cannot be used again', async () => {
  const { secret } = await firstSignIn();
  tick(31_000);
  const code = totp(secret, clock);
  const t1 = tokenFrom(await login());
  assert.equal((await app.inject({ method: 'POST', url: '/api/login/code', payload: { code }, headers: jar(t1) })).statusCode, 200);
  const t2 = tokenFrom(await login());
  const replay = await app.inject({ method: 'POST', url: '/api/login/code', payload: { code }, headers: jar(t2) });
  assert.equal(replay.statusCode, 401);
});

test('[critical] five wrong codes end the sign-in: the password has to be entered again', async () => {
  const { secret } = await firstSignIn();
  tick(31_000);
  const t = tokenFrom(await login());
  const wrong = totp(secret, clock) === '123456' ? '654321' : '123456';
  for (let i = 1; i <= 4; i++) {
    const r = await app.inject({ method: 'POST', url: '/api/login/code', payload: { code: wrong }, headers: jar(t) });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().restart, undefined, `try ${i} can try again`);
  }
  const fifth = await app.inject({ method: 'POST', url: '/api/login/code', payload: { code: wrong }, headers: jar(t) });
  assert.equal(fifth.json().restart, true);
  const late = await app.inject({ method: 'POST', url: '/api/login/code', payload: { code: totp(secret, clock) }, headers: jar(t) });
  assert.equal(late.statusCode, 401, 'even the right code now');
});

test('[critical] a recovery code signs in once, and never again', async () => {
  const { recoveryCodes } = await firstSignIn();
  tick(31_000);
  const t1 = tokenFrom(await login());
  const ok = await app.inject({ method: 'POST', url: '/api/login/code', payload: { code: recoveryCodes[0]!.toLowerCase() }, headers: jar(t1) });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().usedRecoveryCode, true);
  assert.ok(alerts.some((a) => /recovery code/.test(a) && /9 left/.test(a)));
  const t2 = tokenFrom(await login());
  const again = await app.inject({ method: 'POST', url: '/api/login/code', payload: { code: recoveryCodes[0] }, headers: jar(t2) });
  assert.equal(again.statusCode, 401);
});

test('the code step itself runs out after five minutes', async () => {
  const { secret } = await firstSignIn();
  tick(31_000);
  const t = tokenFrom(await login());
  tick(5 * 60_000 + 1);
  const r = await app.inject({ method: 'POST', url: '/api/login/code', payload: { code: totp(secret, clock) }, headers: jar(t) });
  assert.equal(r.statusCode, 401);
});

// ---------------------------------------------------------------- sessions

test('[critical] the session cookie: __Host-, HttpOnly, Secure, SameSite=Strict, 24 hours', async () => {
  const { secret } = await firstSignIn();
  const { response } = await signIn(secret);
  const c = cookieFrom(response);
  assert.match(c, /^__Host-desk_session=/);
  assert.match(c, /; Path=\//);
  assert.match(c, /; HttpOnly/);
  assert.match(c, /; Secure/);
  assert.match(c, /; SameSite=Strict/);
  assert.match(c, /; Max-Age=86400$/);
  assert.doesNotMatch(c, /Domain=/);
});

test('[critical] a session lasts 24 hours from sign-in, then asks again', async () => {
  const { secret } = await firstSignIn();
  const { token } = await signIn(secret);
  tick(SESSION_MS - 60_000);
  assert.equal((await desk(token)).statusCode, 200, 'a minute before');
  tick(60_001);
  assert.equal((await desk(token)).statusCode, 401, 'just after');
});

test('[critical] logging out ends the session on the server, not just in the browser', async () => {
  const { secret } = await firstSignIn();
  const { token } = await signIn(secret);
  const out = await app.inject({ method: 'POST', url: '/api/logout', headers: jar(token) });
  assert.match(cookieFrom(out), /Max-Age=0/);
  assert.equal((await desk(token)).statusCode, 401, 'the same cookie, replayed, opens nothing');
});

test('only the hash of a token is stored', async () => {
  const { token } = await firstSignIn();
  const s = store.session(token, clock)!;
  assert.notEqual(s.tokenHash, token);
  assert.equal(s.tokenHash.length, 64);
});

test('[critical] "sign out other devices" ends every session but this one', async () => {
  const { secret, token: phone } = await firstSignIn();
  const { token: laptop } = await signIn(secret);
  const r = await app.inject({ method: 'POST', url: '/api/security/sign-out-others', headers: jar(laptop) });
  assert.equal(r.json().ended, 1);
  assert.equal((await desk(phone)).statusCode, 401);
  assert.equal((await desk(laptop)).statusCode, 200);
});

// ---------------------------------------------------------- change password

const change = (token: string, body: object) =>
  app.inject({ method: 'POST', url: '/api/security/password', payload: body, headers: jar(token) });

test('[critical] changing the password needs the current password and a fresh code', async () => {
  const { secret } = await firstSignIn();
  const { token } = await signIn(secret);
  tick(31_000);
  const wrongCurrent = await change(token, { current: 'not it at all, sorry', next: 'a brand new passphrase', code: totp(secret, clock) });
  assert.equal(wrongCurrent.statusCode, 401);
  assert.match(wrongCurrent.json().error, /current password/);
  const wrongCode = await change(token, { current: PASSWORD, next: 'a brand new passphrase', code: '000000' === totp(secret, clock) ? '111111' : '000000' });
  assert.equal(wrongCode.statusCode, 401);
  assert.match(wrongCode.json().error, /authenticator code/);
  const weak = await change(token, { current: PASSWORD, next: 'short', code: totp(secret, clock) });
  assert.equal(weak.statusCode, 400);
  assert.ok((weak.json().problems as string[]).some((p) => /12/.test(p)));
});

test('[critical] a changed password signs out every other device, and the old password stops working', async () => {
  const { secret, token: phone } = await firstSignIn();
  const { token: laptop } = await signIn(secret);
  tick(31_000);
  const r = await change(laptop, { current: PASSWORD, next: 'a brand new passphrase', code: totp(secret, clock) });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().endedSessions, 1);
  const kept = tokenFrom(r);
  assert.notEqual(kept, laptop, 'this device gets a fresh token');
  assert.equal((await desk(kept)).statusCode, 200);
  assert.equal((await desk(laptop)).statusCode, 401);
  assert.equal((await desk(phone)).statusCode, 401);
  tick(31_000);
  assert.equal((await login('ugendran', PASSWORD)).statusCode, 401);
  assert.equal((await login('ugendran', 'a brand new passphrase')).statusCode, 200);
  assert.ok(alerts.some((a) => /password was changed/.test(a)));
});

test('the account page lists sessions and security events, and never a token or a secret', async () => {
  const { secret } = await firstSignIn();
  const { token } = await signIn(secret);
  const r = await app.inject({ method: 'GET', url: '/api/security', headers: { ...jar(token), 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.username, 'ugendran');
  assert.equal(body.recoveryCodesLeft, 10);
  assert.equal(body.sessions.filter((s: { current: boolean }) => s.current).length, 1);
  assert.ok(body.events.some((e: { kind: string }) => e.kind === '2fa_enabled'));
  const text = r.body;
  assert.doesNotMatch(text, new RegExp(token));
  assert.doesNotMatch(text, new RegExp(secret));
  assert.doesNotMatch(text, /scrypt:/);
});

test('new recovery codes need a code, and replace the old ones', async () => {
  const { secret, recoveryCodes } = await firstSignIn();
  const { token } = await signIn(secret);
  tick(31_000);
  const r = await app.inject({ method: 'POST', url: '/api/security/recovery-codes', payload: { code: totp(secret, clock) }, headers: jar(token) });
  assert.equal(r.statusCode, 200);
  const fresh = r.json().recoveryCodes as string[];
  assert.equal(fresh.length, 10);
  tick(31_000);
  const t = tokenFrom(await login());
  assert.equal((await app.inject({ method: 'POST', url: '/api/login/code', payload: { code: recoveryCodes[1] }, headers: jar(t) })).statusCode, 401, 'an old code is gone');
});

// ------------------------------------------------------------- rate limits

test('[critical] 8 wrong passwords from one address block it for ten minutes', async () => {
  for (let i = 0; i < LIMITS.passwordPerAddress.max; i++) {
    assert.equal((await login('ugendran', `wrong guess ${i}`)).statusCode, 401);
  }
  const blocked = await login();
  assert.equal(blocked.statusCode, 429, 'even with the right password');
  assert.match(blocked.json().error, /Try again in 10 minutes/);
  tick(10 * 60_000 + 1);
  assert.equal((await login()).statusCode, 200);
});

test('[critical] a new address per guess does not get around the account limit', async () => {
  for (let i = 0; i < LIMITS.passwordPerAccount.max; i++) {
    const r = await login('ugendran', `wrong guess ${i}`, { 'x-forwarded-for': `203.0.113.${i}` });
    assert.equal(r.statusCode, 401, `guess ${i}`);
  }
  const r = await login('ugendran', PASSWORD, { 'x-forwarded-for': '198.51.100.7' });
  assert.equal(r.statusCode, 429);
  assert.ok(alerts.some((a) => /sign-in locked/.test(a)));
});

test('[critical] a forged X-Forwarded-For from an untrusted connection is not the address counted', async () => {
  // A public address writing a different X-Forwarded-For each time. It used to
  // be believed (trustProxy: true), so each guess counted as a new address.
  const guess = (password: string, forged: string) => app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'ugendran', password },
    headers: { 'x-forwarded-for': forged }, remoteAddress: '203.0.113.60',
  });
  for (let i = 0; i < LIMITS.passwordPerAddress.max; i++) {
    assert.equal((await guess(`wrong guess ${i}`, `198.51.100.${i}`)).statusCode, 401);
  }
  const r = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'ugendran', password: PASSWORD },
    headers: { 'x-forwarded-for': '192.0.2.99' }, remoteAddress: '203.0.113.50',
  });
  assert.equal(r.statusCode, 200, 'a different real connection is not blocked by them');
  const again = await guess(PASSWORD, '192.0.2.100');
  assert.equal(again.statusCode, 429, 'but the guessing connection is, whatever it claims to be');
});

test('behind the trusted proxy, the client address it reports is the one counted', async () => {
  for (let i = 0; i < LIMITS.passwordPerAddress.max; i++) {
    await app.inject({
      method: 'POST', url: '/api/login', payload: { username: 'ugendran', password: `wrong ${i}` },
      headers: { 'x-forwarded-for': '203.0.113.9' }, remoteAddress: '172.18.0.3',
    });
  }
  const other = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'ugendran', password: PASSWORD },
    headers: { 'x-forwarded-for': '203.0.113.10' }, remoteAddress: '172.18.0.3',
  });
  assert.equal(other.statusCode, 200, 'another client through the same proxy is not blocked');
});

test('a wrong username answers exactly like a wrong password', async () => {
  const a = await login('nobody', PASSWORD);
  const b = await login('ugendran', 'not the password at all');
  assert.equal(a.statusCode, b.statusCode);
  assert.deepEqual(a.json(), b.json());
});

test('with no user and no secret, the desk refuses everything but health and /api/me', async () => {
  const empty = new AuthStore(join(mkdtempSync(join(dir, 'db-')), 'auth.db'));
  const bare = await buildApp({ auth: new AuthService({ store: empty, secrets: null, now: () => clock }) });
  assert.equal((await bare.inject({ method: 'GET', url: '/api/strategies' })).statusCode, 503);
  assert.equal((await bare.inject({ method: 'POST', url: '/api/login', payload: { username: 'x', password: 'y' } })).statusCode, 503);
  assert.equal((await bare.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  assert.equal((await bare.inject({ method: 'GET', url: '/api/me' })).json().configured, false);
  await bare.close();
});
