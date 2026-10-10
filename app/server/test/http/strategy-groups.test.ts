import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Groups of strategies (owner, 10 Oct 2026: "account 1's in one group, account 2's in another; clone and update").
 *
 * A desk on paper with the account imported from `.env` and a second one added. Pinned here: the first start puts
 * each account's strategies in a group named after it; a group is one account's, its name its own in that account;
 * its switch turns its strategies on or off -- each by the same check as its own switch; a clone is every strategy
 * copied off, live orders off, to the same account or the other; removing a group keeps its strategies.
 */

const dir = mkdtempSync(join(tmpdir(), 'strategy-groups-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'strategy-groups-master';
process.env.DELTA_API_KEY = 'grpKEYgrpKEYgrpKEY1111';
process.env.DELTA_API_SECRET = 'grpSECRETgrpSECRETgrpSECRETgrpSECRETgrpSECRET';
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
await auth.createSession({ token: 'groups-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('strategy-groups-master'), now: Date.now }) });
});
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('groups-session')}` };
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
const list = async (account?: number) => (await api('GET', `/api/strategies${account ? `?account=${account}` : ''}`)).body;

let second = 0;

test('[critical] the first start: each account with strategies gets a group named after it, holding them all', async () => {
  const b = await list();
  const mine = b.strategies.filter((s: any) => s.accountId === main());
  assert.ok(mine.length > 0, 'the seeded strategies are the imported account\'s');
  const g = b.groups.find((x: any) => x.accountId === main());
  assert.ok(g, JSON.stringify(b.groups));
  assert.equal(g.id, `group-${main()}`);
  assert.equal(g.name, brokerAccounts().get(main())!.name);
  assert.equal(g.accountName, brokerAccounts().get(main())!.name);
  assert.ok(mine.every((s: any) => s.groupId === g.id), 'every one of them in it');
});

test('[critical] run again on a desk with a second account\'s strategies: each account its own group, nothing else touched', async () => {
  const two = await brokerAccounts().create({ name: 'Low win%', apiKey: 'grpKEYtwoKEYtwo2222', apiSecret: 'grpSECRETtwoSECRETtwoSECRETtwo2222' });
  second = two.id;
  // A strategy of account 2 from before groups, and the migration forgotten: it runs again and groups it too.
  await query(`INSERT INTO strategies (id, name, enabled, config, created_at, updated_at, broker_account_id) VALUES ('old-two', 'Old two', true, $1, 1, 1, $2)`, [JSON.stringify(config), second]);
  await query("DELETE FROM schema_migrations WHERE id = 'strategy-010-groups'");
  await StrategyStore.open();
  const b = await list();
  const g2 = b.groups.find((x: any) => x.accountId === second);
  assert.equal(g2?.name, 'Low win%');
  const old = b.strategies.find((s: any) => s.id === 'old-two');
  assert.equal(old.groupId, g2.id);
  assert.equal(old.enabled, true, 'its switch untouched');
  assert.equal(b.groups.filter((x: any) => x.accountId === main()).length, 1, 'the first account\'s group not made twice');
});

test('[critical] a group is one account\'s: made empty, its name its own within the account, refused in words', async () => {
  const made = await api('POST', '/api/strategy-groups', { name: 'Scalps', accountId: main() });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.group.accountId, main());
  const again = await api('POST', '/api/strategy-groups', { name: 'scalps', accountId: main() });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'This account already has a group named "scalps".');
  assert.equal((await api('POST', '/api/strategy-groups', { name: 'Scalps', accountId: second })).status, 200, 'the same name on another account is fine');
  assert.equal((await api('POST', '/api/strategy-groups', { name: '  ', accountId: main() })).body.error, 'Give the group a name.');
  assert.equal((await api('POST', '/api/strategy-groups', { name: 'x'.repeat(41), accountId: main() })).body.error, 'A group name is at most 40 characters.');
  assert.equal((await api('POST', '/api/strategy-groups', { name: 'Nowhere', accountId: 999 })).body.error, 'No such broker account.');
  // Renamed: its account and strategies not touched; a name another of the account's has is refused.
  const renamed = await api('POST', `/api/strategy-groups/${made.body.group.id}`, { name: 'Fast scalps' });
  assert.equal(renamed.body.group.name, 'Fast scalps');
  assert.equal((await api('POST', `/api/strategy-groups/${made.body.group.id}`, { name: brokerAccounts().get(main())!.name })).status, 409);
});

test('[critical] a strategy is made in a group of its own account, moved between them, and never into another account\'s', async () => {
  const groups = (await list()).groups;
  const scalps = groups.find((g: any) => g.accountId === main() && g.name === 'Fast scalps');
  const theirs = groups.find((g: any) => g.accountId === second && g.name === 'Scalps');
  const made = await api('POST', '/api/strategies', { name: 'Grp one', accountId: main(), groupId: scalps.id, config });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.strategy.groupId, scalps.id);
  assert.equal(made.body.strategy.enabled, false);
  assert.equal((await api('POST', '/api/strategies', { name: 'Grp wrong', accountId: main(), groupId: theirs.id, config })).status, 422);
  // Saved again: it keeps its group (a move is its own act).
  const saved = await api('POST', '/api/strategies', { id: 'grp-one', name: 'Grp one', config: { ...config, lots: 2 } });
  assert.equal(saved.body.strategy.groupId, scalps.id);
  // Moved to the account's own group, out of any, and refused into the other account's.
  const own = groups.find((g: any) => g.id === `group-${main()}`);
  assert.equal((await api('POST', '/api/strategies/grp-one/group', { groupId: own.id })).body.strategy.groupId, own.id);
  assert.equal((await api('POST', '/api/strategies/grp-one/group', { groupId: null })).body.strategy.groupId, null);
  const across = await api('POST', '/api/strategies/grp-one/group', { groupId: theirs.id });
  assert.equal(across.status, 422);
  assert.match(across.body.error, /another account's/);
  await api('POST', '/api/strategies/grp-one/group', { groupId: scalps.id });
  // A strategy's own copy stays in its group.
  assert.equal((await api('POST', '/api/strategies/grp-one/clone', {})).body.strategy.groupId, scalps.id);
});

test('[critical] the group\'s switch: every strategy on or off, each by its own check -- one that does not pass is left off and named', async () => {
  const scalps = (await list()).groups.find((g: any) => g.accountId === main() && g.name === 'Fast scalps');
  await api('POST', '/api/strategies', { name: 'Grp broken', accountId: main(), groupId: scalps.id, config });
  await query(`UPDATE strategies SET config = jsonb_set(config, '{lots}', '0') WHERE id = 'grp-broken'`);
  const on = await api('POST', `/api/strategy-groups/${scalps.id}/enabled`, { enabled: true });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body.changed.sort(), ['grp-one', 'grp-one-copy']);
  assert.deepEqual(on.body.leftOff.map((x: any) => x.name), ['Grp broken']);
  assert.match(on.body.leftOff[0].problems.join(' '), /Lots must be a whole number/);
  const members = (await list()).strategies.filter((s: any) => s.groupId === scalps.id);
  assert.deepEqual(members.map((s: any) => [s.id, s.enabled]).sort(), [['grp-broken', false], ['grp-one', true], ['grp-one-copy', true]]);
  // Others' strategies untouched.
  assert.equal((await list()).strategies.find((s: any) => s.id === 'old-two').enabled, true);
  const off = await api('POST', `/api/strategy-groups/${scalps.id}/enabled`, { enabled: false });
  assert.deepEqual(off.body.changed.sort(), ['grp-one', 'grp-one-copy']);
  assert.ok((await list()).strategies.filter((s: any) => s.groupId === scalps.id).every((s: any) => !s.enabled));
  assert.equal((await api('POST', `/api/strategy-groups/${scalps.id}/enabled`, { enabled: 'yes' })).status, 400);
});

test('[critical] clone to the other account: every strategy copied there, switched off, live orders off, names kept -- the source untouched', async () => {
  const before = await list();
  const scalps = before.groups.find((g: any) => g.accountId === main() && g.name === 'Fast scalps');
  await api('POST', `/api/strategy-groups/${scalps.id}/enabled`, { enabled: true });
  const r = await api('POST', `/api/strategy-groups/${scalps.id}/clone`, { accountId: second });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.group.accountId, second);
  assert.equal(r.body.group.name, 'Fast scalps');
  assert.equal(r.body.group.accountName, 'Low win%', 'said by name, as on the list');
  assert.equal(r.body.strategies.length, 3);
  for (const c of r.body.strategies) {
    assert.equal(c.accountId, second);
    assert.equal(c.groupId, r.body.group.id);
    assert.equal(c.enabled, false);
    assert.equal(c.config.liveOrders, false);
  }
  assert.deepEqual(r.body.strategies.map((c: any) => c.name).sort(), ['Grp broken', 'Grp one', 'Grp one copy']);
  const after = await list();
  assert.ok(after.strategies.filter((s: any) => s.groupId === scalps.id && s.id !== 'grp-broken').every((s: any) => s.enabled), 'the source still on');
  // To the same account: "copy" on the group and on each strategy; a name taken is said.
  const same = await api('POST', `/api/strategy-groups/${scalps.id}/clone`, {});
  assert.equal(same.body.group.name, 'Fast scalps copy');
  assert.ok(same.body.strategies.every((c: any) => c.name.endsWith(' copy') && c.accountId === main()));
  assert.equal((await api('POST', `/api/strategy-groups/${scalps.id}/clone`, {})).status, 409, '"Fast scalps copy" is taken now');
  // Each account's list has its own groups only.
  assert.ok((await list(second)).groups.every((g: any) => g.accountId === second));
});

test('[critical] copy in: strategies of any account and group, into a new group or one that exists -- off, live orders off, names kept unless taken', async () => {
  const before = await list();
  const count = { groups: before.groups.length, strategies: before.strategies.length };
  const wasOn = before.strategies.find((s: any) => s.id === 'grp-one').enabled;
  // From two accounts and three groups into a new group of the first account.
  const made = await api('POST', '/api/strategy-groups/copy-in', { strategyIds: ['old-two', 'grp-one'], newGroup: { name: 'Mixed', accountId: main() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.group.name, 'Mixed');
  assert.equal(made.body.group.accountId, main());
  assert.equal(made.body.group.accountName, brokerAccounts().get(main())!.name);
  // "Old two" is new to this account: kept. "Grp one" and "Grp one copy" are both here already: "Grp one copy 2".
  assert.deepEqual(made.body.strategies.map((c: any) => c.name), ['Old two', 'Grp one copy 2']);
  for (const c of made.body.strategies) {
    assert.equal(c.accountId, main());
    assert.equal(c.groupId, made.body.group.id);
    assert.equal(c.enabled, false);
    assert.equal(c.config.liveOrders, false);
  }
  // Into a group that exists, of the other account (which has "Grp one" and "Grp one copy" from the clone); twice is one copy.
  const theirs = before.groups.find((g: any) => g.accountId === second && g.name === 'Scalps');
  const into = await api('POST', '/api/strategy-groups/copy-in', { strategyIds: ['grp-one', 'grp-one'], groupId: theirs.id });
  assert.equal(into.status, 200, JSON.stringify(into.body));
  assert.deepEqual(into.body.strategies.map((c: any) => [c.name, c.accountId, c.groupId, c.enabled]), [['Grp one copy 2', second, theirs.id, false]]);
  // The sources as they were.
  const after = await list();
  assert.equal(after.strategies.find((s: any) => s.id === 'grp-one').enabled, wasOn);
  assert.equal(after.strategies.find((s: any) => s.id === 'old-two').accountId, second);
  assert.equal(after.groups.length, count.groups + 1);
  assert.equal(after.strategies.length, count.strategies + 3);

  // Refused in words, and nothing made.
  const refusals: [unknown, number, RegExp][] = [
    [{ strategyIds: [], groupId: theirs.id }, 422, /Pick at least one strategy/],
    [{ strategyIds: ['grp-one'] }, 422, /an existing one or a new one/],
    [{ strategyIds: ['grp-one'], groupId: theirs.id, newGroup: { name: 'Both', accountId: main() } }, 422, /an existing one or a new one/],
    [{ strategyIds: ['grp-one', 'nope'], newGroup: { name: 'Ghost', accountId: main() } }, 422, /No such strategy: nope/],
    [{ strategyIds: ['grp-one'], newGroup: { name: 'mixed', accountId: main() } }, 409, /already has a group named "mixed"/],
    [{ strategyIds: ['grp-one'], newGroup: { name: ' ', accountId: main() } }, 422, /Give the group a name/],
    [{ strategyIds: ['grp-one'], newGroup: { name: 'Far', accountId: 999 } }, 422, /No such broker account/],
    [{ strategyIds: ['grp-one'], groupId: 'no-such-group' }, 404, /no such group/],
  ];
  for (const [body, status, said] of refusals) {
    const r = await api('POST', '/api/strategy-groups/copy-in', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match(r.body.error, said);
  }
  const still = await list();
  assert.equal(still.groups.length, after.groups.length);
  assert.equal(still.strategies.length, after.strategies.length);
});

test('[critical] removing a group keeps its strategies, as they were, in no group', async () => {
  const b = await list();
  const g = b.groups.find((x: any) => x.accountId === main() && x.name === 'Fast scalps copy');
  const members = b.strategies.filter((s: any) => s.groupId === g.id).map((s: any) => [s.id, s.enabled]);
  const r = await api('DELETE', `/api/strategy-groups/${g.id}`);
  assert.equal(r.body.ungrouped, members.length);
  const after = await list();
  assert.equal(after.groups.some((x: any) => x.id === g.id), false);
  for (const [id, enabled] of members) {
    const s = after.strategies.find((x: any) => x.id === id);
    assert.equal(s.groupId, null);
    assert.equal(s.enabled, enabled);
  }
  assert.equal((await api('DELETE', `/api/strategy-groups/${g.id}`)).status, 404);
  // The index every screen that names a strategy reads: each strategy's group, every account's, and nothing more.
  const idx = await api('GET', '/api/strategy-groups/index');
  assert.equal(idx.status, 200);
  assert.deepEqual(Object.keys(idx.body).sort(), ['groups', 'of']);
  const listed = await list();
  for (const st of listed.strategies) assert.equal(idx.body.of[st.id] ?? null, st.groupId ?? null, st.id);
  assert.ok(idx.body.groups.some((x: any) => x.accountId === second && x.accountName === 'Low win%'));
  assert.ok(JSON.stringify(idx.body).length < JSON.stringify(listed).length / 4, 'small: a lookup, not the list');
  // The phone's light read carries the groups too.
  assert.ok(Array.isArray((await api('GET', '/api/strategies?lite=1')).body.groups));
  assert.ok(strategyStore());
});
