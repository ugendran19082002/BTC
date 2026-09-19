import type { FastifyInstance } from 'fastify';
import { refuse } from '../refuse.js';
import { StrategyStore } from '../../strategy/store.js';
import { entryDue, entrySlotDate, istDate, nextEntryAt } from '../../strategy/schedule.js';
import { holdFor, statusOf } from '../../strategy/holds.js';
import { DEFAULT_CONFIG, defaultAddUntil, validateConfig, type StrategyConfig } from '../../strategy/types.js';
import { tradingService } from '../../trading/service.js';
import {
  REBALANCE_CEILINGS, capFor, cleanRebalance, stageThresholds,
  type RebalanceLimits, type RebalanceRule,
} from '../../strategy/rebalance.js';

/**
 * The strategy desk: what is saved, what is armed, and when it next runs.
 *
 * Server-authoritative in the same way the mode switch is. The browser sends a
 * config and asks; this validates it, decides, and answers with what was
 * actually stored. A page that could arm a strategy by setting a flag in its
 * own state is a page that can do it by accident, and this one places real
 * orders on a schedule.
 */

let store: StrategyStore | null = null;

/** Migrate and open the strategy tables. Called once at boot, before the routes register. */
export async function initStrategyStore(): Promise<StrategyStore> {
  return (store ??= await StrategyStore.open());
}

/** The store, once `initStrategyStore()` has run. Asking earlier is a boot-order bug. */
export const strategyStore = (): StrategyStore => {
  if (!store) throw new Error('strategyStore() before initStrategyStore(): the store is opened at boot, in index.ts');
  return store;
};

/** Only the keys we know how to read, so a stray field cannot reach the row. */
/** The cap the rule can actually reach, when the rule is set to work it out. */
function withAutoCap(rule: RebalanceRule | null, lots: number): RebalanceRule | null {
  if (!rule || !rule.capAuto || rule.maxLotsPerSide === null) return rule;
  return { ...rule, maxLotsPerSide: capFor(rule, lots) };
}

function cleanConfig(raw: unknown): StrategyConfig {
  const c = (raw ?? {}) as Partial<StrategyConfig>;
  const exitTime = String(c.exitTime ?? DEFAULT_CONFIG.exitTime);
  return {
    entryTime: String(c.entryTime ?? DEFAULT_CONFIG.entryTime),
    exitTime,
    // A client that predates the strike rule sends neither field, and means
    // premium -- which is what it has been doing all along.
    strikeRule: c.strikeRule === 'strict' ? 'strict'
      : c.strikeRule === 'oiWall' ? 'oiWall'
        : 'premium',
    strikeStep: Math.trunc(Number(c.strikeStep ?? DEFAULT_CONFIG.strikeStep)) || 0,
    premium: {
      mode: c.premium?.mode === 'atMost' ? 'atMost' : 'atLeast',
      usd: Number(c.premium?.usd ?? DEFAULT_CONFIG.premium.usd),
    },
    entryPrice: c.entryPrice === 'now' || c.entryPrice === 'set' ? c.entryPrice : 'offer',
    entryLimit: c.entryLimit === null || c.entryLimit === undefined ? null : Number(c.entryLimit),
    crossAfterSec: Math.floor(Number(c.crossAfterSec ?? DEFAULT_CONFIG.crossAfterSec)),
    maxCrossSpreadPct: Number(c.maxCrossSpreadPct ?? DEFAULT_CONFIG.maxCrossSpreadPct),
    takeProfitPct: Number(c.takeProfitPct ?? DEFAULT_CONFIG.takeProfitPct),
    stopLossPct: Number(c.stopLossPct ?? DEFAULT_CONFIG.stopLossPct),
    lots: Math.floor(Number(c.lots ?? DEFAULT_CONFIG.lots)),
    legs: c.legs === 'CE' || c.legs === 'PE' ? c.legs : 'both',
    // A client that predates the setting sends nothing and means the old
    // constant, which is what DEFAULT_CONFIG carries.
    graceMin: Math.trunc(Number(c.graceMin ?? DEFAULT_CONFIG.graceMin)) || DEFAULT_CONFIG.graceMin,
    probGate: c.probGate === null || c.probGate === undefined ? null : Number(c.probGate),
    doubleWhenOneSided: Boolean(c.doubleWhenOneSided),
    minSellScore: c.minSellScore === null || c.minSellScore === undefined
      ? null
      : Math.trunc(Number(c.minSellScore)),
    // Absent from a client that predates the gate, and from every strategy
    // saved before it existed: off, which is what they have been doing.
    maxShockScore: c.maxShockScore === null || c.maxShockScore === undefined
      ? null
      : Math.trunc(Number(c.maxShockScore)),
    /*
     * The rebalance rule, checked against the limits in force rather than a
     * number in the source: "…n stages" is what somebody typed on the screen.
     */
    /*
     * An automatic cap is recomputed here, on every save, from the lots and the
     * stages as they are now: changing 3 stages to 5 must not leave a cap that
     * silently refuses the last two.
     */
    rebalance: withAutoCap(cleanRebalance(
      c.rebalance as Partial<RebalanceRule> | null,
      strategyStore().rebalanceLimits(),
      strategyStore().rebalanceDefaults(),
    ), Math.floor(Number(c.lots ?? DEFAULT_CONFIG.lots))),
    addToOpposite: c.addToOpposite === null || c.addToOpposite === undefined || typeof c.addToOpposite !== 'object'
      ? null
      : {
          minPriceUsd: Number(c.addToOpposite.minPriceUsd),
          maxMultiple: Number(c.addToOpposite.maxMultiple),
          // Absent from a client that predates it: half an hour before the exit.
          addUntil: c.addToOpposite.addUntil === undefined ? defaultAddUntil(exitTime) : String(c.addToOpposite.addUntil),
          // Absent, or cleared: the entry's own seconds, which is what every
          // strategy saved before this did.
          crossAfterSec: c.addToOpposite.crossAfterSec === undefined || c.addToOpposite.crossAfterSec === null
            ? null
            : Math.floor(Number(c.addToOpposite.crossAfterSec)),
        },
    weekdays: Array.isArray(c.weekdays)
      ? [...new Set(c.weekdays.map((d) => Math.floor(Number(d))))].sort()
      : [...DEFAULT_CONFIG.weekdays],
  };
}

/** An id from a name: stable, readable in the journal, and URL-safe. */
const idFrom = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  || `s${Date.now()}`;

/**
 * The rebalance defaults and the limits a rule is held to.
 *
 * Both are settings, so a desk that runs five stages at 40/25 types it once
 * and every new rule starts there. `ceilings` is what no limit may pass and is
 * not editable; the screen shows it as the outer bound of each box.
 */
export function registerStrategyRoutes(app: FastifyInstance) {
  app.get('/api/strategies/rebalance-settings', async () => ({
    defaults: strategyStore().rebalanceDefaults(),
    limits: strategyStore().rebalanceLimits(),
    ceilings: REBALANCE_CEILINGS,
    /** The stages those defaults make, so the screen can show them without arithmetic. */
    stages: stageThresholds(strategyStore().rebalanceDefaults(), { up: null, down: null }),
  }));

  app.post('/api/strategies/rebalance-settings', async (req, reply) => {
    const b = (req.body ?? {}) as { defaults?: unknown; limits?: unknown };
    if (b.limits !== undefined) {
      if (b.limits === null || typeof b.limits !== 'object') {
        reply.code(400);
        return { error: 'limits must be an object' };
      }
      const asked = b.limits as Record<string, unknown>;
      for (const [key, hi] of Object.entries(REBALANCE_CEILINGS)) {
        if (asked[key] === undefined) continue;
        const v = Number(asked[key]);
        if (!Number.isInteger(v) || v < 1 || v > hi) {
          reply.code(400);
          return { error: `${key} must be a whole number from 1 to ${hi}` };
        }
      }
      await strategyStore().setRebalanceLimits(asked as Partial<RebalanceLimits>);
    }
    if (b.defaults !== undefined) {
      if (b.defaults === null || typeof b.defaults !== 'object') {
        reply.code(400);
        return { error: 'defaults must be an object' };
      }
      await strategyStore().setRebalanceDefaults(b.defaults as Partial<RebalanceRule>);
    }
    return {
      ok: true,
      defaults: strategyStore().rebalanceDefaults(),
      limits: strategyStore().rebalanceLimits(),
    };
  });

  const svc = tradingService();

  app.get('/api/strategies', async () => {
    const s = strategyStore();
    const now = Date.now();
    const today = istDate(now);
    return {
      today,
      /**
       * The master switch. Every strategy is inert until this is on, so a
       * config saved in the evening cannot surprise anybody at 05:30. It is a
       * setting rather than an env var because turning the desk off in a hurry
       * should not need a deploy.
       */
      schedulerOn: svc.settings.get('scheduler_enabled') === '1',
      /**
       * Whether the loop that places the orders is actually installed.
       *
       * It was not, for a day, while the switch above said "on" and the card
       * read "may place orders without being asked". Nothing ran, nothing was
       * logged, and the screen gave no hint why. A switch that claims an effect
       * it cannot have is worse than no switch, so the screen now reads this.
       */
      runnerInstalled: true,
      mode: svc.mode,
      /*
       * The account, so the editor can price a size while it is being typed.
       * Sent with the strategies rather than fetched separately: a form that
       * has to wait on a second request shows "—" where the warning goes, and
       * the warning is the reason the number is there.
       */
      balanceUsd: svc.lastBalanceUsd,
      spot: svc.spot,
      strategies: await Promise.all((await s.all()).map(async (x) => {
        const last = await s.lastRunDate(x.id);
        const due = entryDue(x, now, last);
        return {
          ...x,
          lastRunDate: last,
          ranToday: last === today,
          nextEntryAt: nextEntryAt(x, now, last),
          /**
           * Why it is not entering this second. The screen shows this verbatim.
           *
           * A hold outranks "due now": the clock says it is time and the desk
           * has decided to wait, which is exactly the case the screen was
           * silent about before.
           */
          status: statusOf(due, holdFor(x.id, entrySlotDate(x, now))),
        };
      })),
      runs: await s.runs(40),
      /** Every decision to add to the other leg -- the skips too, with their reason. */
      adds: await s.adds(40),
    };
  });

  app.post('/api/strategies', async (req, reply) => {
    const b = (req.body ?? {}) as { id?: string; name?: string; enabled?: boolean; config?: unknown };
    const name = String(b.name ?? '').trim();
    if (!name) { reply.code(400); return { error: 'name is required' }; }

    const config = cleanConfig(b.config);
    const problems = validateConfig(config);
    // A config the desk will not accept is the desk working, not a fault: the
    // form gets every objection at once and the error log stays readable.
    if (problems.length) return refuse(reply, 422, { error: problems.join(' '), problems });

    const s = strategyStore();
    const id = b.id ? String(b.id) : idFrom(name);
    // Arming and saving are separate acts. A new strategy is never born armed.
    const existing = await s.get(id);
    const enabled = existing ? existing.enabled : false;
    return { ok: true, strategy: await s.save({ id, name, enabled, config }) };
  });

  app.post('/api/strategies/:id/enabled', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    const s = strategyStore();
    const found = await s.get(id);
    if (!found) { reply.code(404); return { error: 'no such strategy' }; }

    if (enabled) {
      // Arming something whose config no longer validates would leave a
      // scheduler firing on a rule nobody can read back.
      const problems = validateConfig(found.config);
      if (problems.length) {
        return refuse(reply, 422, { error: `Fix the settings first: ${problems.join(' ')}`, problems });
      }
    }
    return { ok: true, strategy: await s.setEnabled(id, Boolean(enabled)) };
  });

  app.delete('/api/strategies/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = strategyStore();
    if (!(await s.get(id))) { reply.code(404); return { error: 'no such strategy' }; }
    await s.remove(id);
    return { ok: true };
  });

  /**
   * The master switch for the whole scheduler.
   *
   * Off by default and stored, so it survives a restart. Turning it on is the
   * moment this desk starts trading without being asked, which is worth being
   * a deliberate act with its own button.
   */
  app.post('/api/strategies/scheduler', async (req, reply) => {
    const { on } = (req.body ?? {}) as { on?: boolean };
    if (typeof on !== 'boolean') { reply.code(400); return { error: 'on must be true or false' }; }
    if (on && svc.mode === 'live' && !svc.canGoLive) {
      return refuse(reply, 409, { error: 'The desk cannot reach the exchange; the scheduler would only fail.' });
    }
    await svc.settings.set('scheduler_enabled', on ? '1' : '0');
    return { ok: true, schedulerOn: on };
  });

  /** The run journal on its own, for the history panel. */
  app.get('/api/strategies/runs', async () => ({ runs: await strategyStore().runs(200) }));
}
