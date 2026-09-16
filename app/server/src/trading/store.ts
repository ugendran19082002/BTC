import { DatabaseSync } from 'node:sqlite';
import { TRADE_DB } from '../paths.js';
import type { TradeRecord, TradeStore } from './engine.js';
import type { MtmSample } from './pnl-history.js';
import { appliedMigrations, migrate, type Migration } from '../db/migrate.js';
import { recompute } from './machine.js';
import type { TradeEvent, TradeState } from './types.js';

/**
 * The trade journal.
 *
 * Two tables and one rule: events are appended and never edited, and the state
 * row is a cache of replaying them. Market data is disposable and lives in
 * chain.db; an order history is not, so it gets its own file.
 *
 * The journal is what makes a restart safe. The process can die between the
 * fill and the stop going on, and what comes back knows a position exists
 * before it talks to the exchange at all.
 */

/**
 * The journal's schema, as migrations.
 *
 * 001 is the shape the table had when it shipped. Anything that changes it
 * afterwards is a new entry -- never an edit to this one, which has already run
 * on every database that exists.
 */
const MIGRATIONS: Migration[] = [
  {
    id: '001-trades',
    up: `
      CREATE TABLE IF NOT EXISTS trades (
        trade_id   TEXT PRIMARY KEY,
        symbol     TEXT NOT NULL,
        phase      TEXT NOT NULL,
        position   INTEGER NOT NULL,
        plan       TEXT NOT NULL,
        state      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trade_events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT NOT NULL,
        seq      INTEGER NOT NULL,
        at       INTEGER NOT NULL,
        kind     TEXT NOT NULL,
        event    TEXT NOT NULL,
        UNIQUE (trade_id, seq)
      );
      CREATE INDEX IF NOT EXISTS trade_events_by_trade ON trade_events (trade_id, seq);
      CREATE INDEX IF NOT EXISTS trades_by_phase ON trades (phase);
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // The orders screen filters on when a trade last changed, and did it with
    // a scan.
    id: '002-trades-by-updated-at',
    up: 'CREATE INDEX IF NOT EXISTS trades_by_updated_at ON trades (updated_at DESC);',
  },
  {
    // The desk defaults to the first listed expiry (nearest active contract)
    // rather than the next-entry contract.  Persisted so the choice survives
    // a restart and can be changed through /api/settings.
    id: '003-default-settings',
    up: `INSERT OR IGNORE INTO settings (key, value) VALUES ('expiry_default', 'first');`,
  },
  {
    /*
     * The day's P&L, once a minute, so the day can be drawn as a line.
     *
     * 008, not 004: the strategy store shares this file and its ledger, and
     * 004-007 are its. One ledger per database, so one sequence.
     *
     * In the journal's file rather than in market.db because it is about
     * money that was made and lost, and a deploy that replaced a market file
     * should not take a month of P&L lines with it. Pruned at ninety days.
     */
    id: '008-mtm-samples',
    up: `
      CREATE TABLE IF NOT EXISTS mtm_samples (
        at         INTEGER PRIMARY KEY,
        day        TEXT    NOT NULL,
        realised   REAL    NOT NULL,
        unrealised REAL    NOT NULL,
        charges    REAL    NOT NULL,
        net        REAL    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mtm_samples_by_day ON mtm_samples (day, at);
    `,
  },
  {
    /*
     * "Tell me when this strike pays 5." A one-shot premium alert on a
     * contract: set from the best-trade card, checked against the live bid on
     * every strategy tick, sent once over Telegram, then kept as a record of
     * having fired. Rows outlive the contract they name so the journal can say
     * an alert was set and what became of it; the checker skips anything
     * already fired or past its expiry.
     */
    id: '009-premium-alerts',
    up: `
      CREATE TABLE IF NOT EXISTS premium_alerts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol     TEXT    NOT NULL,
        threshold  REAL    NOT NULL,
        expiry_ts  INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        fired_at   INTEGER,
        fired_bid  REAL
      );
      CREATE INDEX IF NOT EXISTS premium_alerts_live ON premium_alerts (fired_at) WHERE fired_at IS NULL;
    `,
  },
];

export type PremiumAlert = {
  id: number;
  /** The contract, e.g. C-BTC-80000-160926. */
  symbol: string;
  /** Fires when the bid reaches this, in dollars per BTC. */
  threshold: number;
  /** Epoch seconds. Past this the alert is dead whatever the bid does. */
  expiryTs: number;
  createdAt: number;
  firedAt: number | null;
  firedBid: number | null;
};

/** How long a day's line is kept. */
export const MTM_KEEP_DAYS = 90;

const OPEN_PHASES = "('precheck','entry_pending','entry_unknown','position_open','unprotected','protected','exit_pending')";

export class SqliteTradeStore implements TradeStore {
  private db: DatabaseSync;

  constructor(path = TRADE_DB) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    // Two connections share this file -- the trade journal and the strategy
    // store -- so a write can meet the other's lock. Wait for it briefly rather
    // than fail with SQLITE_BUSY. Sync stays at SQLite's default FULL: this is
    // an order journal, and the last committed fill must survive a power cut.
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16000;');
    migrate(this.db, MIGRATIONS);
  }

  /** What this database has had applied. For the health endpoint. */
  migrations() { return appliedMigrations(this.db); }

  save(rec: TradeRecord): void {
    const { state } = rec;
    this.db
      .prepare(
        `INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trade_id) DO UPDATE SET
           phase = excluded.phase, position = excluded.position,
           -- The plan changes: a stop moved, a target moved, an entry that fell
           -- back. Leaving it out of the update meant it was written once on
           -- insert and never again, so every later change was lost on the next
           -- read -- the exits moved on the exchange and reverted on the screen.
           plan = excluded.plan,
           state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(
        state.tradeId, state.symbol, state.phase, state.position,
        JSON.stringify(rec.plan), JSON.stringify(state), state.updatedAt,
      );

    // Only what is new. An event already written is never rewritten, which is
    // what lets the journal be trusted as an audit trail.
    const written = this.db
      .prepare('SELECT COUNT(*) AS n FROM trade_events WHERE trade_id = ?')
      .get(state.tradeId) as { n: number };
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO trade_events (trade_id, seq, at, kind, event) VALUES (?, ?, ?, ?, ?)',
    );
    for (let i = written.n; i < rec.events.length; i++) {
      const e = rec.events[i]!;
      insert.run(state.tradeId, i, e.at, e.t, JSON.stringify(e));
    }
  }

  get(tradeId: string): TradeRecord | null {
    const row = this.db
      .prepare('SELECT plan, state FROM trades WHERE trade_id = ?')
      .get(tradeId) as { plan: string; state: string } | undefined;
    return row ? this.hydrate(tradeId, row) : null;
  }

  all(): TradeRecord[] { return this.query('SELECT trade_id, plan, state FROM trades ORDER BY updated_at DESC'); }

  open(): TradeRecord[] {
    return this.query(
      `SELECT trade_id, plan, state FROM trades WHERE phase IN ${OPEN_PHASES} ORDER BY updated_at DESC`,
    );
  }

  /** Newest first, for the screen. */
  recent(limit = 50): TradeRecord[] {
    return this.query('SELECT trade_id, plan, state FROM trades ORDER BY updated_at DESC LIMIT ?', limit);
  }

  /**
   * Every trade touched inside a window, newest first.
   *
   * Filtered on `updated_at` rather than on when it was opened, because a trade
   * opened last night and closed this morning is one you did today -- and it is
   * the closing that a day's list is about.
   */
  between(fromMs: number, toMs: number, limit = 500): TradeRecord[] {
    return this.query(
      'SELECT trade_id, plan, state FROM trades WHERE updated_at >= ? AND updated_at < ? ' +
        'ORDER BY updated_at DESC LIMIT ?',
      fromMs, toMs, limit,
    );
  }

  /** Desk settings that must outlive a restart. Currently just the mode. */
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  events(tradeId: string): TradeEvent[] {
    const rows = this.db
      .prepare('SELECT event FROM trade_events WHERE trade_id = ? ORDER BY seq')
      .all(tradeId) as { event: string }[];
    return rows.map((r) => JSON.parse(r.event) as TradeEvent);
  }

  /**
   * Realised P&L booked today, in USD. Feeds the daily loss gate.
   *
   * Recomputed from the fills rather than summed from the stored field, for the
   * same reason hydrate does: a row written under a wrong calculation would
   * otherwise keep feeding the gate a wrong number.
   */
  realisedSince(fromMs: number): number {
    const rows = this.db
      .prepare('SELECT state FROM trades WHERE updated_at >= ?')
      .all(fromMs) as { state: string }[];
    return rows.reduce(
      (n, r) => n + (recompute(JSON.parse(r.state) as TradeState).realisedPnl ?? 0),
      0,
    );
  }

  /** One reading of the day. Ignored if a reading already sits at that millisecond. */
  sampleMtm(m: MtmSample): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO mtm_samples (at, day, realised, unrealised, charges, net)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(m.at, m.day, m.realisedUsd, m.unrealisedUsd, m.chargesUsd, m.netUsd);
  }

  /** The day's line, oldest first. */
  mtmSamples(day: string): MtmSample[] {
    const rows = this.db.prepare(
      'SELECT at, day, realised, unrealised, charges, net FROM mtm_samples WHERE day = ? ORDER BY at',
    ).all(day) as { at: number; day: string; realised: number; unrealised: number; charges: number; net: number }[];
    return rows.map((r) => ({
      at: r.at, day: r.day, realisedUsd: r.realised, unrealisedUsd: r.unrealised, chargesUsd: r.charges, netUsd: r.net,
    }));
  }

  /** The days that have a line at all, newest first. */
  mtmDays(limit = 120): string[] {
    return (this.db.prepare('SELECT DISTINCT day FROM mtm_samples ORDER BY day DESC LIMIT ?').all(limit) as { day: string }[])
      .map((r) => r.day);
  }

  /** Drop lines older than `keepDays`. Returns how many readings went. */
  pruneMtm(nowMs: number, keepDays = MTM_KEEP_DAYS): number {
    const r = this.db.prepare('DELETE FROM mtm_samples WHERE at < ?').run(nowMs - keepDays * 86_400_000);
    return Number(r.changes);
  }

  // ------------------------------------------------------- premium alerts

  addPremiumAlert(a: { symbol: string; threshold: number; expiryTs: number; now: number }): PremiumAlert {
    const r = this.db.prepare(
      'INSERT INTO premium_alerts (symbol, threshold, expiry_ts, created_at) VALUES (?, ?, ?, ?)',
    ).run(a.symbol, a.threshold, a.expiryTs, a.now);
    return this.premiumAlert(Number(r.lastInsertRowid))!;
  }

  premiumAlert(id: number): PremiumAlert | null {
    const r = this.db.prepare('SELECT * FROM premium_alerts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? rowToAlert(r) : null;
  }

  /** Alerts that have not fired, newest first. Includes expired ones; the checker decides. */
  livePremiumAlerts(): PremiumAlert[] {
    return (this.db.prepare('SELECT * FROM premium_alerts WHERE fired_at IS NULL ORDER BY created_at DESC').all() as Record<string, unknown>[])
      .map(rowToAlert);
  }

  /** Everything set in the last while, fired or not, newest first. */
  recentPremiumAlerts(sinceMs: number): PremiumAlert[] {
    return (this.db.prepare('SELECT * FROM premium_alerts WHERE created_at >= ? ORDER BY created_at DESC').all(sinceMs) as Record<string, unknown>[])
      .map(rowToAlert);
  }

  /** Mark it fired. Returns false if it already had -- the guard against sending twice. */
  firePremiumAlert(id: number, at: number, bid: number): boolean {
    const r = this.db.prepare('UPDATE premium_alerts SET fired_at = ?, fired_bid = ? WHERE id = ? AND fired_at IS NULL').run(at, bid, id);
    return Number(r.changes) === 1;
  }

  deletePremiumAlert(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM premium_alerts WHERE id = ?').run(id).changes) === 1;
  }

  private query(sql: string, ...params: unknown[]): TradeRecord[] {
    const rows = this.db.prepare(sql).all(...(params as never[])) as
      { trade_id: string; plan: string; state: string }[];
    return rows.map((r) => this.hydrate(r.trade_id, r));
  }

  private hydrate(tradeId: string, row: { plan: string; state: string }): TradeRecord {
    // The stored figures are a cache of the fills. Recomputing on the way out
    // means a corrected calculation fixes history rather than only the future.
    return {
      state: recompute(JSON.parse(row.state) as TradeRecord['state']),
      plan: JSON.parse(row.plan) as TradeRecord['plan'],
      events: this.events(tradeId),
    };
  }
}

function rowToAlert(r: Record<string, unknown>): PremiumAlert {
  return {
    id: Number(r.id),
    symbol: String(r.symbol),
    threshold: Number(r.threshold),
    expiryTs: Number(r.expiry_ts),
    createdAt: Number(r.created_at),
    firedAt: r.fired_at === null || r.fired_at === undefined ? null : Number(r.fired_at),
    firedBid: r.fired_bid === null || r.fired_bid === undefined ? null : Number(r.fired_bid),
  };
}

