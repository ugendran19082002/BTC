/**
 * Saved strategies and their run journal.
 *
 * Lives in `trades.db` beside the trade journal, because a strategy run is a
 * trading fact and splitting the two across databases means a restart can
 * recover one and not the other.
 *
 * The `strategy_runs` table is what stops a strategy entering twice. It is
 * written **before** the orders go out, not after: if the process dies between
 * the write and the fill, the day is marked spent and a human looks at it,
 * which is the safe direction. Marked-and-not-traded loses an opportunity;
 * traded-and-not-marked doubles a position.
 */
import { DatabaseSync } from 'node:sqlite';
import { TRADE_DB } from '../paths.js';
import { migrate, type Migration } from '../db/sqlite-migrate.js';
import {
  cleanRebalanceDefaults, cleanRebalanceLimits,
  type RebalanceLimits, type RebalanceRule,
} from './rebalance.js';
import { DEFAULT_CONFIG, defaultAddUntil, type Strategy, type StrategyConfig, type StrategyRun } from './types.js';

const MIGRATIONS: Migration[] = [
  {
    id: '004-strategies',
    up: `
      CREATE TABLE IF NOT EXISTS strategies (
        id         TEXT PRIMARY KEY,
        name       TEXT    NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 0,
        config     TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS strategy_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id TEXT    NOT NULL,
        run_date    TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        detail      TEXT    NOT NULL,
        at          INTEGER NOT NULL,
        UNIQUE (strategy_id, run_date)
      );
      CREATE INDEX IF NOT EXISTS strategy_runs_by_time ON strategy_runs (at DESC);
    `,
  },
  {
    /*
     * The three strategies the research ended on, seeded so the screen is not
     * empty on a fresh desk. Only the one the record favours is armed; the
     * other two are there to be read and compared, not to trade.
     *
     * INSERT OR IGNORE, so a desk that already has them keeps whatever the
     * person has since changed.
     */
    id: '005-seed-strategies',
    up: (db) => {
      const now = Date.now();
      const seed = (id: string, name: string, enabled: number, cfg: StrategyConfig) =>
        db.prepare(
          `INSERT OR IGNORE INTO strategies (id, name, enabled, config, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, name, enabled, JSON.stringify(cfg), now, now);

      seed('baseline', 'Baseline', 0, {
        ...DEFAULT_CONFIG, probGate: null, doubleWhenOneSided: false,
      });
      seed('locked', 'Locked (95% gate)', 0, {
        ...DEFAULT_CONFIG, probGate: 0.95, doubleWhenOneSided: false,
      });
      seed('double', 'Double one-sided', 1, {
        ...DEFAULT_CONFIG, probGate: 0.95, doubleWhenOneSided: true,
      });
    },
  },
  {
    /*
     * Every decision to add to the other leg, including the ones that did not.
     *
     * One row per piece of a target that was looked at: `contracts` is how many
     * bought-back contracts the row decided about. Their sum per source trade
     * is what has been dealt with, so a target that fills 200 and then 3 is two
     * rows, and a restart re-reads the sum instead of adding the 200 again.
     *
     * Written before the order goes out, like a day's claim: a row with no
     * order behind it loses an add; an order with no row can be sent twice.
     */
    id: '006-strategy-adds',
    up: `
      CREATE TABLE IF NOT EXISTS strategy_adds (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id     TEXT    NOT NULL,
        run_date        TEXT    NOT NULL,
        source_trade_id TEXT    NOT NULL,
        source_side     TEXT    NOT NULL,
        symbol          TEXT,
        contracts       INTEGER NOT NULL,
        status          TEXT    NOT NULL,
        detail          TEXT    NOT NULL,
        added_to_trade_id TEXT,
        at              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS strategy_adds_by_source ON strategy_adds (source_trade_id);
      CREATE INDEX IF NOT EXISTS strategy_adds_by_time ON strategy_adds (at DESC);
    `,
  },
  {
    /*
     * The latest time an add may be made, written into every saved strategy
     * that has the add switched on but was saved before the setting existed:
     * half an hour before its own exit, which is the rule it ran under until now.
     * A strategy with the add off is left alone; turning it on fills the time in.
     */
    id: '007-add-until',
    up: (db) => {
      const rows = db.prepare('SELECT id, config FROM strategies').all() as { id: string; config: string }[];
      const update = db.prepare('UPDATE strategies SET config = ? WHERE id = ?');
      for (const r of rows) {
        const cfg = withAddUntil(JSON.parse(r.config) as StrategyConfig);
        if (JSON.stringify(cfg) !== r.config) update.run(JSON.stringify(cfg), r.id);
      }
    },
  },
  {
    /*
     * Every rebalance stage, written down before it is acted on.
     *
     * `UNIQUE (strategy_id, run_date, stage)` is the rule that a stage can
     * never fire twice, enforced by the file rather than by a variable: two
     * ticks, a restart or two callers all meet the same constraint, and the
     * second one is refused by SQLite rather than by good intentions.
     */
    id: '009-strategy-rebalances',
    up: `
      CREATE TABLE IF NOT EXISTS strategy_rebalances (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id    TEXT    NOT NULL,
        run_date       TEXT    NOT NULL,
        stage          INTEGER NOT NULL,
        up_side        TEXT    NOT NULL,
        down_side      TEXT    NOT NULL,
        up_pct         REAL,
        down_pct       REAL,
        lots           INTEGER NOT NULL,
        status         TEXT    NOT NULL,
        detail         TEXT    NOT NULL,
        bought_trade_id TEXT,
        sold_trade_id  TEXT,
        at             INTEGER NOT NULL,
        UNIQUE (strategy_id, run_date, stage)
      );
      CREATE INDEX IF NOT EXISTS strategy_rebalances_by_time ON strategy_rebalances (at DESC);
    `,
  },
  {
    /*
     * Desk-wide settings for the strategy screens, in the `settings` table the
     * trade journal already keeps in this file. The rebalance defaults and the
     * limits a rule is held to live here, so "…n stages" is a number somebody
     * types rather than one written into the source.
     */
    id: '008-strategy-settings',
    up: `
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

/** A stored config with the add on but no latest-add time gets its default. */
function withAddUntil(cfg: StrategyConfig): StrategyConfig {
  const add = cfg.addToOpposite;
  if (!add || typeof add.addUntil === 'string') return cfg;
  return { ...cfg, addToOpposite: { ...add, addUntil: defaultAddUntil(cfg.exitTime ?? DEFAULT_CONFIG.exitTime) } };
}

export type AddStatus = 'placing' | 'placed' | 'skipped' | 'refused' | 'failed';

export type StrategyAdd = {
  id: number;
  strategyId: string;
  runDate: string;
  sourceTradeId: string;
  sourceSide: 'CE' | 'PE';
  /** The contract that was, or would have been, sold. Null when there was no other leg. */
  symbol: string | null;
  contracts: number;
  status: AddStatus;
  detail: string;
  /** The other leg's trade the contracts were appended to. */
  addedToTradeId: string | null;
  at: number;
};

type AddRow = {
  id: number; strategy_id: string; run_date: string; source_trade_id: string; source_side: 'CE' | 'PE';
  symbol: string | null; contracts: number; status: AddStatus; detail: string; added_to_trade_id: string | null; at: number;
};

const addFrom = (r: AddRow): StrategyAdd => ({
  id: r.id, strategyId: r.strategy_id, runDate: r.run_date, sourceTradeId: r.source_trade_id,
  sourceSide: r.source_side, symbol: r.symbol, contracts: r.contracts, status: r.status,
  detail: r.detail, addedToTradeId: r.added_to_trade_id, at: r.at,
});

export class StrategyStore {
  private readonly db: DatabaseSync;
  readonly applied: string[];

  constructor(path = TRADE_DB) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Two connections share this file -- the trade journal and the strategy
    // store -- so a write can meet the other's lock. Wait for it briefly rather
    // than fail with SQLITE_BUSY. Sync stays at SQLite's default FULL: this is
    // an order journal, and the last committed fill must survive a power cut.
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16000;');
    this.applied = migrate(this.db, MIGRATIONS);
  }

  private hydrate = (r: {
    id: string; name: string; enabled: number; config: string;
    created_at: number; updated_at: number;
  }): Strategy => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    // A config written by an older version may lack a field this one reads;
    // the defaults fill it rather than the screen showing undefined.
    config: withAddUntil({ ...DEFAULT_CONFIG, ...(JSON.parse(r.config) as StrategyConfig) }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  /** Stages already done today, and which side was sold at the first of them. */
  rebalanceState(strategyId: string, runDate: string): { stagesDone: number; lockedUpSide: 'CE' | 'PE' | null } {
    const rows = this.db.prepare(
      `SELECT stage, up_side, status FROM strategy_rebalances
       WHERE strategy_id = ? AND run_date = ? ORDER BY stage`,
    ).all(strategyId, runDate) as { stage: number; up_side: 'CE' | 'PE'; status: string }[];
    // A skipped stage counts as done: it was decided about, and deciding again
    // every minute is the loop this table exists to stop.
    const stagesDone = rows.length ? Math.max(...rows.map((r) => r.stage)) : 0;
    const first = rows.find((r) => r.status !== 'skipped');
    return { stagesDone, lockedUpSide: first?.up_side ?? null };
  }

  /**
   * Write the stage down before it is acted on.
   *
   * Null means this stage is already recorded -- by the tick before, or by the
   * process that died between the write and the order. Either way the answer is
   * the same: do not act.
   */
  recordRebalance(r: {
    strategyId: string; runDate: string; stage: number;
    upSide: 'CE' | 'PE'; downSide: 'CE' | 'PE'; upPct: number | null; downPct: number | null;
    lots: number; status: RebalanceStatus; detail: string; at?: number;
  }): StrategyRebalance | null {
    try {
      const res = this.db.prepare(
        `INSERT INTO strategy_rebalances
           (strategy_id, run_date, stage, up_side, down_side, up_pct, down_pct, lots, status, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.strategyId, r.runDate, r.stage, r.upSide, r.downSide, r.upPct, r.downPct,
        r.lots, r.status, r.detail.slice(0, 500), r.at ?? Date.now());
      return this.rebalance(Number(res.lastInsertRowid));
    } catch {
      // The unique constraint: this stage is already written down.
      return null;
    }
  }

  /** How it actually went, once the orders have been answered. */
  finishRebalance(id: number, status: RebalanceStatus, detail: string, ids?: { bought?: string; sold?: string }): void {
    this.db.prepare(
      `UPDATE strategy_rebalances
       SET status = ?, detail = ?, bought_trade_id = COALESCE(?, bought_trade_id), sold_trade_id = COALESCE(?, sold_trade_id)
       WHERE id = ?`,
    ).run(status, detail.slice(0, 500), ids?.bought ?? null, ids?.sold ?? null, id);
  }

  rebalance(id: number): StrategyRebalance | null {
    const r = this.db.prepare('SELECT * FROM strategy_rebalances WHERE id = ?').get(id) as never;
    return r ? hydrateRebalance(r) : null;
  }

  /** The day's rebalances, newest first, for the screen and the journal. */
  rebalances(limit = 100): StrategyRebalance[] {
    return (this.db.prepare('SELECT * FROM strategy_rebalances ORDER BY at DESC LIMIT ?').all(limit) as never[])
      .map(hydrateRebalance);
  }

  /** One desk-wide setting. Absent is null, never an invented default. */
  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  /**
   * The limits a rebalance rule is held to, and what a new rule starts as.
   *
   * Both are settings rather than constants: a desk that always runs five
   * stages at 40/25 should type that once, and a ceiling in the source is a
   * number standing between somebody and a trade they meant to make. The hard
   * ceilings behind them are in `rebalance.ts` and are not editable.
   */
  rebalanceLimits(): RebalanceLimits {
    try {
      return cleanRebalanceLimits(JSON.parse(this.getSetting('rebalance_limits') || 'null'));
    } catch {
      return cleanRebalanceLimits(null);
    }
  }

  setRebalanceLimits(patch: Partial<RebalanceLimits>): RebalanceLimits {
    const next = cleanRebalanceLimits({ ...this.rebalanceLimits(), ...patch });
    this.setSetting('rebalance_limits', JSON.stringify(next));
    return next;
  }

  rebalanceDefaults(): RebalanceRule {
    try {
      return cleanRebalanceDefaults(JSON.parse(this.getSetting('rebalance_defaults') || 'null'), this.rebalanceLimits());
    } catch {
      return cleanRebalanceDefaults(null, this.rebalanceLimits());
    }
  }

  setRebalanceDefaults(patch: Partial<RebalanceRule>): RebalanceRule {
    const next = cleanRebalanceDefaults({ ...this.rebalanceDefaults(), ...patch }, this.rebalanceLimits());
    this.setSetting('rebalance_defaults', JSON.stringify(next));
    return next;
  }

  all(): Strategy[] {
    return (this.db.prepare('SELECT * FROM strategies ORDER BY created_at').all() as never[])
      .map(this.hydrate);
  }

  get(id: string): Strategy | null {
    const r = this.db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
    return r ? this.hydrate(r as never) : null;
  }

  save(s: { id: string; name: string; enabled: boolean; config: StrategyConfig }): Strategy {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO strategies (id, name, enabled, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, enabled = excluded.enabled,
         config = excluded.config, updated_at = excluded.updated_at`,
    ).run(s.id, s.name, s.enabled ? 1 : 0, JSON.stringify(s.config), now, now);
    return this.get(s.id)!;
  }

  remove(id: string): void {
    // The runs stay. A deleted strategy's history is still what happened, and
    // the orders it placed are in the trade journal under their own ids.
    this.db.prepare('DELETE FROM strategies WHERE id = ?').run(id);
  }

  setEnabled(id: string, on: boolean): Strategy | null {
    if (!this.get(id)) return null;
    this.db.prepare('UPDATE strategies SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(on ? 1 : 0, Date.now(), id);
    return this.get(id);
  }

  /** The IST day this strategy last ran, or null. What stops a second entry. */
  lastRunDate(id: string): string | null {
    const r = this.db.prepare(
      'SELECT run_date FROM strategy_runs WHERE strategy_id = ? ORDER BY run_date DESC LIMIT 1',
    ).get(id) as { run_date: string } | undefined;
    return r?.run_date ?? null;
  }

  /**
   * Claim a day for a strategy.
   *
   * Returns false when the day is already claimed, and the UNIQUE constraint is
   * what makes that true rather than a check-then-write that two callers could
   * both pass. Claim first, trade second.
   */
  claim(strategyId: string, runDate: string, at = Date.now()): boolean {
    const res = this.db.prepare(
      `INSERT OR IGNORE INTO strategy_runs (strategy_id, run_date, status, detail, at)
       VALUES (?, ?, 'skipped', 'claimed, not yet run', ?)`,
    ).run(strategyId, runDate, at);
    return Number(res.changes) > 0;
  }

  /** Say how the claimed day actually went. */
  finish(strategyId: string, runDate: string, status: StrategyRun['status'], detail: string): void {
    this.db.prepare(
      'UPDATE strategy_runs SET status = ?, detail = ?, at = ? WHERE strategy_id = ? AND run_date = ?',
    ).run(status, detail.slice(0, 500), Date.now(), strategyId, runDate);
  }

  /** One strategy's row for one day, when there is one. */
  runFor(strategyId: string, runDate: string): StrategyRun | null {
    const r = this.db.prepare(
      'SELECT * FROM strategy_runs WHERE strategy_id = ? AND run_date = ?',
    ).get(strategyId, runDate) as {
      id: number; strategy_id: string; run_date: string;
      status: StrategyRun['status']; detail: string; at: number;
    } | undefined;
    return r ? {
      id: r.id, strategyId: r.strategy_id, runDate: r.run_date,
      status: r.status, detail: r.detail, at: r.at,
    } : null;
  }

  /** How many of this trade's bought-back contracts have already been decided about. */
  addedFor(sourceTradeId: string): number {
    const r = this.db.prepare(
      'SELECT COALESCE(SUM(contracts), 0) AS n FROM strategy_adds WHERE source_trade_id = ?',
    ).get(sourceTradeId) as { n: number };
    return Number(r.n);
  }

  /**
   * Write the decision down, before acting on it.
   *
   * Checked and written in one transaction against the contracts already dealt
   * with, so two callers deciding about the same piece cannot both get a row:
   * the second finds the sum already covers it and gets null.
   */
  recordAdd(a: {
    strategyId: string; runDate: string; sourceTradeId: string; sourceSide: 'CE' | 'PE';
    symbol: string | null; boughtBack: number; status: AddStatus; detail: string; at?: number;
  }): StrategyAdd | null {
    const at = a.at ?? Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const done = this.addedFor(a.sourceTradeId);
      const contracts = a.boughtBack - done;
      if (contracts <= 0) { this.db.exec('ROLLBACK'); return null; }
      const res = this.db.prepare(
        `INSERT INTO strategy_adds
           (strategy_id, run_date, source_trade_id, source_side, symbol, contracts, status, detail, added_to_trade_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(a.strategyId, a.runDate, a.sourceTradeId, a.sourceSide, a.symbol, contracts, a.status, a.detail.slice(0, 500), at);
      this.db.exec('COMMIT');
      return this.add(Number(res.lastInsertRowid));
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Say how an add that was being placed actually went. */
  finishAdd(id: number, status: AddStatus, detail: string, addedToTradeId: string | null = null): void {
    this.db.prepare('UPDATE strategy_adds SET status = ?, detail = ?, added_to_trade_id = ? WHERE id = ?')
      .run(status, detail.slice(0, 500), addedToTradeId, id);
  }

  add(id: number): StrategyAdd | null {
    const r = this.db.prepare('SELECT * FROM strategy_adds WHERE id = ?').get(id) as AddRow | undefined;
    return r ? addFrom(r) : null;
  }

  adds(limit = 60): StrategyAdd[] {
    return (this.db.prepare('SELECT * FROM strategy_adds ORDER BY at DESC, id DESC LIMIT ?').all(limit) as AddRow[])
      .map(addFrom);
  }

  runs(limit = 60): StrategyRun[] {
    return (this.db.prepare(
      'SELECT * FROM strategy_runs ORDER BY at DESC LIMIT ?',
    ).all(limit) as never[]).map((r: {
      id: number; strategy_id: string; run_date: string;
      status: StrategyRun['status']; detail: string; at: number;
    }) => ({
      id: r.id, strategyId: r.strategy_id, runDate: r.run_date,
      status: r.status, detail: r.detail, at: r.at,
    }));
  }
}


export type RebalanceStatus = 'placing' | 'done' | 'partial' | 'failed' | 'skipped';

/** One stage, as it was decided and as it went. */
export type StrategyRebalance = {
  id: number;
  strategyId: string;
  runDate: string;
  stage: number;
  upSide: 'CE' | 'PE';
  downSide: 'CE' | 'PE';
  upPct: number | null;
  downPct: number | null;
  lots: number;
  status: RebalanceStatus;
  detail: string;
  boughtTradeId: string | null;
  soldTradeId: string | null;
  at: number;
};

const hydrateRebalance = (r: {
  id: number; strategy_id: string; run_date: string; stage: number;
  up_side: 'CE' | 'PE'; down_side: 'CE' | 'PE'; up_pct: number | null; down_pct: number | null;
  lots: number; status: RebalanceStatus; detail: string;
  bought_trade_id: string | null; sold_trade_id: string | null; at: number;
}): StrategyRebalance => ({
  id: r.id, strategyId: r.strategy_id, runDate: r.run_date, stage: r.stage,
  upSide: r.up_side, downSide: r.down_side, upPct: r.up_pct, downPct: r.down_pct,
  lots: r.lots, status: r.status, detail: r.detail,
  boughtTradeId: r.bought_trade_id, soldTradeId: r.sold_trade_id, at: r.at,
});
