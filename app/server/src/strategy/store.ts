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
import { perpAtMinutes } from '../market/perp-minute.js';
import { one, query, rows } from '../db/pool.js';
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
  {
    /*
     * Signal strategies (2 Oct 2026): a strategy that trades the desk's entry
     * signals takes many a day, so a day is not its unit -- a signal is. One row
     * per strategy per signal, claimed before anything is sent: the UNIQUE key is
     * what stops a signal seen on two minutes, or by two processes, being traded
     * twice. The status says how it went, in words in `detail`.
     */
    id: 'strategy-006-signal-runs',
    up: `
      CREATE TABLE IF NOT EXISTS strategy_signal_runs (
        id          BIGINT   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        strategy_id TEXT     NOT NULL,
        signal_key  TEXT     NOT NULL,
        method      TEXT     NOT NULL,
        mode        TEXT     NOT NULL,
        tf          TEXT     NOT NULL,
        dir         SMALLINT NOT NULL,
        status      TEXT     NOT NULL,
        detail      TEXT     NOT NULL DEFAULT '',
        trade_id    TEXT,
        at          BIGINT   NOT NULL,
        UNIQUE (strategy_id, signal_key)
      );
      CREATE INDEX IF NOT EXISTS strategy_signal_runs_by_time ON strategy_signal_runs (at DESC);
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

/** What became of one signal for one signal strategy. */
export type SignalRunStatus = 'claimed' | 'placed' | 'would-place' | 'refused' | 'skipped' | 'failed';
export type SignalRun = {
  id: number; strategyId: string; signalKey: string; method: string; mode: string; tf: string; dir: 1 | -1;
  status: SignalRunStatus; detail: string; tradeId: string | null; at: number;
};
type SignalRunRow = {
  id: number; strategy_id: string; signal_key: string; method: string; mode: string; tf: string; dir: number;
  status: SignalRunStatus; detail: string; trade_id: string | null; at: string | number;
};
/**
 * One signal strategy trade, for the Live screen's history.
 *
 *   levels   the signal's own plan on the BTC perp: the entry zone, SL, TGT1-3
 *   perp     what the paper log saw on the perp: waiting, filled, out at the
 *            stop or TGT1, timed out or expired -- the only record a "would
 *            sell" has
 *   option   a real order's option: contract, fill, exit, why it closed, P&L
 */
export type SignalTrade = {
  id: number; strategyId: string; at: number; method: string; mode: string; tf: string; dir: 1 | -1;
  /** placed / would-place are trades; skipped, refused and failed are signals not taken, with the reason in `detail`. */
  status: Exclude<SignalRunStatus, 'claimed'>; detail: string; tradeId: string | null;
  levels: { entryLo: number; entryHi: number; stop: number; tp1: number; tp2: number | null; tp3: number | null } | null;
  perp: { status: string; fillPrice: number | null; filledAt: number | null; exitPrice: number | null; exitAt: number | null } | null;
  option: {
    side: string; strike: number | null; size: number; open: boolean;
    entry: number | null; exit: number | null; pnlUsd: number; exitReason: string | null;
    perpStop: number | null; perpTarget: number | null;
    /** The perp's price when it was entered: the zone fill, or the last trade at the signal. */
    perpEntry: number | null;
    /** `perpEntry` is the perp's price over the minute the option filled: a trade placed before the exact price was kept. */
    perpEntryApprox?: boolean;
    /**
     * The perp's price when it came out: exact when the desk closed it on the perp's own SL or TGT (the
     * price is in its reason), else the perp over the minute of the last exit fill (`perpExitApprox`).
     */
    perpExit: number | null;
    perpExitApprox?: boolean;
    /** The option's own target and stop, as placed (the backstop at Delta); null when off. */
    optionTarget: number | null; optionStop: number | null;
    /**
     * Which exit closed it -- the perp first, then the option (engine.ts `pollInner`):
     *   perp-sl / perp-tgt      the signal's levels on the BTC perp, judged by the desk
     *   option-tgt / option-sl  the option's own target or stop: at Delta, or the desk's stop watch
     *   window-end              the strategy's exit time
     *   manual                  a close by hand
     * Null while open.
     */
    exitBy: ExitBy | null;
    /** When the option filled in, and when it was last bought back (epoch ms). */
    entryAt: number | null; exitAt: number | null;
  } | null;
};
type SignalTradeRow = SignalRunRow & {
  t_reason: string | null;
  t_position: number | null; t_plan: Record<string, any> | null; t_state: Record<string, any> | null;
  p_status: string | null; entry_lo: number | null; entry_hi: number | null; stop: number | null;
  tp1: number | null; tp2: number | null; tp3: number | null;
  fill_price: number | null; filled_at: string | number | null; exit_price: number | null; exit_at: string | number | null;
};
export type ExitBy = 'perp-sl' | 'perp-tgt' | 'option-tgt' | 'option-sl' | 'window-end' | 'manual';

/** Which exit closed a trade, from the desk's close reason and which order filled the close. */
export function exitByOf(reason: string | null, winner: string | null): ExitBy {
  if (reason && /perp at .*stop/i.test(reason)) return 'perp-sl';
  if (reason && /perp at .*target/i.test(reason)) return 'perp-tgt';
  if (winner === 'take_profit') return 'option-tgt';
  if (winner === 'stop_loss') return 'option-sl';
  if (reason && /^stop/i.test(reason)) return 'option-sl';                // the desk's own option stop watch
  if (reason && /exit time|end of its window/i.test(reason)) return 'window-end';
  return 'manual';
}

/** The perp's price in the desk's own close reason: "BTC perp at 84590 reached the signal's stop 84600". */
export function perpInReason(reason: string | null): number | null {
  const m = reason ? /perp at ([\d,.]+)/i.exec(reason) : null;
  const p = m ? Number(m[1]!.replace(/,/g, '')) : NaN;
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** The first entry fill and the last exit fill, from a trade's fills. */
function fillTimes(fills: unknown): { entryAt: number | null; exitAt: number | null } {
  const fs = Array.isArray(fills) ? (fills as { role?: string; ts?: number }[]) : [];
  const entries = fs.filter((f) => f.role === 'entry' && Number(f.ts) > 0).map((f) => Number(f.ts));
  const exits = fs.filter((f) => f.role && f.role !== 'entry' && Number(f.ts) > 0).map((f) => Number(f.ts));
  return { entryAt: entries.length ? Math.min(...entries) : null, exitAt: exits.length ? Math.max(...exits) : null };
}
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const signalTradeFrom = (r: SignalTradeRow): SignalTrade => ({
  id: Number(r.id), strategyId: r.strategy_id, at: Number(r.at), method: r.method, mode: r.mode, tf: r.tf,
  dir: Number(r.dir) === 1 ? 1 : -1, status: r.status as SignalTrade['status'], detail: r.detail, tradeId: r.trade_id,
  levels: r.p_status === null ? null : {
    entryLo: Number(r.entry_lo), entryHi: Number(r.entry_hi), stop: Number(r.stop), tp1: Number(r.tp1), tp2: n(r.tp2), tp3: n(r.tp3),
  },
  perp: r.p_status === null ? null : {
    // the paper log's times are epoch seconds; the screen's are ms
    status: r.p_status, fillPrice: n(r.fill_price), filledAt: r.filled_at === null ? null : Number(r.filled_at) * 1_000,
    exitPrice: n(r.exit_price), exitAt: r.exit_at === null ? null : Number(r.exit_at) * 1_000,
  },
  option: !r.t_plan || !r.t_state ? null : {
    side: String(r.t_plan.optionSide), strike: n(r.t_plan.expect?.strike),
    size: Number(r.t_state.entrySize ?? 0), open: Number(r.t_position ?? 0) !== 0,
    entry: n(r.t_state.entryAvgPrice), exit: n(r.t_state.exitAvgPrice), pnlUsd: Number(r.t_state.realisedPnl ?? 0),
    exitReason: r.t_state.exitReason ?? r.t_reason ?? null,
    optionTarget: n(r.t_plan.takeProfitPrice), optionStop: n(r.t_plan.stopPrice),
    exitBy: Number(r.t_position ?? 0) !== 0 || !Number(r.t_state.exitSize ?? 0) ? null : exitByOf(r.t_state.exitReason ?? r.t_reason ?? null, r.t_state.exitWinner ?? null),
    // Exact first: the perp as the option's exit filled; else the price in the desk's close reason.
    perpExit: n(r.t_state.perpExit) ?? perpInReason(r.t_state.exitReason ?? r.t_reason ?? null),
    perpStop: n(r.t_plan.underlying?.stop), perpTarget: n(r.t_plan.underlying?.target), perpEntry: n(r.t_state.perpEntry) ?? n(r.t_plan.underlying?.entry),
    ...fillTimes(r.t_state.fills),
  },
});

const signalRunFrom = (r: SignalRunRow): SignalRun => ({
  id: Number(r.id), strategyId: r.strategy_id, signalKey: r.signal_key, method: r.method, mode: r.mode, tf: r.tf,
  dir: Number(r.dir) === 1 ? 1 : -1, status: r.status, detail: r.detail, tradeId: r.trade_id, at: Number(r.at),
});

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

  /**
   * Claim a signal for a signal strategy, before anything is sent: false when it
   * is already claimed -- the UNIQUE key decides, not a check-then-write.
   */
  async claimSignal(strategyId: string, key: string, s: { method: string; mode: string; tf: string; dir: 1 | -1 }, at = Date.now()): Promise<boolean> {
    const r = await query(
      `INSERT INTO strategy_signal_runs (strategy_id, signal_key, method, mode, tf, dir, status, detail, at)
       VALUES ($1, $2, $3, $4, $5, $6, 'claimed', 'claimed, not yet run', $7)
       ON CONFLICT (strategy_id, signal_key) DO NOTHING`,
      [strategyId, key, s.method, s.mode, s.tf, s.dir, at],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Say how a claimed signal went. */
  async finishSignal(strategyId: string, key: string, status: SignalRunStatus, detail: string, tradeId: string | null = null): Promise<void> {
    await query(
      'UPDATE strategy_signal_runs SET status = $1, detail = $2, trade_id = $3, at = $4 WHERE strategy_id = $5 AND signal_key = $6',
      [status, detail.slice(0, 500), tradeId, Date.now(), strategyId, key],
    );
  }

  /**
   * How many of this strategy's "would sell" signals are still in play: their
   * signal, in the paper log, waiting at its zone or filled and not yet out.
   *
   * With live orders off nothing is placed, so counting open trades found none,
   * and "at most 2 open" let seven signals through (2 Oct 2026). The paper log
   * grades every signal on the live tape (entry/live-grade.ts), so it knows
   * when the trade that would have been is over.
   */
  async wouldBeOpen(strategyId: string): Promise<number> {
    const r = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM strategy_signal_runs r
         JOIN entry_setups e
           ON e.method = r.method AND e.mode = r.mode AND e.tf = r.tf AND e.dir = r.dir
          AND e.trigger_at = split_part(r.signal_key, '|', 5)::bigint
        WHERE r.strategy_id = $1 AND r.status = 'would-place' AND e.status IN ('open', 'filled')`,
      [strategyId],
    );
    return r?.n ?? 0;
  }

  /**
   * The signal strategies' trades, newest first: every signal sold (or, with
   * live orders off, that would have been) -- and every one not taken, with
   * why (skipped, refused, failed) -- with the signal's levels on the
   * perp, what the paper log saw happen on the perp, and -- for a real order --
   * the option's fill, exit, why it closed and the money.
   */
  /** `range`: signals from `from` up to (not incl.) `to`, epoch ms -- the history's date picker. */
  async signalTrades(limit = 100, strategyId?: string, range?: { from: number; to: number }): Promise<SignalTrade[]> {
    const xs = await rows<SignalTradeRow>(
      `SELECT r.id, r.strategy_id, r.signal_key, r.method, r.mode, r.tf, r.dir, r.status, r.detail, r.trade_id, r.at,
              t.position AS t_position, t.plan AS t_plan, t.state AS t_state,
              -- the journal's last close reason, for a trade closed before the state kept it
              (SELECT ev.event->>'reason' FROM trade_events ev
                WHERE ev.trade_id = r.trade_id AND ev.event->>'t' = 'exit_submitted' AND ev.event->>'reason' IS NOT NULL
                ORDER BY ev.seq DESC LIMIT 1) AS t_reason,
              e.status AS p_status, e.entry_lo, e.entry_hi, e.stop, e.tp1, e.tp2, e.tp3,
              e.fill_price, e.filled_at, e.exit_price, e.exit_at
         FROM strategy_signal_runs r
         LEFT JOIN trades t ON t.trade_id = r.trade_id
         LEFT JOIN entry_setups e
           ON e.method = r.method AND e.mode = r.mode AND e.tf = r.tf AND e.dir = r.dir
          AND e.trigger_at = split_part(r.signal_key, '|', 5)::bigint
        WHERE r.status <> 'claimed' AND ($2::text IS NULL OR r.strategy_id = $2)
          AND ($3::bigint IS NULL OR r.at >= $3) AND ($4::bigint IS NULL OR r.at < $4)
        ORDER BY r.at DESC LIMIT $1`,
      [limit, strategyId ?? null, range?.from ?? null, range?.to ?? null],
    );
    const out = xs.map(signalTradeFrom);
    // A real order's perp entry where it was not kept on the trade: the perp that minute, marked approximate.
    // ...and its perp exit where the close did not say it: the perp over the minute of the last exit fill.
    const needIn = out.filter((t) => t.option && t.option.perpEntry === null && t.option.entryAt !== null);
    const needOut = out.filter((t) => t.option && !t.option.open && t.option.perpExit === null && t.option.exitAt !== null);
    if (needIn.length || needOut.length) {
      const price = await perpAtMinutes([...needIn.map((t) => t.option!.entryAt!), ...needOut.map((t) => t.option!.exitAt!)])
        .catch(() => new Map<number, number>());
      const at = (ms: number) => price.get(Math.floor(ms / 60_000) * 60_000);
      for (const t of needIn) {
        const p = at(t.option!.entryAt!);
        if (p !== undefined) t.option = { ...t.option!, perpEntry: p, perpEntryApprox: true };
      }
      for (const t of needOut) {
        const p = at(t.option!.exitAt!);
        if (p !== undefined) t.option = { ...t.option!, perpExit: p, perpExitApprox: true };
      }
    }
    return out;
  }

  /** Add to the signal's row what became of the trade it placed: "closed at 5:29 PM". */
  async noteSignalTrade(tradeId: string, note: string): Promise<void> {
    await query(
      "UPDATE strategy_signal_runs SET detail = LEFT(detail || ' | ' || $1, 500) WHERE trade_id = $2",
      [note, tradeId],
    );
  }

  /** The signal journal, newest first; one strategy's when `strategyId` is given. */
  async signalRuns(limit = 60, strategyId?: string): Promise<SignalRun[]> {
    const xs = strategyId
      ? await rows<SignalRunRow>('SELECT * FROM strategy_signal_runs WHERE strategy_id = $1 ORDER BY at DESC LIMIT $2', [strategyId, limit])
      : await rows<SignalRunRow>('SELECT * FROM strategy_signal_runs ORDER BY at DESC LIMIT $1', [limit]);
    return xs.map(signalRunFrom);
  }
}
