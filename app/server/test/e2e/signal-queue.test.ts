import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The line a signal waits in (13 Oct 2026).
 *
 * At 9:30 PM on 11 Oct every timeframe's candle closed together: sixty orders
 * stood in one line for both accounts, a second and a half each, and the 25
 * signals still waiting at 90 seconds -- seventeen 4h, eight 2h -- were written
 * off as "too late to enter". Three things were changed, and each is held here
 * on a desk with two accounts, on paper, through the real runner and database:
 *
 *   a line per account      one account's orders do not wait on the other's;
 *   longest timeframe first in a line, then whichever came first;
 *   lateness by timeframe   90 s for a 5m signal, up to ten minutes for a 4h.
 *
 * And what must not change: "at most N open" is still exact when many signals
 * come at once, a strategy switched off while its signal waited is not traded,
 * and a fill the perp has already finished is not entered.
 */

const dir = mkdtempSync(join(tmpdir(), 'sig-queue-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'signal-queue-master';
process.env.DELTA_API_KEY = 'envKEYenvKEYenvKEY9999';
process.env.DELTA_API_SECRET = 'envSECRETenvSECRETenvSECRETenvSECRETenvSECRET';
process.env.DELTA_LIVE_TRADING = '0';

const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, rows } = await import('../../src/db/pool.js');
const { initTradingService, tradingService, tradingServiceFor } = await import('../../src/trading/service.js');
const { initStrategyStore, strategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { brokerAccounts } = await import('../../src/delta/accounts.js');
const { StrategyRunner, ZONE_FILL_FRESH_MS, goesBefore, zoneFillFreshMs } = await import('../../src/strategy/runner.js');
const { istDate } = await import('../../src/strategy/schedule.js');
const { SIDE_MAX_KEYS } = await import('../../src/strategy/types.js');
type MethodRead = import('../../src/entry/types.js').MethodRead;
type Tf = import('../../src/entry/types.js').Tf;
type SetupFill = import('../../src/entry/paper.js').SetupFill;
type SignalBoard = import('../../src/strategy/runner.js').SignalBoard;
type Desk = NonNullable<ReturnType<typeof tradingServiceFor>>;

await initTradingService();
await initStrategyStore();
await (await import('../../src/entry/paper.js')).entrySchema();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'queue-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({
    auth: new AuthService({ store: auth, secrets: new Secrets('signal-queue-master'), now: Date.now }),
    accountTest: async () => ({ ok: true, detail: 'Connected.' }),
  });
});
after(async () => { for (const a of brokerAccounts().list()) tradingServiceFor(a.id)?.stop(); tradingService().stop(); await app.close(); await closePool(); });

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('queue-session')}` };
const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: cookie, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as Record<string, any>, text: r.body };
};

// ------------------------------------------------------------ the board, the clock, the signals

const EXPIRY = '031026';
const EXPIRY_TS = Math.floor(Date.now() / 1000) + 86_400;
const PUT = 84_000, CALL = 86_000;
const board: SignalBoard = {
  live: true, isDaily: true, expiry: EXPIRY, expiryTs: EXPIRY_TS, spot: 85_000,
  candidates: [
    { cp: 'P', strike: PUT, sellPrice: 18, pOtm: 0.8, moneyness: 'OTM', ask: 18.5 },
    { cp: 'C', strike: CALL, sellPrice: 18, pOtm: 0.8, moneyness: 'OTM', ask: 18.5 },
  ],
};
/** The contracts and their quotes, on one account's own paper exchange. */
const stock = (desk: Desk) => {
  for (const [cp, strike, pid] of [['P', PUT, 7001], ['C', CALL, 7002]] as const) {
    const symbol = `${cp}-BTC-${strike}-${EXPIRY}`;
    desk.paper()!.addProduct({ symbol, productId: pid, underlying: 'BTC', optionSide: cp === 'P' ? 'PE' : 'CE', strike, expiryTs: EXPIRY_TS, tickSize: 0.1, lotSize: 1, contractValue: 0.001, state: 'live' });
    desk.paper()!.setQuote({ symbol, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
};

/** 10:00 IST today: inside the strategies' 09:00-17:00 window, whenever the test runs. */
const [y, mo, d] = istDate(Date.now()).split('-').map(Number) as [number, number, number];
const TEN = Date.UTC(y, mo - 1, d) - 330 * 60_000 + 10 * 3_600_000;
const clock = TEN;
/** Where the perp is, as the runner reads it: null is "no fresh print", as on a desk with the tape down. */
let perp: number | null = null;
const runner = new StrategyRunner(strategyStore(), () => clock, async () => board, () => perp);

let trigger = 1_790_000_000;
const signal = (tf: Tf, o: Partial<MethodRead> = {}): MethodRead => ({
  id: 'breakout', n: 1, code: '1', name: 'Breakout', group: 'breakout', summary: '', mode: 'single', tf,
  dir: 'long', state: 'TRADE', steps: [], gates: [], score: 70, scoreParts: [], alignment: null, reason: '',
  triggerTime: trigger += 14_400,
  plan: { entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: null, tp3: null, tpWhy: [], rr: 1.25 },
  ...o,
});
const fill = (tf: Tf, agoSec: number, o: Partial<SetupFill> = {}): SetupFill => ({
  method: 'breakout', mode: 'single', tf, dir: 1, triggerAt: trigger += 14_400,
  entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: null, tp3: null,
  status: 'filled', filledAt: Math.floor(clock / 1000) - agoSec, fillPrice: 84_990, ...o,
});
/** The paper log writes every TRADE before the runner sees it: what "at most N open" counts, with live orders off. */
const logged = async (s: MethodRead): Promise<MethodRead> => {
  await rows(`INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, rr, graded_to)
              VALUES ($1, $2, $3, 1, $4, $5, 84950, 85000, 84600, 85500, 1.25, 0)`, [s.id, s.mode, s.tf, s.triggerTime, Date.now()]);
  return s;
};

const TFS: Tf[] = ['5m', '15m', '30m', '1h', '2h', '4h'];
const config = (o: { maxOpen?: number; enterOn?: 'signal' | 'zone' } = {}) => ({
  trigger: 'signal', signal: { mode: 'single', tf: '5m', tfs: TFS, methods: ['breakout'], target: 'tp1', maxOpen: o.maxOpen ?? 50, enterOn: o.enterOn ?? 'signal' },
  liveOrders: false,
  entryTime: '09:00', exitTime: '17:00', lots: 1, legs: 'both',
  strikeRule: 'premium', premium: { mode: 'atMost', usd: 20, fallbackUsd: null },
  entryPrice: 'offer', crossAfterSec: 5, maxCrossSpreadPct: 0.5,
  takeProfitPct: 0.99, stopLossPct: 3, minPremiumUsd: 1,
  weekdays: [0, 1, 2, 3, 4, 5, 6], graceMin: 60,
});
const runsOf = (id: string) => rows<{ status: string; detail: string; signal_key: string }>(
  'SELECT status, detail, signal_key FROM strategy_signal_runs WHERE strategy_id = $1 ORDER BY id', [id]);
/** The timeframes of a strategy's rows, in the order they were claimed -- the order its signals had their turn. */
const turnsOf = async (id: string, from = 0) => (await runsOf(id)).slice(from).map((r) => r.signal_key.split('|')[2]);
const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const settled = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

/**
 * Hold one account's desk at the point every signal reaches after its claim -- the count of what is open --
 * until `open()`: an exchange that takes its time, as Delta did for a second and a half an order.
 */
const hold = (desk: Desk) => {
  const real = desk.openTrades.bind(desk);
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  desk.openTrades = (async (...a: Parameters<typeof real>) => { await gate; return real(...a); }) as typeof desk.openTrades;
  return { open: () => { open(); desk.openTrades = real; } };
};

let main = 0, second = 0;
const make = async (name: string, account: number, o: Parameters<typeof config>[0] = {}) => {
  const r = await api('POST', '/api/strategies', { name, config: config(o), accountId: account });
  assert.equal(r.status, 200, r.text);
  assert.equal((await api('POST', `/api/strategies/${r.body.strategy.id}/enabled`, { enabled: true })).status, 200);
  return r.body.strategy.id as string;
};
const off = async (...ids: string[]) => { for (const id of ids) await api('POST', `/api/strategies/${id}/enabled`, { enabled: false }); };

// ------------------------------------------------------------ the rules, by themselves

test('[critical] the order of a line: the longer timeframe first, and on the same timeframe whichever came first', () => {
  const line = [{ tfSec: 300, seq: 0 }, { tfSec: 14_400, seq: 3 }, { tfSec: 900, seq: 1 }, { tfSec: 14_400, seq: 2 }, { tfSec: 300, seq: 4 }];
  const sorted = [...line].sort((a, b) => (goesBefore(a, b) ? -1 : goesBefore(b, a) ? 1 : 0));
  assert.deepEqual(sorted.map((x) => `${x.tfSec}#${x.seq}`), ['14400#2', '14400#3', '900#1', '300#0', '300#4']);
  assert.equal(goesBefore({ tfSec: 300, seq: 0 }, { tfSec: 300, seq: 0 }), false, 'nothing goes before itself');
});

test('[critical] how late a zone fill may be entered: 90 s for a 5m signal, longer with the timeframe, never past ten minutes', () => {
  assert.equal(ZONE_FILL_FRESH_MS, 90_000);
  assert.deepEqual(TFS.map((tf) => zoneFillFreshMs(tf) / 1_000), [90, 150, 210, 300, 450, 600]);
  // No timeframe has less than the 5m signal's, and each has at least the one before it.
  for (const tf of ['1m', '3m'] as Tf[]) assert.equal(zoneFillFreshMs(tf), ZONE_FILL_FRESH_MS);
  assert.ok(TFS.every((tf, i) => i === 0 || zoneFillFreshMs(tf) > zoneFillFreshMs(TFS[i - 1]!)));
  assert.ok(TFS.every((tf) => zoneFillFreshMs(tf) <= 600_000));
});

// ------------------------------------------------------------ a line per account

test('[critical] two accounts, a line each: one account held up at the exchange does not keep the other waiting', async () => {
  main = brokerAccounts().default()!.id;
  const made = await api('POST', '/api/accounts', { name: 'Second', api_key: 'newKEYnewKEYnewKEY4242', api_secret: 'newSECRETnewSECRETnewSECRETnewSECRETnewSECRET' });
  assert.equal(made.status, 200, made.text);
  second = made.body.accounts.find((a: { name: string }) => a.name === 'Second').id;
  const [deskA, deskB] = [tradingServiceFor(main)!, tradingServiceFor(second)!];
  assert.ok(deskA && deskB && deskA !== deskB, 'a desk each');
  stock(deskA); stock(deskB);
  await tradingService().settings.set('scheduler_enabled', '1');
  // The sides' own limits are another test's (signal-strategy): here each side may fill the whole cap.
  for (const k of [SIDE_MAX_KEYS.CE, SIDE_MAX_KEYS.PE]) await tradingService().settings.set(k, '100');
  await make('Queue A', main);
  await make('Queue B', second);

  // The first account is held; the second's signal is traded all the same -- and then the other way about.
  for (const [held, waits, goes] of [[deskA, 'queue-a', 'queue-b'], [deskB, 'queue-b', 'queue-a']] as const) {
    const before = { waits: (await runsOf(waits)).length, goes: (await runsOf(goes)).length };
    const gate = hold(held);
    const done = runner.onSignal(await logged(signal('15m')));
    try {
      await until(async () => (await runsOf(goes)).slice(before.goes), (r) => r.length === 1 && r[0]!.status === 'would-place', `${goes} to be traded while ${waits} waits`);
      assert.deepEqual((await runsOf(waits)).slice(before.waits).map((r) => r.status), ['claimed'], 'the held account has claimed its signal and no more');
      assert.equal(await settled(done, 50), false, 'and the signal is not done until both accounts have had their turn');
    } finally {
      gate.open();
    }
    await done;
    assert.deepEqual((await runsOf(waits)).slice(before.waits).map((r) => r.status), ['would-place']);
  }
});

test('[critical] a held account holds only its own line: the other account trades a whole burst meanwhile', async () => {
  const before = { a: (await runsOf('queue-a')).length, b: (await runsOf('queue-b')).length };
  const gate = hold(tradingServiceFor(main)!);
  const burst = await Promise.all(['5m', '15m', '1h', '4h'].map((tf) => logged(signal(tf as Tf))));
  const done = Promise.all(burst.map((s) => runner.onSignal(s)));
  try {
    await until(() => turnsOf('queue-b', before.b), (t) => t.length === 4, 'the second account to trade all four');
    assert.equal((await runsOf('queue-b')).slice(before.b).every((r) => r.status === 'would-place'), true);
    assert.equal((await runsOf('queue-a')).length, before.a + 1, 'the first account is still on its first');
  } finally {
    gate.open();
  }
  await done;
  assert.equal((await runsOf('queue-a')).length, before.a + 4);
});

// ------------------------------------------------------------ longest timeframe first

test('[critical] a burst is traded longest timeframe first -- 4h before 5m -- in both accounts, whatever order it came in', async () => {
  const before = { a: (await runsOf('queue-a')).length, b: (await runsOf('queue-b')).length };
  const burst = await Promise.all((['5m', '15m', '4h', '5m', '2h', '30m', '1h', '4h'] as Tf[]).map((tf) => logged(signal(tf))));
  await Promise.all(burst.map((s) => runner.onSignal(s)));
  const want = ['4h', '4h', '2h', '1h', '30m', '15m', '5m', '5m'];
  assert.deepEqual(await turnsOf('queue-a', before.a), want);
  assert.deepEqual(await turnsOf('queue-b', before.b), want);
  // On the same timeframe, the one that came first: the two 4h and the two 5m in the order they were handed over.
  const keys = (await runsOf('queue-a')).slice(before.a).map((r) => r.signal_key);
  assert.deepEqual([keys[0], keys[1]], [burst[2], burst[7]].map((s) => `breakout|single|4h|1|${s!.triggerTime}`));
  assert.deepEqual([keys[6], keys[7]], [burst[0], burst[3]].map((s) => `breakout|single|5m|1|${s!.triggerTime}`));
});

test('[critical] signals that arrive while one is being traded: the next taken is the longest timeframe waiting, not the next in line', async () => {
  const before = (await runsOf('queue-a')).length;
  const gate = hold(tradingServiceFor(main)!);
  const all: Promise<void>[] = [];
  try {
    all.push(runner.onSignal(await logged(signal('5m'))));
    await until(() => turnsOf('queue-a', before), (t) => t.length === 1, 'the first to be on its turn');
    // Three more come in behind it, shortest first.
    for (const tf of ['5m', '15m', '4h'] as Tf[]) all.push(runner.onSignal(await logged(signal(tf))));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await turnsOf('queue-a', before), ['5m'], 'nothing else is taken while the first is at the exchange');
  } finally {
    gate.open();
  }
  await Promise.all(all);
  assert.deepEqual(await turnsOf('queue-a', before), ['5m', '4h', '15m', '5m']);
});

// ------------------------------------------------------------ what must not change

test('[critical] "at most 2 open" is still exact in a burst: two taken and the rest skipped, in each account by its own count', async () => {
  await off('queue-a', 'queue-b');
  await make('Cap A', main, { maxOpen: 2 });
  await make('Cap B', second, { maxOpen: 2 });
  const burst = await Promise.all((['5m', '5m', '15m', '1h', '4h', '5m', '2h'] as Tf[]).map((tf) => logged(signal(tf))));
  await Promise.all(burst.map((s) => runner.onSignal(s)));
  for (const id of ['cap-a', 'cap-b']) {
    const runs = await runsOf(id);
    assert.deepEqual(runs.map((r) => r.status), ['would-place', 'would-place', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped'], id);
    assert.deepEqual(runs.slice(0, 2).map((r) => r.signal_key.split('|')[2]), ['4h', '2h'], 'and the two it has room for are the longest timeframes');
    assert.match(runs[2]!.detail, /already 2 of its trades open \(2 would-sell\) -- at most 2/);
  }
  await off('cap-a', 'cap-b');
});

test('[critical] a strategy switched off while its signal waited in line is not traded; nor anything once the desk is disarmed', async () => {
  const id = await make('Queue off', main);
  const gate = hold(tradingServiceFor(main)!);
  const one: Promise<void>[] = [];
  try {
    one.push(runner.onSignal(await logged(signal('15m'))));
    await until(() => runsOf(id), (r) => r.length === 1, 'the first to be on its turn');
    one.push(runner.onSignal(await logged(signal('1h'))));
    await new Promise((r) => setTimeout(r, 50));
    await off(id);
  } finally {
    gate.open();
  }
  await Promise.all(one);
  assert.deepEqual(await turnsOf(id), ['15m'], 'the one that waited found its strategy off');

  await api('POST', `/api/strategies/${id}/enabled`, { enabled: true });
  const gate2 = hold(tradingServiceFor(main)!);
  const two: Promise<void>[] = [];
  try {
    two.push(runner.onSignal(await logged(signal('15m'))));
    await until(() => runsOf(id), (r) => r.length === 2, 'the next to be on its turn');
    two.push(runner.onSignal(await logged(signal('4h'))));
    await new Promise((r) => setTimeout(r, 50));
    await tradingService().settings.set('scheduler_enabled', '0');
  } finally {
    gate2.open();
  }
  try {
    await Promise.all(two);
    assert.deepEqual(await turnsOf(id), ['15m', '15m'], 'disarmed while it waited: not traded');
    await runner.onSignal(await logged(signal('4h')));
    assert.equal((await runsOf(id)).length, 2, 'and nothing joins a line on a desk that is not armed');
  } finally {
    await tradingService().settings.set('scheduler_enabled', '1');
    await off(id);
  }
});

// ------------------------------------------------------------ lateness, by timeframe

test('[critical] a zone fill 5 minutes old: a 4h signal is still entered, a 5m one is too late -- each by its own timeframe\'s limit', async () => {
  const id = await make('Zone late', main, { enterOn: 'zone' });
  const last = async () => (await runsOf(id)).at(-1)!;

  await runner.onSetupFilled(await logged(signal('4h')).then((s) => fill('4h', 300, { triggerAt: s.triggerTime! })));
  assert.equal((await last()).status, 'would-place', (await last()).detail);
  assert.match((await last()).detail, /perp filled 84990/);

  // Every timeframe at its own limit is taken, and a second past it is not.
  for (const tf of TFS) {
    const most = zoneFillFreshMs(tf) / 1_000;
    await runner.onSetupFilled(await logged(signal(tf)).then((s) => fill(tf, most, { triggerAt: s.triggerTime! })));
    assert.equal((await last()).status, 'would-place', `${tf} at ${most}s: ${(await last()).detail}`);
    await runner.onSetupFilled(fill(tf, most + 1));
    assert.equal((await last()).status, 'skipped', `${tf} at ${most + 1}s`);
    assert.match((await last()).detail, new RegExp(`filled at 84990 ${most + 1}s ago -- too late to enter \\(a ${tf} signal within ${most}s\\)$`));
  }
  // What 11 Oct dropped: 4h and 2h fills between 90 and 120 seconds old.
  for (const tf of ['4h', '2h'] as Tf[]) {
    await runner.onSetupFilled(await logged(signal(tf)).then((s) => fill(tf, 110, { triggerAt: s.triggerTime! })));
    assert.equal((await last()).status, 'would-place', (await last()).detail);
  }
  await runner.onSetupFilled(fill('5m', 110));
  assert.match((await last()).detail, /110s ago -- too late to enter \(a 5m signal within 90s\)$/);
  await off(id);
});

test('[critical] a late fill the perp has already finished -- at the signal\'s stop, or its target -- is not entered', async () => {
  const id = await make('Zone over', main, { enterOn: 'zone' });
  const last = async () => (await runsOf(id)).at(-1)!;
  try {
    perp = 84_590;                                             // a BUY signal, stop 84,600: through it
    await runner.onSetupFilled(fill('4h', 240));
    assert.equal((await last()).status, 'skipped');
    assert.match((await last()).detail, /filled at 84990 240s ago and is at 84590 now, already at the signal's SL 84600 -- over before it could be entered$/);
    perp = 85_500;                                             // at its target
    await runner.onSetupFilled(fill('4h', 240));
    assert.match((await last()).detail, /is at 85500 now, already at the signal's TGT 85500 -- over/);
    // A SELL signal reads the other way: stop above, target below.
    const short = { dir: -1 as const, entryLo: 85_000, entryHi: 85_050, stop: 85_400, tp1: 84_500, fillPrice: 85_010 };
    perp = 85_400;
    await runner.onSetupFilled(fill('2h', 30, short));
    assert.match((await last()).detail, /already at the signal's SL 85400 -- over/);
    perp = 84_499;
    await runner.onSetupFilled(fill('2h', 30, short));
    assert.match((await last()).detail, /already at the signal's TGT 84500 -- over/);

    // Between the two it is entered, at the fill -- and so it is when the tape has no fresh print to judge by.
    for (const at of [85_100, null]) {
      perp = at;
      await runner.onSetupFilled(await logged(signal('4h')).then((s) => fill('4h', 240, { triggerAt: s.triggerTime! })));
      assert.equal((await last()).status, 'would-place', (await last()).detail);
    }
  } finally {
    perp = null;
    await off(id);
  }
});
