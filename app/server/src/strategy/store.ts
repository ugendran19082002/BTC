/**
 * Saved strategies and their run journal.
 *
 * The `strategy` schema, in the same database as the trade journal, because a
 * strategy run is a trading fact and splitting the two across databases means
 * a restart can recover one and not the other.
 *
 * The `strategy_runs` table is what stops a strategy entering twice. It is
 * written **before** the orders go out, not after: if the process dies between
 * the write and the fill, the day is marked spent and a human looks at it,
 * which is the safe direction. Marked-and-not-traded loses an opportunity;
 * traded-and-not-marked doubles a position.
 */
import { migrate, moveToPublic, type Migration } from '../db/migrate.js';
import { one, query, rows, tx } from '../db/pool.js';
import { settings as deskSettings, type Settings } from '../db/settings.js';
import {
  cleanRebalanceDefaults, cleanRebalanceLimits,
  type RebalanceLimits, type RebalanceRule,
} from './rebalance.js';
import { DEFAULT_CONFIG, defaultAddUntil, type Strategy, type StrategyConfig, type StrategyRun } from './types.js';

const MIGRATIONS: Migration[] = [
  {
    id: 'strategy-001-tables',
    up: `
      CREATE SCHEMA IF NOT EXISTS strategy;
      CREATE TABLE IF NOT EXISTS strategy.strategies (
        id         TEXT    PRIMARY KEY,
        name       TEXT    NOT NULL,
        enabled    BOOLEAN NOT NULL DEFAULT FALSE,
        config     JSONB   NOT NULL,
        created_at BIGINT  NOT NULL,
        updated_at BIGINT  NOT NULL
      );
      -- What stops a strategy entering twice: written BEFORE the orders go out.
      CREATE TABLE IF NOT EXISTS strategy.runs (
        id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        strategy_id TEXT   NOT NULL,
        run_date    TEXT   NOT NULL,
        status      TEXT   NOT NULL,
        detail      TEXT   NOT NULL,
        at          BIGINT NOT NULL,
        UNIQUE (strategy_id, run_date)
      );
      CREATE INDEX IF NOT EXISTS strategy_runs_by_time ON strategy.runs (at DESC);
      -- Every decision to add to the other leg, including the ones that did not.
      -- One row per piece of a target that was looked at: "contracts" is how many
      -- bought-back contracts the row decided about. Their sum per source trade
      -- is what has been dealt with, so a target that fills 200 and then 3 is two
      -- rows, and a restart re-reads the sum instead of adding the 200 again.
      CREATE TABLE IF NOT EXISTS strategy.adds (
        id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        strategy_id       TEXT    NOT NULL,
        run_date          TEXT    NOT NULL,
        source_trade_id   TEXT    NOT NULL,
        source_side       TEXT    NOT NULL,
        symbol            TEXT,
        contracts         INTEGER NOT NULL,
        status            TEXT    NOT NULL,
        detail            TEXT    NOT NULL,
        added_to_trade_id TEXT,
        at                BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS strategy_adds_by_source ON strategy.adds (source_trade_id);
      CREATE INDEX IF NOT EXISTS strategy_adds_by_time   ON strategy.adds (at DESC);
      -- Every rebalance stage, written down before it is acted on.
      -- UNIQUE (strategy_id, run_date, stage) is the rule that a stage can never
      -- fire twice, enforced by the database rather than by a variable.
      CREATE TABLE IF NOT EXISTS strategy.rebalances (
        id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        strategy_id     TEXT    NOT NULL,
        run_date        TEXT    NOT NULL,
        stage           INTEGER NOT NULL,
        up_side         TEXT    NOT NULL,
        down_side       TEXT    NOT NULL,
        up_pct          DOUBLE PRECISION,
        down_pct        DOUBLE PRECISION,
        lots            INTEGER NOT NULL,
        status          TEXT    NOT NULL,
        detail          TEXT    NOT NULL,
        bought_trade_id TEXT,
        sold_trade_id   TEXT,
        at              BIGINT  NOT NULL,
        UNIQUE (strategy_id, run_date, stage)
      );
      CREATE INDEX IF NOT EXISTS strategy_rebalances_by_time ON strategy.rebalances (at DESC);
    `,
  },
  {
    /*
     * The three strategies the research ended on, seeded so the screen is not
     * empty on a fresh desk. Only the one the record favours is armed; the
     * other two are there to be read and compared, not to trade.
     *
     * ON CONFLICT DO NOTHING, so a desk that already has them keeps whatever
     * the person has since changed.
     */
    id: 'strategy-002-seed',
    up: async (c) => {
      const now = Date.now();
      const seed = (id: string, name: string, enabled: boolean, cfg: StrategyConfig) =>
        c.query(
          `INSERT INTO strategy.strategies (id, name, enabled, config, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING`,
          [id, name, enabled, JSON.stringify(withAddUntil(cfg)), now],
        );
      await seed('baseline', 'Baseline', false, { ...DEFAULT_CONFIG, probGate: null, doubleWhenOneSided: false });
      await seed('locked', 'Locked (95% gate)', false, { ...DEFAULT_CONFIG, probGate: 0.95, doubleWhenOneSided: false });
      await seed('double', 'Double one-sided', true, { ...DEFAULT_CONFIG, probGate: 0.95, doubleWhenOneSided: true });
    },
  },  {
    /*
     * Every table in one schema, public, on the owner's request (19 Sep 2026):
     * one list in a console instead of seven. Names carry their area as a
     * prefix where a bare name would be ambiguous in one namespace.
     */
    id: 'strategy-003-to-public',
    up: moveToPublic([
      ['strategy.strategies', 'strategies'],
      ['strategy.runs', 'strategy_runs'],
      ['strategy.adds', 'strategy_adds'],
      ['strategy.rebalances', 'strategy_rebalances'],
    ], ['strategy']),
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

type StrategyRow = { id: string; name: string; enabled: boolean; config: StrategyConfig; created_at: number; updated_at: number };
type RunRow = { id: number; strategy_id: string; run_date: string; status: StrategyRun['status']; detail: string; at: number };

const runFrom = (r: RunRow): StrategyRun => ({
  id: r.id, strategyId: r.strategy_id, runDate: r.run_date, status: r.status, detail: r.detail, at: r.at,
});

export class StrategyStore {
  /** Ids applied when the store was opened. For the boot log. */
  applied: string[] = [];

  private constructor(private readonly settings: Settings) {}

  /**
   * The store, migrated. The desk-wide settings it reads (the rebalance
   * defaults and limits) are the process's one settings cache unless a test
   * hands it another.
   */
  static async open(settings?: Settings): Promise<StrategyStore> {
    const store = new StrategyStore(settings ?? await deskSettings().load());
    store.applied = await migrate(MIGRATIONS);
    return store;
  }

  private hydrate = (r: StrategyRow): Strategy => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    // A config written by an older version may lack a field this one reads;
    // the defaults fill it rather than the screen showing undefined.
    config: withAddUntil({ ...DEFAULT_CONFIG, ...r.config }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  /** Stages already done today, and which side was sold at the first of them. */
  async rebalanceState(strategyId: string, runDate: string): Promise<{ stagesDone: number; lockedUpSide: 'CE' | 'PE' | null }> {
    const found = await rows<{ stage: number; up_side: 'CE' | 'PE'; status: string }>(
      `SELECT stage, up_side, status FROM strategy_rebalances
       WHERE strategy_id = $1 AND run_date = $2 ORDER BY stage`,
      [strategyId, runDate],
    );
    // A skipped stage counts as done: it was decided about, and deciding again
    // every minute is the loop this table exists to stop.
    const stagesDone = found.length ? Math.max(...found.map((r) => r.stage)) : 0;
    const first = found.find((r) => r.status !== 'skipped');
    return { stagesDone, lockedUpSide: first?.up_side ?? null };
  }

  /**
   * Write the stage down before it is acted on.
   *
   * Null means this stage is already recorded -- by the tick before, or by the
   * process that died between the write and the order. Either way the answer is
   * the same: do not act.
   */
  async recordRebalance(r: {
    strategyId: string; runDate: string; stage: number;
    upSide: 'CE' | 'PE'; downSide: 'CE' | 'PE'; upPct: number | null; downPct: number | null;
    lots: number; status: RebalanceStatus; detail: string; at?: number;
  }): Promise<StrategyRebalance | null> {
    // The unique constraint answers: no row back means this stage is already written down.
    const ins = await one<{ id: number }>(
      `INSERT INTO strategy_rebalances
         (strategy_id, run_date, stage, up_side, down_side, up_pct, down_pct, lots, status, detail, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (strategy_id, run_date, stage) DO NOTHING
       RETURNING id`,
      [r.strategyId, r.runDate, r.stage, r.upSide, r.downSide, r.upPct, r.downPct,
        r.lots, r.status, r.detail.slice(0, 500), r.at ?? Date.now()],
    );
    return ins ? this.rebalance(ins.id) : null;
  }

  /** How it actually went, once the orders have been answered. */
  async finishRebalance(id: number, status: RebalanceStatus, detail: string, ids?: { bought?: string; sold?: string }): Promise<void> {
    await query(
      `UPDATE strategy_rebalances
       SET status = $1, detail = $2, bought_trade_id = COALESCE($3, bought_trade_id), sold_trade_id = COALESCE($4, sold_trade_id)
       WHERE id = $5`,
      [status, detail.slice(0, 500), ids?.bought ?? null, ids?.sold ?? null, id],
    );
  }

  async rebalance(id: number): Promise<StrategyRebalance | null> {
    const r = await one('SELECT * FROM strategy_rebalances WHERE id = $1', [id]);
    return r ? hydrateRebalance(r as never) : null;
  }

  /** The day's rebalances, newest first, for the screen and the journal. */
  async rebalances(limit = 100): Promise<StrategyRebalance[]> {
    return (await rows('SELECT * FROM strategy_rebalances ORDER BY at DESC LIMIT $1', [limit])).map((r) => hydrateRebalance(r as never));
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
      return cleanRebalanceLimits(JSON.parse(this.settings.get('rebalance_limits') || 'null'));
    } catch {
      return cleanRebalanceLimits(null);
    }
  }

  async setRebalanceLimits(patch: Partial<RebalanceLimits>): Promise<RebalanceLimits> {
    const next = cleanRebalanceLimits({ ...this.rebalanceLimits(), ...patch });
    await this.settings.set('rebalance_limits', JSON.stringify(next));
    return next;
  }

  rebalanceDefaults(): RebalanceRule {
    try {
      return cleanRebalanceDefaults(JSON.parse(this.settings.get('rebalance_defaults') || 'null'), this.rebalanceLimits());
    } catch {
      return cleanRebalanceDefaults(null, this.rebalanceLimits());
    }
  }

  async setRebalanceDefaults(patch: Partial<RebalanceRule>): Promise<RebalanceRule> {
    const next = cleanRebalanceDefaults({ ...this.rebalanceDefaults(), ...patch }, this.rebalanceLimits());
    await this.settings.set('rebalance_defaults', JSON.stringify(next));
    return next;
  }

  async all(): Promise<Strategy[]> {
    return (await rows<StrategyRow>('SELECT * FROM strategies ORDER BY created_at, id')).map(this.hydrate);
  }

  async get(id: string): Promise<Strategy | null> {
    const r = await one<StrategyRow>('SELECT * FROM strategies WHERE id = $1', [id]);
    return r ? this.hydrate(r) : null;
  }

  async save(s: { id: string; name: string; enabled: boolean; config: StrategyConfig }): Promise<Strategy> {
    const now = Date.now();
    await query(
      `INSERT INTO strategies (id, name, enabled, config, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, enabled = EXCLUDED.enabled,
         config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`,
      [s.id, s.name, s.enabled, JSON.stringify(s.config), now],
    );
    return (await this.get(s.id))!;
  }

  async remove(id: string): Promise<void> {
    // The runs stay. A deleted strategy's history is still what happened, and
    // the orders it placed are in the trade journal under their own ids.
    await query('DELETE FROM strategies WHERE id = $1', [id]);
  }

  async setEnabled(id: string, on: boolean): Promise<Strategy | null> {
    const r = await query('UPDATE strategies SET enabled = $1, updated_at = $2 WHERE id = $3', [on, Date.now(), id]);
    return (r.rowCount ?? 0) > 0 ? this.get(id) : null;
  }

  /** The IST day this strategy last ran, or null. What stops a second entry. */
  async lastRunDate(id: string): Promise<string | null> {
    const r = await one<{ run_date: string }>(
      'SELECT run_date FROM strategy_runs WHERE strategy_id = $1 ORDER BY run_date DESC LIMIT 1',
      [id],
    );
    return r?.run_date ?? null;
  }

  /**
   * Claim a day for a strategy.
   *
   * Returns false when the day is already claimed, and the UNIQUE constraint is
   * what makes that true rather than a check-then-write that two callers could
   * both pass. Claim first, trade second.
   */
  async claim(strategyId: string, runDate: string, at = Date.now()): Promise<boolean> {
    const r = await query(
      `INSERT INTO strategy_runs (strategy_id, run_date, status, detail, at)
       VALUES ($1, $2, 'skipped', 'claimed, not yet run', $3)
       ON CONFLICT (strategy_id, run_date) DO NOTHING`,
      [strategyId, runDate, at],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Say how the claimed day actually went. */
  async finish(strategyId: string, runDate: string, status: StrategyRun['status'], detail: string): Promise<void> {
    await query(
      'UPDATE strategy_runs SET status = $1, detail = $2, at = $3 WHERE strategy_id = $4 AND run_date = $5',
      [status, detail.slice(0, 500), Date.now(), strategyId, runDate],
    );
  }

  /** One strategy's row for one day, when there is one. */
  async runFor(strategyId: string, runDate: string): Promise<StrategyRun | null> {
    const r = await one<RunRow>('SELECT * FROM strategy_runs WHERE strategy_id = $1 AND run_date = $2', [strategyId, runDate]);
    return r ? runFrom(r) : null;
  }

  /** How many of this trade's bought-back contracts have already been decided about. */
  async addedFor(sourceTradeId: string): Promise<number> {
    const r = await one<{ n: number }>(
      'SELECT COALESCE(SUM(contracts), 0)::bigint AS n FROM strategy_adds WHERE source_trade_id = $1',
      [sourceTradeId],
    );
    return r?.n ?? 0;
  }

  /**
   * Write the decision down, before acting on it.
   *
   * Checked and written in one transaction against the contracts already dealt
   * with, so two callers deciding about the same piece cannot both get a row:
   * the second finds the sum already covers it and gets null. The transaction
   * takes a lock keyed on the source trade first -- SQLite serialised writers
   * for free; PostgreSQL has to be asked, or two READ COMMITTED transactions
   * would each read the old sum and both insert.
   */
  async recordAdd(a: {
    strategyId: string; runDate: string; sourceTradeId: string; sourceSide: 'CE' | 'PE';
    symbol: string | null; boughtBack: number; status: AddStatus; detail: string; at?: number;
  }): Promise<StrategyAdd | null> {
    const at = a.at ?? Date.now();
    const id = await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`strategy_adds:${a.sourceTradeId}`]);
      const done = await c.query<{ n: number }>(
        'SELECT COALESCE(SUM(contracts), 0)::bigint AS n FROM strategy_adds WHERE source_trade_id = $1',
        [a.sourceTradeId],
      );
      const contracts = a.boughtBack - done.rows[0]!.n;
      if (contracts <= 0) return null;
      const ins = await c.query<{ id: number }>(
        `INSERT INTO strategy_adds
           (strategy_id, run_date, source_trade_id, source_side, symbol, contracts, status, detail, added_to_trade_id, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9) RETURNING id`,
        [a.strategyId, a.runDate, a.sourceTradeId, a.sourceSide, a.symbol, contracts, a.status, a.detail.slice(0, 500), at],
      );
      return ins.rows[0]!.id;
    });
    return id === null ? null : this.add(id);
  }

  /** Say how an add that was being placed actually went. */
  async finishAdd(id: number, status: AddStatus, detail: string, addedToTradeId: string | null = null): Promise<void> {
    await query('UPDATE strategy_adds SET status = $1, detail = $2, added_to_trade_id = $3 WHERE id = $4',
      [status, detail.slice(0, 500), addedToTradeId, id]);
  }

  async add(id: number): Promise<StrategyAdd | null> {
    const r = await one<AddRow>('SELECT * FROM strategy_adds WHERE id = $1', [id]);
    return r ? addFrom(r) : null;
  }

  async adds(limit = 60): Promise<StrategyAdd[]> {
    return (await rows<AddRow>('SELECT * FROM strategy_adds ORDER BY at DESC, id DESC LIMIT $1', [limit])).map(addFrom);
  }

  async runs(limit = 60): Promise<StrategyRun[]> {
    return (await rows<RunRow>('SELECT * FROM strategy_runs ORDER BY at DESC LIMIT $1', [limit])).map(runFrom);
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
