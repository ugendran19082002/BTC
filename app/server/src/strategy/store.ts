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
import { DEFAULT_CONFIG, type Strategy, type StrategyConfig, type StrategyRun } from './types.js';

/**
 * Settings a strategy no longer has (retired 22 Sep 2026): the safety gate,
 * doubling, the sell-score bar, the sudden-move limit, adding to the other leg
 * and the rebalance. Stripped from every saved config by `strategy-004`, and
 * from anything read back before that has run.
 */
export const RETIRED_KEYS = [
  'probGate', 'doubleWhenOneSided', 'minSellScore', 'maxShockScore', 'addToOpposite', 'rebalance',
] as const;

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
      // Shipped: the rows it writes must not change, so the retired keys are
      // still written here and `strategy-004` removes them after.
      const seed = (id: string, name: string, enabled: boolean, cfg: Record<string, unknown>) =>
        c.query(
          `INSERT INTO strategy.strategies (id, name, enabled, config, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING`,
          [id, name, enabled, JSON.stringify(cfg), now],
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
  {
    /*
     * The strategy form's Extras retired, on the owner's request (22 Sep 2026):
     * the safety gate, doubling, the sell-score bar, the sudden-move limit,
     * adding to the other leg and the rebalance.
     *
     * Their keys go from every saved config, so a strategy reads back as what
     * it now does. Their history does NOT go: `strategy_adds` and
     * `strategy_rebalances` stay, unread and unwritten, marked as retired. A
     * drop is irreversible and can be its own migration once nobody needs to
     * look back at them -- remove first, delete later.
     */
    id: 'strategy-004-retire-extras',
    up: `
      UPDATE strategies SET config = config - 'probGate' - 'doubleWhenOneSided' - 'minSellScore' - 'maxShockScore' - 'addToOpposite' - 'rebalance';
      DO $$ BEGIN
        IF to_regclass('public.settings') IS NOT NULL THEN
          DELETE FROM settings WHERE key IN ('rebalance_limits', 'rebalance_defaults');
        END IF;
      END $$;
      COMMENT ON TABLE strategy_adds IS 'Retired 22 Sep 2026 with add-to-the-other-leg. History only: nothing reads or writes it.';
      COMMENT ON TABLE strategy_rebalances IS 'Retired 22 Sep 2026 with the rebalance. History only: nothing reads or writes it.';
    `,
  },
  {
    /*
     * "Delete later" is now (23 Sep 2026): the desk keeps no table nothing
     * reads. `strategy-004` retired the two features and deliberately left
     * their tables standing, because a drop is irreversible and belongs in a
     * step of its own that somebody chooses to run. This is that step, and it
     * takes 25 columns of retired history with it.
     *
     * There is no other copy of those rows. `deploy/backup-db.sh` before the
     * deploy that runs this is the whole of the safety net.
     */
    id: 'strategy-005-drop-retired-tables',
    up: `
      DROP TABLE IF EXISTS strategy_adds;
      DROP TABLE IF EXISTS strategy_rebalances;
    `,
  },
];

/** A config without the settings the desk no longer has. */
function withoutRetired(cfg: StrategyConfig): StrategyConfig {
  const out = { ...cfg } as Record<string, unknown>;
  for (const k of RETIRED_KEYS) delete out[k];
  return out as StrategyConfig;
}

type StrategyRow = { id: string; name: string; enabled: boolean; config: StrategyConfig; created_at: number; updated_at: number };
type RunRow = { id: number; strategy_id: string; run_date: string; status: StrategyRun['status']; detail: string; at: number };

const runFrom = (r: RunRow): StrategyRun => ({
  id: r.id, strategyId: r.strategy_id, runDate: r.run_date, status: r.status, detail: r.detail, at: r.at,
});

export class StrategyStore {
  /** Ids applied when the store was opened. For the boot log. */
  applied: string[] = [];

  private constructor() {}

  /** The store, migrated. */
  static async open(): Promise<StrategyStore> {
    const store = new StrategyStore();
    store.applied = await migrate(MIGRATIONS);
    return store;
  }

  private hydrate = (r: StrategyRow): Strategy => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    // A config written by an older version may lack a field this one reads;
    // the defaults fill it rather than the screen showing undefined.
    config: withoutRetired({ ...DEFAULT_CONFIG, ...r.config }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

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

  /** The run a position opened under: the latest claim at or before it. */
  async runDateAtOrBefore(strategyId: string, atMs: number): Promise<string | null> {
    const r = await one<{ run_date: string }>(
      'SELECT run_date FROM strategy_runs WHERE strategy_id = $1 AND at <= $2 ORDER BY at DESC LIMIT 1',
      [strategyId, atMs],
    );
    return r?.run_date ?? null;
  }

  async runs(limit = 60): Promise<StrategyRun[]> {
    return (await rows<RunRow>('SELECT * FROM strategy_runs ORDER BY at DESC LIMIT $1', [limit])).map(runFrom);
  }
}
