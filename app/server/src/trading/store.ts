import type { TradeRecord, TradeStore } from './engine.js';
import type { MtmSample } from './pnl-history.js';
import { migrate, moveToPublic, type Migration } from '../db/migrate.js';
import { query, rows, tx } from '../db/pool.js';
import { recompute } from './machine.js';
import type { TradeEvent, TradeState } from './types.js';

/**
 * The trade journal.
 *
 * Two tables and one rule: events are appended and never edited, and the state
 * row is a cache of replaying them. Market data is disposable and lives in the
 * `market` schema; an order history is not, so it has the `trading` schema.
 *
 * The journal is what makes a restart safe. The process can die between the
 * fill and the stop going on, and what comes back knows a position exists
 * before it talks to the exchange at all.
 */

/**
 * The journal's schema, as migrations.
 *
 * The `trading` schema and its `settings` table are `db/settings.ts`'s; this
 * list assumes they exist, which the boot order guarantees and `open()` checks.
 * `trading-003` is the shape the tables had when the desk moved to PostgreSQL;
 * anything that changes it afterwards is a new entry -- never an edit to this
 * one, which has already run on every database that exists.
 */
const MIGRATIONS: Migration[] = [
  {
    id: 'trading-003-trades',
    up: `
      CREATE TABLE IF NOT EXISTS trading.trades (
        trade_id   TEXT    PRIMARY KEY,
        symbol     TEXT    NOT NULL,
        phase      TEXT    NOT NULL,
        position   INTEGER NOT NULL,
        plan       JSONB   NOT NULL,
        state      JSONB   NOT NULL,
        updated_at BIGINT  NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trading.trade_events (
        id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        trade_id TEXT    NOT NULL REFERENCES trading.trades (trade_id) ON DELETE CASCADE,
        seq      INTEGER NOT NULL,
        at       BIGINT  NOT NULL,
        kind     TEXT    NOT NULL,
        event    JSONB   NOT NULL,
        UNIQUE (trade_id, seq)
      );
      CREATE INDEX IF NOT EXISTS trades_by_phase      ON trading.trades (phase);
      -- The orders screen filters on when a trade last changed.
      CREATE INDEX IF NOT EXISTS trades_by_updated_at ON trading.trades (updated_at DESC);
    `,
  },
  {
    /*
     * The day's P&L, once a minute, so the day can be drawn as a line.
     *
     * In the journal's schema rather than in `market` because it is about
     * money that was made and lost, and clearing a market table should not
     * take a month of P&L lines with it. Pruned at ninety days.
     */
    id: 'trading-004-mtm-samples',
    up: `
      CREATE TABLE IF NOT EXISTS trading.mtm_samples (
        at         BIGINT           PRIMARY KEY,
        day        TEXT             NOT NULL,
        realised   DOUBLE PRECISION NOT NULL,
        unrealised DOUBLE PRECISION NOT NULL,
        charges    DOUBLE PRECISION NOT NULL,
        net        DOUBLE PRECISION NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mtm_samples_by_day ON trading.mtm_samples (day, at);
    `,
  },  {
    /*
     * Every table in one schema, public, on the owner's request (19 Sep 2026):
     * one list in a console instead of seven. Names carry their area as a
     * prefix where a bare name would be ambiguous in one namespace.
     */
    id: 'trading-006-journal-to-public',
    up: moveToPublic([
      ['trading.trades', 'trades'],
      ['trading.trade_events', 'trade_events'],
      ['trading.mtm_samples', 'mtm_samples'],
    ], ['trading']),
  },
];

/** How long a day's line is kept. */
export const MTM_KEEP_DAYS = 90;

const OPEN_PHASES = "('precheck','entry_pending','entry_unknown','position_open','unprotected','protected','exit_pending')";

type Row = { trade_id: string; plan: TradeRecord['plan']; state: TradeState };

export class PgTradeStore implements TradeStore {
  /** Ids applied when the store was opened. For the health endpoint. */
  applied: string[] = [];

  /** The journal, migrated. Everything else assumes this has been awaited once. */
  static async open(): Promise<PgTradeStore> {
    const store = new PgTradeStore();
    store.applied = await migrate(MIGRATIONS);
    return store;
  }

  /**
   * The row and every event not yet written, in one transaction.
   *
   * Only what is new. An event already written is never rewritten, which is
   * what lets the journal be trusted as an audit trail; `UNIQUE (trade_id, seq)`
   * makes a double write impossible rather than merely unlikely.
   */
  async save(rec: TradeRecord): Promise<void> {
    const { state } = rec;
    await tx(async (c) => {
      await c.query(
        `INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (trade_id) DO UPDATE SET
           phase = EXCLUDED.phase, position = EXCLUDED.position,
           -- The plan changes: a stop moved, a target moved, an entry that fell
           -- back. Leaving it out of the update meant it was written once on
           -- insert and never again, so every later change was lost on the next
           -- read -- the exits moved on the exchange and reverted on the screen.
           plan = EXCLUDED.plan,
           state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
        [state.tradeId, state.symbol, state.phase, state.position, JSON.stringify(rec.plan), JSON.stringify(state), state.updatedAt],
      );
      const written = await c.query<{ n: number }>('SELECT COUNT(*) AS n FROM trade_events WHERE trade_id = $1', [state.tradeId]);
      for (let i = written.rows[0]!.n; i < rec.events.length; i++) {
        const e = rec.events[i]!;
        await c.query(
          `INSERT INTO trade_events (trade_id, seq, at, kind, event) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (trade_id, seq) DO NOTHING`,
          [state.tradeId, i, e.at, e.t, JSON.stringify(e)],
        );
      }
    });
  }

  async get(tradeId: string): Promise<TradeRecord | null> {
    const found = await this.query('SELECT trade_id, plan, state FROM trades WHERE trade_id = $1', [tradeId]);
    return found[0] ?? null;
  }

  all(): Promise<TradeRecord[]> {
    return this.query('SELECT trade_id, plan, state FROM trades ORDER BY updated_at DESC');
  }

  open(): Promise<TradeRecord[]> {
    return this.query(`SELECT trade_id, plan, state FROM trades WHERE phase IN ${OPEN_PHASES} ORDER BY updated_at DESC`);
  }

  /** Newest first, for the screen. */
  recent(limit = 50): Promise<TradeRecord[]> {
    return this.query('SELECT trade_id, plan, state FROM trades ORDER BY updated_at DESC LIMIT $1', [limit]);
  }

  /**
   * Every trade touched inside a window, newest first.
   *
   * Filtered on `updated_at` rather than on when it was opened, because a trade
   * opened last night and closed this morning is one you did today -- and it is
   * the closing that a day's list is about.
   */
  between(fromMs: number, toMs: number, limit = 500): Promise<TradeRecord[]> {
    return this.query(
      'SELECT trade_id, plan, state FROM trades WHERE updated_at >= $1 AND updated_at < $2 ORDER BY updated_at DESC LIMIT $3',
      [fromMs, toMs, limit],
    );
  }

  async events(tradeId: string): Promise<TradeEvent[]> {
    return (await rows<{ event: TradeEvent }>('SELECT event FROM trade_events WHERE trade_id = $1 ORDER BY seq', [tradeId]))
      .map((r) => r.event);
  }

  /**
   * Realised P&L booked today, in USD. Feeds the daily loss gate.
   *
   * Recomputed from the fills rather than summed from the stored field, for the
   * same reason hydrate does: a row written under a wrong calculation would
   * otherwise keep feeding the gate a wrong number.
   */
  async realisedSince(fromMs: number): Promise<number> {
    const found = await rows<{ state: TradeState }>('SELECT state FROM trades WHERE updated_at >= $1', [fromMs]);
    return found.reduce((n, r) => n + (recompute(r.state).realisedPnl ?? 0), 0);
  }

  /** One reading of the day. Ignored if a reading already sits at that millisecond. */
  async sampleMtm(m: MtmSample): Promise<void> {
    await query(
      `INSERT INTO mtm_samples (at, day, realised, unrealised, charges, net)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (at) DO NOTHING`,
      [m.at, m.day, m.realisedUsd, m.unrealisedUsd, m.chargesUsd, m.netUsd],
    );
  }

  /** The day's line, oldest first. */
  async mtmSamples(day: string): Promise<MtmSample[]> {
    const found = await rows<{ at: number; day: string; realised: number; unrealised: number; charges: number; net: number }>(
      'SELECT at, day, realised, unrealised, charges, net FROM mtm_samples WHERE day = $1 ORDER BY at',
      [day],
    );
    return found.map((r) => ({
      at: r.at, day: r.day, realisedUsd: r.realised, unrealisedUsd: r.unrealised, chargesUsd: r.charges, netUsd: r.net,
    }));
  }

  /** The days that have a line at all, newest first. */
  async mtmDays(limit = 120): Promise<string[]> {
    return (await rows<{ day: string }>('SELECT DISTINCT day FROM mtm_samples ORDER BY day DESC LIMIT $1', [limit])).map((r) => r.day);
  }

  /** Drop lines older than `keepDays`. Returns how many readings went. */
  async pruneMtm(nowMs: number, keepDays = MTM_KEEP_DAYS): Promise<number> {
    const r = await query('DELETE FROM mtm_samples WHERE at < $1', [nowMs - keepDays * 86_400_000]);
    return r.rowCount ?? 0;
  }

  /** Rows to records, with every trade's events fetched in one query rather than one per trade. */
  private async query(sql: string, params: readonly (string | number)[] = []): Promise<TradeRecord[]> {
    const found = await rows<Row>(sql, params);
    if (!found.length) return [];
    const events = await rows<{ trade_id: string; event: TradeEvent }>(
      'SELECT trade_id, event FROM trade_events WHERE trade_id = ANY($1) ORDER BY trade_id, seq',
      [found.map((r) => r.trade_id)],
    );
    const byTrade = new Map<string, TradeEvent[]>();
    for (const e of events) {
      const list = byTrade.get(e.trade_id);
      if (list) list.push(e.event); else byTrade.set(e.trade_id, [e.event]);
    }
    // The stored figures are a cache of the fills. Recomputing on the way out
    // means a corrected calculation fixes history rather than only the future.
    return found.map((r) => ({
      state: recompute(r.state),
      plan: r.plan,
      events: byTrade.get(r.trade_id) ?? [],
    }));
  }
}
