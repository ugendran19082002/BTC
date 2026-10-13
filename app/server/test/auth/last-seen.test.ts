import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, one } from '../../src/db/pool.js';
import { AuthService } from '../../src/auth/service.js';
import { AuthStore, LAST_SEEN_EVERY_MS } from '../../src/auth/store.js';
import { Secrets } from '../../src/auth/secrets.js';
import { hashPassword } from '../../src/http/session.js';

/**
 * A session's last-seen is written at most once a minute -- and asked for no oftener (13 Oct 2026).
 *
 * The rule was already in the UPDATE's own WHERE, so the row moved once a minute; but the statement was sent with
 * every request of every screen to find that out, one in nine of everything the database was asked. The row just
 * read says when it was last touched.
 */
after(() => closePool());

test('[critical] a signed-in request touches the session when a minute has passed, and sends nothing before', async () => {
  const store = await AuthStore.open();
  let clock = 1_800_000_000_000;
  await store.seedUser('desk', hashPassword('correct horse battery'), clock);
  await store.createSession({ token: 'seen-session', stage: 'full', now: clock, ttlMs: 86_400_000, ip: null, userAgent: null });
  const auth = new AuthService({ store, secrets: new Secrets('last-seen-master'), now: () => clock });
  let touches = 0;
  const touch = store.touch.bind(store);
  store.touch = (hash, now) => { touches++; return touch(hash, now); };
  const seen = async () => Number((await one<{ last_seen_at: string }>('SELECT last_seen_at FROM auth_sessions'))!.last_seen_at);
  const made = await seen();

  for (let i = 0; i < 30; i++) { clock += 1_000; assert.equal((await auth.session('seen-session'))?.stage, 'full'); }
  assert.equal(touches, 0, 'thirty requests inside the minute: the session is read, nothing is written or asked');
  assert.equal(await seen(), made);

  clock = made + LAST_SEEN_EVERY_MS + 1;
  assert.equal((await auth.session('seen-session'))?.stage, 'full');
  assert.equal(touches, 1);
  assert.equal(await seen(), clock, 'due, it is written');

  clock += 5_000;
  await auth.session('seen-session');
  assert.equal(touches, 1, 'and not again until the next minute');

  // A session that is no longer live is not found, as before: this changed when it is written, not who is let in.
  clock += 2 * 86_400_000;
  assert.equal(await auth.session('seen-session'), null);
  assert.equal(await auth.session('no-such-token'), null);
});

test('whether sign-in is set up: asked of the database until there is a user, and not again after', async () => {
  const store = await AuthStore.open();
  let reads = 0;
  const user = store.user.bind(store);
  store.user = () => { reads++; return user(); };
  const auth = new AuthService({ store, secrets: new Secrets('last-seen-master'), now: () => Date.now() });
  for (let i = 0; i < 25; i++) assert.equal(await auth.configured(), true);
  assert.equal(reads, 1, 'twenty-five requests, one read');
  // With no key to seal a secret with, sign-in is not set up whatever the table holds -- and nothing is read to say so.
  const bare = new AuthService({ store, secrets: null, now: () => Date.now() });
  assert.equal(await bare.configured(), false);
  assert.equal(reads, 1);
});
