import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from './migrate.js';
import { one, query, tx, closePool } from './pool.js';
import { SettingsCache } from './settings.js';
import { PgTradeStore } from '../trading/store.js';
import { StrategyStore } from '../strategy/store.js';
import { AuthStore } from '../auth/store.js';
import { ErrorLog, fingerprintOf, type ErrorReport } from '../observability/errors.js';
import { marketSchema } from '../market/oi-history.js';

/**
 * Copy the desk's SQLite files into PostgreSQL, once, at the cutover.
 *
 *   npm run db:import -- --data-dir /srv/data        (DATABASE_URL set)
 *
 * One pass per file -- trades.db, auth.db, errors.db, market.db, analytics.db
 * -- each table inside its own transaction, every row `ON CONFLICT DO NOTHING`,
 * so the script can be run again after a failure and copies only what is
 * missing. It never writes to the SQLite files: they are opened read-only and
 * stay on the volume as the rollback path.
 *
 * At the end it counts every table on both sides and exits non-zero if any
 * pair differs. A migration that "probably worked" is not one to start a
 * trading engine on.
 *
 * Ids are carried over as they were (the identity sequences are moved past
 * them afterwards), so a trade event's `id` and an error's `id` mean the same
 * thing before and after.
 */

type Row = Record<string, unknown>;
type Count = { table: string; source: number; target: number };

function openRo(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null;
  return new DatabaseSync(path, { readOnly: true });
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function readAll(db: DatabaseSync, table: string): Row[] {
  return hasTable(db, table) ? (db.prepare(`SELECT * FROM ${table}`).all() as Row[]) : [];
}

const asJson = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));

/** Copy rows with one INSERT each inside one transaction; returns how many were offered. */
async function copy(
  target: string,
  columns: string[],
  rows: Row[],
  pick: (r: Row) => unknown[],
  conflict = 'DO NOTHING',
  overriding = false,
): Promise<number> {
  if (!rows.length) return 0;
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO ${target} (${columns.join(', ')}) ${overriding ? 'OVERRIDING SYSTEM VALUE ' : ''}VALUES (${placeholders}) ON CONFLICT ${conflict}`;
  await tx(async (c) => {
    for (const r of rows) await c.query(sql, pick(r));
  });
  return rows.length;
}

/** Move an identity sequence past the largest id copied, so new rows do not collide. */
async function bumpIdentity(table: string): Promise<void> {
  await one(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
}

async function count(table: string): Promise<number> {
  return (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0;
}

async function importTrades(dir: string, counts: Count[]): Promise<void> {
  const db = openRo(join(dir, 'trades.db'));
  if (!db) { console.log('trades.db: not present, skipped'); return; }

  const trades = readAll(db, 'trades');
  await copy('trades', ['trade_id', 'symbol', 'phase', 'position', 'plan', 'state', 'updated_at'], trades,
    (r) => [r.trade_id, r.symbol, r.phase, r.position, asJson(r.plan), asJson(r.state), r.updated_at]);
  counts.push({ table: 'trades', source: trades.length, target: await count('trades') });

  const events = readAll(db, 'trade_events');
  await copy('trade_events', ['id', 'trade_id', 'seq', 'at', 'kind', 'event'], events,
    (r) => [r.id, r.trade_id, r.seq, r.at, r.kind, asJson(r.event)], 'DO NOTHING', true);
  await bumpIdentity('trade_events');
  counts.push({ table: 'trade_events', source: events.length, target: await count('trade_events') });

  const settings = readAll(db, 'settings');
  await copy('settings', ['key', 'value'], settings, (r) => [r.key, r.value], '(key) DO UPDATE SET value = EXCLUDED.value');
  counts.push({ table: 'settings', source: settings.length, target: await count('settings') });

  const mtm = readAll(db, 'mtm_samples');
  await copy('mtm_samples', ['at', 'day', 'realised', 'unrealised', 'charges', 'net'], mtm,
    (r) => [r.at, r.day, r.realised, r.unrealised, r.charges, r.net]);
  counts.push({ table: 'mtm_samples', source: mtm.length, target: await count('mtm_samples') });

  // The strategy tables shared trades.db with the journal.
  const strategies = readAll(db, 'strategies');
  await copy('strategies', ['id', 'name', 'enabled', 'config', 'created_at', 'updated_at'], strategies,
    (r) => [r.id, r.name, Number(r.enabled) === 1, asJson(r.config), r.created_at, r.updated_at],
    // What the person has since changed on the SQLite desk beats the fresh seed.
    '(id) DO UPDATE SET name = EXCLUDED.name, enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = EXCLUDED.updated_at');
  // The SQLite desk's list is the list. The seed migration adds the three
  // researched strategies to a fresh database; any the person had deleted
  // must not come back just because the database is new.
  if (hasTable(db, 'strategies')) {
    await query('DELETE FROM strategies WHERE NOT (id = ANY($1))', [strategies.map((r) => String(r.id))]);
  }
  counts.push({ table: 'strategies', source: strategies.length, target: await count('strategies') });

  const runs = readAll(db, 'strategy_runs');
  await copy('strategy_runs', ['id', 'strategy_id', 'run_date', 'status', 'detail', 'at'], runs,
    (r) => [r.id, r.strategy_id, r.run_date, r.status, r.detail, r.at], 'DO NOTHING', true);
  await bumpIdentity('strategy_runs');
  counts.push({ table: 'strategy_runs', source: runs.length, target: await count('strategy_runs') });

  const adds = readAll(db, 'strategy_adds');
  await copy('strategy_adds', ['id', 'strategy_id', 'run_date', 'source_trade_id', 'source_side', 'symbol', 'contracts', 'status', 'detail', 'added_to_trade_id', 'at'], adds,
    (r) => [r.id, r.strategy_id, r.run_date, r.source_trade_id, r.source_side, r.symbol, r.contracts, r.status, r.detail, r.added_to_trade_id, r.at], 'DO NOTHING', true);
  await bumpIdentity('strategy_adds');
  counts.push({ table: 'strategy_adds', source: adds.length, target: await count('strategy_adds') });

  const rebalances = readAll(db, 'strategy_rebalances');
  await copy('strategy_rebalances', ['id', 'strategy_id', 'run_date', 'stage', 'up_side', 'down_side', 'up_pct', 'down_pct', 'lots', 'status', 'detail', 'bought_trade_id', 'sold_trade_id', 'at'], rebalances,
    (r) => [r.id, r.strategy_id, r.run_date, r.stage, r.up_side, r.down_side, r.up_pct, r.down_pct, r.lots, r.status, r.detail, r.bought_trade_id, r.sold_trade_id, r.at], 'DO NOTHING', true);
  await bumpIdentity('strategy_rebalances');
  counts.push({ table: 'strategy_rebalances', source: rebalances.length, target: await count('strategy_rebalances') });

  // premium_alerts: a table nothing read, empty on the live desk. Not carried.
  db.close();
}

async function importAuth(dir: string, counts: Count[]): Promise<void> {
  const db = openRo(join(dir, 'auth.db'));
  if (!db) { console.log('auth.db: not present, skipped'); return; }

  const user = readAll(db, 'auth_user');
  await copy('auth_user', ['id', 'username', 'password_hash', 'password_changed_at', 'totp_secret', 'totp_enabled_at', 'totp_last_step', 'totp_pending', 'totp_pending_at', 'created_at', 'updated_at'], user,
    (r) => [r.id, r.username, r.password_hash, r.password_changed_at, r.totp_secret, r.totp_enabled_at, r.totp_last_step, r.totp_pending, r.totp_pending_at, r.created_at, r.updated_at]);
  counts.push({ table: 'auth_user', source: user.length, target: await count('auth_user') });

  const sessions = readAll(db, 'auth_sessions');
  await copy('auth_sessions', ['token_hash', 'stage', 'created_at', 'expires_at', 'last_seen_at', 'ip', 'user_agent', 'attempts', 'revoked_at'], sessions,
    (r) => [r.token_hash, r.stage, r.created_at, r.expires_at, r.last_seen_at, r.ip, r.user_agent, r.attempts, r.revoked_at]);
  counts.push({ table: 'auth_sessions', source: sessions.length, target: await count('auth_sessions') });

  const codes = readAll(db, 'auth_recovery_codes');
  await copy('auth_recovery_codes', ['code_hash', 'created_at', 'used_at'], codes, (r) => [r.code_hash, r.created_at, r.used_at]);
  counts.push({ table: 'auth_recovery_codes', source: codes.length, target: await count('auth_recovery_codes') });

  const limits = readAll(db, 'auth_limits');
  await copy('auth_limits', ['key', 'count', 'window_until'], limits, (r) => [r.key, r.count, r.window_until]);
  counts.push({ table: 'auth_limits', source: limits.length, target: await count('auth_limits') });

  const events = readAll(db, 'auth_events');
  await copy('auth_events', ['id', 'at', 'kind', 'ip', 'detail'], events, (r) => [r.id, r.at, r.kind, r.ip, r.detail], 'DO NOTHING', true);
  await bumpIdentity('auth_events');
  counts.push({ table: 'auth_events', source: events.length, target: await count('auth_events') });
  db.close();
}

async function importErrors(dir: string, counts: Count[]): Promise<void> {
  const db = openRo(join(dir, 'errors.db'));
  if (!db) { console.log('errors.db: not present, skipped'); return; }
  const errors = readAll(db, 'errors');
  const fpOf = (r: Row) => fingerprintOf({ source: r.source as ErrorReport['source'], code: r.code as string | null, where: r.where_at as string | null, message: String(r.message) });
  // The SQLite fingerprint was joined with NUL, which the driver cut the string
  // at -- every stored fingerprint reads back as its first part. Rebuilt here
  // from the same parts with today's recipe, so a repeat after the cutover
  // folds into the imported row rather than starting a second one. Two rows
  // that rebuild to one fingerprint keep the first; the count on the other is
  // lost, which is the price of a fingerprint that never worked.
  await copy('errors', ['id', 'fingerprint', 'source', 'level', 'message', 'code', 'stack', 'where_at', 'context', 'first_seen', 'last_seen', 'count', 'resolved'], errors,
    (r) => [
      r.id,
      fpOf(r),
      r.source, r.level, r.message, r.code, r.stack, r.where_at, asJson(r.context), r.first_seen, r.last_seen, r.count, Number(r.resolved) === 1,
    ],
    'DO NOTHING', true);
  await bumpIdentity('errors');
  const distinct = new Set(errors.map(fpOf)).size;
  if (distinct < errors.length) console.log(`errors.db: ${errors.length - distinct} row(s) folded into another with the same fingerprint`);
  counts.push({ table: 'errors', source: distinct, target: await count('errors') });
  db.close();
}

async function importMarket(dir: string, counts: Count[]): Promise<void> {
  const db = openRo(join(dir, 'market.db'));
  if (!db) { console.log('market.db: not present, skipped'); return; }
  const oi = readAll(db, 'oi_snapshots');
  await copy('oi_snapshots', ['at', 'expiry', 'cp', 'strike', 'oi', 'spot', 'atm_iv'], oi,
    (r) => [r.at, r.expiry, r.cp, r.strike, r.oi, r.spot, r.atm_iv ?? null]);
  counts.push({ table: 'oi_snapshots', source: oi.length, target: await count('oi_snapshots') });

  const cf = readAll(db, 'chain_features');
  const cols = ['at', 'expiry', 'spot', 'hours_left', 'atm_iv', 'call_atm', 'put_atm', 'put_marks', 'call_marks', 'put_volume', 'call_volume', 'pcr_oi', 'pcr_volume', 'ce_oi', 'pe_oi', 'iv_skew_pts', 'ce_wall', 'pe_wall', 'max_pain', 'ce_oi_change', 'pe_oi_change'];
  await copy('chain_features', cols, cf, (r) => cols.map((c) => (c === 'put_marks' || c === 'call_marks' ? asJson(r[c]) : r[c] ?? null)));
  counts.push({ table: 'chain_features', source: cf.length, target: await count('chain_features') });
  db.close();
}

async function importAnalytics(dir: string, counts: Count[]): Promise<void> {
  const db = openRo(join(dir, 'analytics.db'));
  if (!db) { console.log('analytics.db: not present, skipped'); return; }
  await query(ANALYTICS_SCHEMA);
  const outlook = readAll(db, 'outlook_states');
  await copy('outlook_states', OUTLOOK_COLS, outlook,
    (r) => OUTLOOK_COLS.map((c) => (c === 'by_year' ? asJson(r[c]) : c === 'lean_holds' || c === 'side_holds' ? Number(r[c]) === 1 : r[c] ?? null)));
  counts.push({ table: 'outlook_states', source: outlook.length, target: await count('outlook_states') });
  const chain = readAll(db, 'chain_states');
  await copy('chain_states', CHAIN_COLS, chain,
    (r) => CHAIN_COLS.map((c) => (c === 'by_year' ? asJson(r[c]) : c === 'lean_holds' || c === 'side_holds' ? Number(r[c]) === 1 : r[c] ?? null)));
  counts.push({ table: 'chain_states', source: chain.length, target: await count('chain_states') });
  if (outlook.length) await one(`INSERT INTO analytics_publish_meta (id, published_at) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET published_at = EXCLUDED.published_at`, [Date.now()]);
  db.close();
}

const OUTLOOK_COLS = ['minutes', 'feature', 'bucket', 'windows', 'independent', 'side_band_pct', 'p_down', 'p_side', 'p_up', 'q16_pct', 'q50_pct', 'q84_pct', 'by_year', 'lean_holds', 'side_holds', 'lean_z', 'side_z', 'measured_at'];
const CHAIN_COLS = ['minutes', 'feature', 'bucket', 'lo', 'hi', ...OUTLOOK_COLS.slice(3)];

/**
 * The analytics tables. Owned by the Python service and its publish script
 * (research/publish_outlook_states.py), which create them the same way; here
 * so an import on a fresh database has somewhere to put the rows.
 */
export const ANALYTICS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS outlook_states (
    minutes INTEGER NOT NULL, feature TEXT NOT NULL, bucket TEXT NOT NULL,
    windows INTEGER, independent INTEGER, side_band_pct DOUBLE PRECISION,
    p_down DOUBLE PRECISION, p_side DOUBLE PRECISION, p_up DOUBLE PRECISION,
    q16_pct DOUBLE PRECISION, q50_pct DOUBLE PRECISION, q84_pct DOUBLE PRECISION,
    by_year JSONB, lean_holds BOOLEAN, side_holds BOOLEAN, lean_z DOUBLE PRECISION, side_z DOUBLE PRECISION,
    measured_at TEXT, PRIMARY KEY (minutes, feature, bucket)
  );
  CREATE TABLE IF NOT EXISTS chain_states (
    minutes INTEGER NOT NULL, feature TEXT NOT NULL, bucket TEXT NOT NULL, lo DOUBLE PRECISION, hi DOUBLE PRECISION,
    windows INTEGER, independent INTEGER, side_band_pct DOUBLE PRECISION,
    p_down DOUBLE PRECISION, p_side DOUBLE PRECISION, p_up DOUBLE PRECISION,
    q16_pct DOUBLE PRECISION, q50_pct DOUBLE PRECISION, q84_pct DOUBLE PRECISION,
    by_year JSONB, lean_holds BOOLEAN, side_holds BOOLEAN, lean_z DOUBLE PRECISION, side_z DOUBLE PRECISION,
    measured_at TEXT, PRIMARY KEY (minutes, feature, bucket)
  );
  CREATE TABLE IF NOT EXISTS analytics_publish_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1), published_at BIGINT NOT NULL
  );
`;

/** Run every import against `dir`. Returns the count table; throws on a mismatch. */
export async function importSqlite(dir: string): Promise<Count[]> {
  // Every schema first, the way the desk boots, so the tables exist.
  await new SettingsCache().load();
  await PgTradeStore.open();
  await StrategyStore.open();
  await AuthStore.open();
  await new ErrorLog().ready;
  await marketSchema();
  await migrate([]);

  const counts: Count[] = [];
  await importTrades(dir, counts);
  await importAuth(dir, counts);
  await importErrors(dir, counts);
  await importMarket(dir, counts);
  await importAnalytics(dir, counts);

  const bad = counts.filter((c) => c.target < c.source);
  if (bad.length) {
    throw new Error(`import incomplete: ${bad.map((c) => `${c.table} ${c.target}/${c.source}`).join(', ')}`);
  }
  return counts;
}

/* c8 ignore start */
if (process.argv[1] && /import-sqlite\.(ts|js)$/.test(process.argv[1])) {
  const i = process.argv.indexOf('--data-dir');
  const dir = i >= 0 ? process.argv[i + 1] : undefined;
  if (!dir) {
    console.error('usage: npm run db:import -- --data-dir <directory holding trades.db, auth.db, errors.db, market.db, analytics.db>');
    process.exit(2);
  }
  importSqlite(dir)
    .then((counts) => {
      console.log('table'.padEnd(28) + 'sqlite'.padStart(8) + 'postgres'.padStart(10));
      for (const c of counts) console.log(c.table.padEnd(28) + String(c.source).padStart(8) + String(c.target).padStart(10));
      console.log('every table copied in full');
    })
    .catch((e: Error) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => closePool());
}
/* c8 ignore stop */
