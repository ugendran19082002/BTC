import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importSqlite } from '../../src/db/import-sqlite.js';
import { closePool, one, query } from '../../src/db/pool.js';
import { PgTradeStore } from '../../src/trading/store.js';
import { StrategyStore } from '../../src/strategy/store.js';
import { AuthStore } from '../../src/auth/store.js';
import { ErrorLog } from '../../src/observability/errors.js';
import { MemorySettings, SettingsCache } from '../../src/db/settings.js';
import { initialTrade } from '../../src/trading/machine.js';

/**
 * The cutover: the SQLite files the desk kept until September 2026, copied into
 * PostgreSQL once. What is pinned is that every row lands, that what the
 * stores read back is what the SQLite desk had, and that running it twice
 * changes nothing.
 */

after(() => closePool());

/** The files as the SQLite desk wrote them -- the old schema, the old encodings. */
function fixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), 'import-'));

  const trades = new DatabaseSync(join(dir, 'trades.db'));
  trades.exec(`
    CREATE TABLE trades (trade_id TEXT PRIMARY KEY, symbol TEXT, phase TEXT, position INTEGER, plan TEXT, state TEXT, updated_at INTEGER);
    CREATE TABLE trade_events (id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id TEXT, seq INTEGER, at INTEGER, kind TEXT, event TEXT, UNIQUE (trade_id, seq));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE mtm_samples (at INTEGER PRIMARY KEY, day TEXT, realised REAL, unrealised REAL, charges REAL, net REAL);
    CREATE TABLE strategies (id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, config TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE strategy_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id TEXT, run_date TEXT, status TEXT, detail TEXT, at INTEGER, UNIQUE (strategy_id, run_date));
    CREATE TABLE strategy_adds (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id TEXT, run_date TEXT, source_trade_id TEXT, source_side TEXT, symbol TEXT, contracts INTEGER, status TEXT, detail TEXT, added_to_trade_id TEXT, at INTEGER);
    CREATE TABLE strategy_rebalances (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id TEXT, run_date TEXT, stage INTEGER, up_side TEXT, down_side TEXT, up_pct REAL, down_pct REAL, lots INTEGER, status TEXT, detail TEXT, bought_trade_id TEXT, sold_trade_id TEXT, at INTEGER);
    CREATE TABLE premium_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT);
  `);
  const state = initialTrade({ tradeId: 'C-BTC-79600-090926-1', symbol: 'C-BTC-79600-090926', productId: 1, optionSide: 'CE', requestedSize: 10, at: 1_000 });
  const plan = {
    tradeId: state.tradeId, symbol: state.symbol, optionSide: 'CE', lots: 10, leverage: 200,
    entry: { type: 'limit', limitPrice: 7, timeoutMs: 0, marketFallback: false, chase: null },
    takeProfitPrice: 0.5, stopPrice: 21, strategyId: 'double',
    expect: { underlying: 'BTC', optionSide: 'CE', strike: 79_600, expiryTs: 1 },
  };
  trades.prepare('INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(state.tradeId, state.symbol, 'flat', 0, JSON.stringify(plan), JSON.stringify(state), 5_000);
  trades.prepare('INSERT INTO trade_events (id, trade_id, seq, at, kind, event) VALUES (?, ?, ?, ?, ?, ?)')
    .run(7, state.tradeId, 0, 2_000, 'entry_submitted', JSON.stringify({ t: 'entry_submitted', clientOrderId: 'c', size: 10, at: 2_000 }));
  trades.prepare('INSERT INTO trade_events (id, trade_id, seq, at, kind, event) VALUES (?, ?, ?, ?, ?, ?)')
    .run(9, state.tradeId, 1, 3_000, 'fill', JSON.stringify({ t: 'fill', role: 'entry', side: 'sell', size: 10, price: 7, orderId: 'o', at: 3_000 }));
  trades.prepare('INSERT INTO settings VALUES (?, ?)').run('mode', 'live');
  trades.prepare('INSERT INTO settings VALUES (?, ?)').run('max_short_contracts', '425');
  trades.prepare('INSERT INTO mtm_samples VALUES (?, ?, ?, ?, ?, ?)').run(4_000, '2026-09-09', 1.5, -0.5, 0.1, 0.9);
  trades.prepare('INSERT INTO strategies VALUES (?, ?, ?, ?, ?, ?)')
    .run('double', 'Double one-sided (mine)', 1, JSON.stringify({ lots: 42, probGate: 0.9 }), 1, 2);
  trades.prepare('INSERT INTO strategy_runs (id, strategy_id, run_date, status, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(3, 'double', '2026-09-09', 'placed', 'CE 79600 x10', 4_500);
  trades.prepare('INSERT INTO strategy_adds (id, strategy_id, run_date, source_trade_id, source_side, symbol, contracts, status, detail, added_to_trade_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(2, 'double', '2026-09-09', state.tradeId, 'CE', null, 10, 'skipped', 'no other leg', null, 4_600);
  trades.close();

  const auth = new DatabaseSync(join(dir, 'auth.db'));
  auth.exec(`
    CREATE TABLE auth_user (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, password_changed_at INTEGER, totp_secret TEXT, totp_enabled_at INTEGER, totp_last_step INTEGER, totp_pending TEXT, totp_pending_at INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, stage TEXT, created_at INTEGER, expires_at INTEGER, last_seen_at INTEGER, ip TEXT, user_agent TEXT, attempts INTEGER, revoked_at INTEGER);
    CREATE TABLE auth_recovery_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER, used_at INTEGER);
    CREATE TABLE auth_limits (key TEXT PRIMARY KEY, count INTEGER, window_until INTEGER);
    CREATE TABLE auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, ip TEXT, detail TEXT);
  `);
  auth.prepare('INSERT INTO auth_user VALUES (1, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)')
    .run('ugendran', 'scrypt$hash', 100, 'sealed-secret', 200, 55_000_000, 100, 200);
  auth.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('a'.repeat(64), 'full', 1, 9_999_999_999_999, 1, '10.0.0.1', 'iPhone Safari', 0, null);
  auth.prepare('INSERT INTO auth_recovery_codes VALUES (?, ?, ?)').run('rc1', 1, null);
  auth.prepare('INSERT INTO auth_recovery_codes VALUES (?, ?, ?)').run('rc2', 1, 5);
  auth.prepare('INSERT INTO auth_events (id, at, kind, ip, detail) VALUES (?, ?, ?, ?, ?)').run(12, 300, 'signin', '10.0.0.1', null);
  auth.close();

  const errors = new DatabaseSync(join(dir, 'errors.db'));
  errors.exec(`
    CREATE TABLE errors (id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT UNIQUE, source TEXT, level TEXT, message TEXT, code TEXT, stack TEXT, where_at TEXT, context TEXT, first_seen INTEGER, last_seen INTEGER, count INTEGER, resolved INTEGER);
  `);
  errors.prepare('INSERT INTO errors (id, fingerprint, source, level, message, code, stack, where_at, context, first_seen, last_seen, count, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(5, ['exchange', 'insufficient_margin', 'POST /v2/orders', 'Delta refused'].join('\0'), 'exchange', 'error', 'Delta refused', 'insufficient_margin', null, 'POST /v2/orders', JSON.stringify({ size: 10 }), 10, 20, 72, 0);
  errors.close();

  const market = new DatabaseSync(join(dir, 'market.db'));
  market.exec(`
    CREATE TABLE oi_snapshots (at INTEGER, expiry TEXT, cp TEXT, strike INTEGER, oi REAL, spot REAL, atm_iv REAL, PRIMARY KEY (at, expiry, cp, strike));
  `);
  market.prepare('INSERT INTO oi_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)').run(300_000, '090926', 'C', 79_600, 4_000, 77_000, null);
  market.prepare('INSERT INTO oi_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)').run(600_000, '090926', 'C', 79_600, 4_100, 77_100, 0.55);
  market.close();

  const analytics = new DatabaseSync(join(dir, 'analytics.db'));
  analytics.exec(`
    CREATE TABLE outlook_states (minutes INTEGER, feature TEXT, bucket TEXT, windows INTEGER, independent INTEGER, side_band_pct REAL, p_down REAL, p_side REAL, p_up REAL, q16_pct REAL, q50_pct REAL, q84_pct REAL, by_year TEXT, lean_holds INTEGER, side_holds INTEGER, lean_z REAL, side_z REAL, measured_at TEXT, PRIMARY KEY (minutes, feature, bucket));
  `);
  analytics.prepare('INSERT INTO outlook_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(60, 'momentum', 'down', 90_000, 7_500, 0.119, 0.337, 0.271, 0.392, -0.25, 0.02, 0.3, '{"2024":1}', 1, 1, 3.2, 3.1, '2026-09-17T00:00:00+00:00');
  analytics.close();

  return dir;
}

test('[critical] every table lands, and what the stores read back is what the SQLite desk had', async () => {
  const dir = fixtures();
  const counts = await importSqlite(dir);
  for (const c of counts) assert.equal(c.target >= c.source, true, `${c.table}: ${c.target} of ${c.source}`);

  // the trade journal, with its events in order and their ids kept
  const trades = await PgTradeStore.open();
  const rec = (await trades.get('C-BTC-79600-090926-1'))!;
  assert.equal(rec.plan.strategyId, 'double');
  assert.deepEqual(rec.events.map((e) => e.t), ['entry_submitted', 'fill']);
  assert.equal(rec.state.tradeId, 'C-BTC-79600-090926-1');
  assert.equal(rec.state.position, 0, 'the stored state carries no fills; the events are the audit trail');
  assert.deepEqual(await one('SELECT id FROM trading.trade_events WHERE seq = 1'), { id: 9 });
  // and a new event would not collide with an imported id
  const next = await one<{ n: number }>("SELECT nextval(pg_get_serial_sequence('trading.trade_events', 'id')) AS n");
  assert.ok(next!.n > 9);

  // settings, read through the cache the desk reads
  const settings = await new SettingsCache().load();
  assert.equal(settings.get('mode'), 'live');
  assert.equal(settings.get('max_short_contracts'), '425');
  assert.equal(settings.get('expiry_default'), 'first', 'the seeded default is still there');

  // the strategy the person had edited beats the fresh seed
  const strategies = await StrategyStore.open(new MemorySettings());
  const double = (await strategies.get('double'))!;
  assert.equal(double.name, 'Double one-sided (mine)');
  assert.equal(double.config.lots, 42);
  assert.equal(double.config.probGate, 0.9);
  // the two seeds the fixture desk does not have were not resurrected
  assert.deepEqual((await strategies.all()).map((x) => x.id), ['double'], 'a deleted strategy does not come back');
  assert.equal(await strategies.lastRunDate('double'), '2026-09-09', 'the day stays claimed: no re-entry after the cutover');
  assert.equal(await strategies.addedFor('C-BTC-79600-090926-1'), 10);

  // the sign-in: the same user, the same live session, one recovery code left
  const auth = await AuthStore.open();
  assert.equal((await auth.user())!.username, 'ugendran');
  assert.equal((await auth.user())!.totpSecret, 'sealed-secret');
  assert.equal(await auth.recoveryCodesLeft(), 1);
  assert.equal((await auth.liveSessions(2)).length, 1);

  // the error log: the NUL in the fingerprint replaced, the count kept
  const log = new ErrorLog(); await log.ready;
  const [err] = await log.list();
  assert.equal(err?.count, 72);
  assert.equal(err?.code, 'insufficient_margin');
  assert.deepEqual(err?.context, { size: 10 });
  // and a repeat of the same failure folds into the imported row rather than making a second
  log.record({ source: 'exchange', code: 'insufficient_margin', where: 'POST /v2/orders', message: 'Delta refused' });
  await log.flush();
  assert.equal((await log.list()).length, 1);
  assert.equal((await log.list())[0]?.count, 73);

  // market history and the analytics tables
  assert.equal((await one<{ n: number }>('SELECT COUNT(*) AS n FROM market.oi_snapshots'))!.n, 2);
  assert.deepEqual(await one('SELECT by_year, lean_holds FROM analytics.outlook_states'), { by_year: { 2024: 1 }, lean_holds: true });
});

test('running it again changes nothing', async () => {
  const dir = fixtures();
  const first = await importSqlite(dir);
  const second = await importSqlite(dir);
  assert.deepEqual(second.map((c) => c.target), first.map((c) => c.target));
  assert.equal((await one<{ n: number }>('SELECT COUNT(*) AS n FROM trading.trade_events'))!.n, 2);
});

test('a directory with no files is an empty import, not a crash', async () => {
  await query('TRUNCATE trading.trades CASCADE');
  const counts = await importSqlite(mkdtempSync(join(tmpdir(), 'import-empty-')));
  assert.deepEqual(counts, []);
});
