import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountRefused, BrokerAccounts, MAX_ACCOUNTS } from '../../src/delta/accounts.js';
import { Secrets } from '../../src/auth/secrets.js';
import { MemorySettings } from '../../src/db/settings.js';
import { closePool, query, rows } from '../../src/db/pool.js';

after(closePool);

const LABEL = 'btc-desk/broker-account/v1';
const secrets = () => new Secrets('accounts-test-master', LABEL);
const KEY_A = 'keyAAAAAAAAAAAAAAAAA1111', SECRET_A = 'secretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'keyBBBBBBBBBBBBBBBBB2222', SECRET_B = 'secretBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const stored = () => rows<{ id: string; name: string; api_key_sealed: string; api_secret_sealed: string; key_hint: string; is_default: boolean; active: boolean }>(
  'SELECT * FROM broker_accounts ORDER BY id');

test('[critical] .env\'s key is imported once, sealed, as the default -- the last account is never removed, and an emptied table is not refilled', async () => {
  const settings = new MemorySettings();
  const seed = { key: KEY_A, secret: SECRET_A };
  const first = await new BrokerAccounts({ secrets: secrets() }).load({ seed, settings });
  assert.deepEqual(first.defaultCreds(), seed, 'the desk comes up on the account it went down on');
  assert.equal(first.list().length, 1);
  assert.equal(first.default()!.keyHint, '1111');

  // In the table: nothing readable. Not the key, not the secret.
  const [row] = await stored();
  assert.ok(row!.api_key_sealed.startsWith('v1.') && row!.api_secret_sealed.startsWith('v1.'));
  assert.ok(!JSON.stringify(row).includes(KEY_A) && !JSON.stringify(row).includes(SECRET_A), 'sealed, both');
  // To the screen: the last four of the key, and that is all.
  assert.ok(!JSON.stringify(first.list()).includes(SECRET_A) && !JSON.stringify(first.list()).includes(KEY_A));

  // A second start: read from the table, not imported again.
  const second = await new BrokerAccounts({ secrets: secrets() }).load({ seed, settings });
  assert.equal(second.list().length, 1);

  // The last account is kept: switched off, never removed.
  const only = second.default()!.id;
  assert.equal(second.removalBlocked(only), 'This is the only account, and the last one is kept. Deactivate it instead.');
  await assert.rejects(second.remove(only), (e: AccountRefused) => e.status === 409 && /Deactivate it instead/.test(e.message));
  assert.equal((await stored()).length, 1, 'still there');
  // Off: kept, not used. On again with no default anywhere: it is the default again, in one tap.
  assert.deepEqual([(await second.setActive(only, false)).isDefault, second.defaultCreds()], [false, null]);
  assert.equal((await second.setActive(only, true)).isDefault, true);
  assert.deepEqual(second.defaultCreds(), seed);

  // A table emptied by hand, then a restart with the same .env: the import does not run twice.
  await query('DELETE FROM broker_accounts');
  const third = await new BrokerAccounts({ secrets: secrets() }).load({ seed, settings });
  assert.deepEqual(third.list(), []);
  assert.equal(third.defaultCreds(), null);
});

test('[critical] two accounts: the first is the default, one default at a time, off means not the default', async () => {
  await query('DELETE FROM broker_accounts');
  const a = await new BrokerAccounts({ secrets: secrets() }).load();
  const one = await a.create({ name: '  Main   account ', description: 'the big one', apiKey: ` ${KEY_A}\n`, apiSecret: SECRET_A });
  assert.deepEqual([one.name, one.description, one.isDefault, one.active, one.keyHint], ['Main account', 'the big one', true, true, '1111']);
  const two = await a.create({ name: 'Second', apiKey: KEY_B, apiSecret: SECRET_B });
  assert.equal(two.isDefault, false, 'a later account is not the default until it is chosen');
  assert.deepEqual(a.defaultCreds(), { key: KEY_A, secret: SECRET_A }, 'pasted whitespace dropped');

  await a.setDefault(two.id);
  assert.deepEqual((await stored()).map((r) => r.is_default), [false, true], 'one default, in the table');
  assert.deepEqual(a.defaultCreds(), { key: KEY_B, secret: SECRET_B });

  // Switched off, the default is no longer the default -- and cannot be chosen until it is on again.
  await a.setActive(two.id, false);
  assert.equal(a.default(), null);
  assert.equal(a.defaultCreds(), null);
  await assert.rejects(a.setDefault(two.id), /Activate the account first/);
  assert.equal((await a.setActive(two.id, true)).isDefault, true, 'on again with no default: it is the default');
  // With a default in place, switching another on does not take it.
  await a.setActive(one.id, false);
  assert.equal((await a.setActive(one.id, true)).isDefault, false);
  assert.equal(a.default()!.id, two.id);

  assert.equal((await a.rename(one.id, { name: 'Renamed', description: '' })).name, 'Renamed');
  assert.equal((await a.noteTest(one.id, { ok: false, detail: 'Delta does not know this API key. (invalid_api_key)' })).lastTest!.ok, false);
  // One of two goes; the one left does not.
  await a.remove(one.id);
  assert.deepEqual(a.list().map((x) => x.name), ['Second']);
  await assert.rejects(a.remove(two.id), /the last one is kept/);
});

test('what is refused: no name, a key that is not one, a name or a key twice, a sixth account, no master secret', async () => {
  await query('DELETE FROM broker_accounts');
  const a = await new BrokerAccounts({ secrets: secrets() }).load();
  const ok = { name: 'One', apiKey: KEY_A, apiSecret: SECRET_A };
  await assert.rejects(a.create({ ...ok, name: '   ' }), /Give the account a name/);
  await assert.rejects(a.create({ ...ok, apiKey: 'short' }), /does not look like an API key/);
  await assert.rejects(a.create({ ...ok, apiSecret: 'short' }), /does not look like an API secret/);
  await a.create(ok);
  await assert.rejects(a.create({ ...ok, name: 'one', apiKey: KEY_B }), /already an account named/);
  await assert.rejects(a.create({ ...ok, name: 'Other' }), /already saved/);
  await assert.rejects(a.setDefault(999), (e: AccountRefused) => e.status === 404);
  for (let i = 2; i <= MAX_ACCOUNTS; i++) await a.create({ name: `N${i}`, apiKey: `${KEY_B}${i}`, apiSecret: SECRET_B });
  await assert.rejects(a.create({ name: 'Too many', apiKey: `${KEY_B}x`, apiSecret: SECRET_B }), /At most 5 accounts/);

  // Without DESK_SESSION_SECRET nothing can be sealed: nothing is kept in the clear instead.
  const bare = await new BrokerAccounts({ secrets: null }).load({ seed: { key: KEY_A, secret: SECRET_A }, settings: new MemorySettings() });
  assert.equal(bare.canStore, false);
  assert.equal(bare.defaultCreds(), null);
  await query('DELETE FROM broker_accounts');
  await assert.rejects((await new BrokerAccounts({ secrets: null }).load()).create(ok), /cannot be encrypted/);
  assert.deepEqual(await stored(), []);
});

test('[critical] a key sealed under another master secret is shown unreadable and never used', async () => {
  await query('DELETE FROM broker_accounts');
  const a = await new BrokerAccounts({ secrets: secrets() }).load();
  const one = await a.create({ name: 'One', apiKey: KEY_A, apiSecret: SECRET_A });

  const rotated = await new BrokerAccounts({ secrets: new Secrets('another-master', LABEL) }).load();
  assert.equal(rotated.get(one.id)!.readable, false);
  assert.equal(rotated.defaultCreds(), null, 'not used');
  assert.equal(rotated.credsOf(one.id), null);
  // And the sign-in's own sealing key does not open it either: each kind of secret has its own.
  assert.equal((await new BrokerAccounts({ secrets: new Secrets('accounts-test-master') }).load()).defaultCreds(), null);
});

test('the daily read: a default changed underneath is noticed, an unchanged table is not', async () => {
  await query('DELETE FROM broker_accounts');
  const a = await new BrokerAccounts({ secrets: secrets() }).load();
  const one = await a.create({ name: 'One', apiKey: KEY_A, apiSecret: SECRET_A });
  const two = await a.create({ name: 'Two', apiKey: KEY_B, apiSecret: SECRET_B });
  assert.deepEqual(await a.refresh(), { defaultChanged: false });
  // By hand, in a console.
  await query('UPDATE broker_accounts SET is_default = false WHERE id = $1', [one.id]);
  await query('UPDATE broker_accounts SET is_default = true WHERE id = $1', [two.id]);
  assert.deepEqual(await a.refresh(), { defaultChanged: true });
  assert.deepEqual(a.defaultCreds(), { key: KEY_B, secret: SECRET_B });
});
