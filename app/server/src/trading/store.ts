import { DatabaseSync } from 'node:sqlite';
import { TRADE_DB } from '../paths.js';
import type { TradeRecord, TradeStore } from './engine.js';
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

  events(tradeId: string): TradeEvent[] {
    const rows = this.db
      .prepare('SELECT event FROM trade_events WHERE trade_id = ? ORDER BY seq')
      .all(tradeId) as { event: string }[];
    return rows.map((r) => JSON.parse(r.event) as TradeEvent);
  }

  /** Realised P&L booked today, in USD. Feeds the daily loss gate. */
  realisedSince(fromMs: number): number {
    const rows = this.db
      .prepare('SELECT state FROM trades WHERE updated_at >= ?')
      .all(fromMs) as { state: string }[];
    return rows.reduce((n, r) => n + ((JSON.parse(r.state) as TradeState).realisedPnl ?? 0), 0);
  }

  private query(sql: string, ...params: unknown[]): TradeRecord[] {
    const rows = this.db.prepare(sql).all(...(params as never[])) as
      { trade_id: string; plan: string; state: string }[];
    return rows.map((r) => this.hydrate(r.trade_id, r));
  }

  private hydrate(tradeId: string, row: { plan: string; state: string }): TradeRecord {
    return {
      state: JSON.parse(row.state) as TradeRecord['state'],
      plan: JSON.parse(row.plan) as TradeRecord['plan'],
      events: this.events(tradeId),
    };
  }
}
