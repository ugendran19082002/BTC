import { DatabaseSync } from 'node:sqlite';
import { TRADE_DB } from '../paths.js';
import type { TradeRecord, TradeStore } from './engine.js';
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

const SCHEMA = `
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
`;

const OPEN_PHASES = "('precheck','entry_pending','entry_unknown','position_open','unprotected','protected','exit_pending')";

export class SqliteTradeStore implements TradeStore {
  private db: DatabaseSync;

  constructor(path = TRADE_DB) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

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
