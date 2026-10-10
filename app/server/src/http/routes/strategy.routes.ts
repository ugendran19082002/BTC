import type { FastifyInstance } from 'fastify';
import { istDayRange } from '../../entry/catalogue.js';
import { noteError } from '../../observability/errors.js';
import { refuse } from '../refuse.js';
import { StrategyStore } from '../../strategy/store.js';
import { entryDue, istDate, istMinutes, nextEntryAt } from '../../strategy/schedule.js';
import { inSignalWindow } from '../../strategy/runner.js';
import { DEFAULT_CONFIG, GLOBAL_MAX_OPEN_KEY, SIGNAL_TFS, globalMaxOpenOf, globalMaxOpenProblem, noEntryWindowAt, noEntryWords, groupNameProblem, signalEntriesAllowed, time12, validateConfig, type DeltaRule, type DistanceRule, type ExitStep, type NoEntry, type NoEntryWindow, type SignalRule, type SignalTf, type Strategy, type StrategyConfig, type StrategyGroup, type StrikeBlock } from '../../strategy/types.js';
import { tradingService, tradingServiceFor } from '../../trading/service.js';
import { accountOf } from '../account-query.js';
import { accountKey, accountSetting } from '../../db/settings.js';
import { brokerAccounts } from '../../delta/accounts.js';
import { config, STARTED_AT } from '../../config.js';

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

/**
 * Only `at` and `value` of each step, in the order sent. Not sorted: a step
 * out of order is a mistake the person should be told about, not one to be
 * quietly repaired into a schedule they did not write. A non-list is passed
 * through as-is so validation can say so.
 */
function cleanSteps(raw: unknown): ExitStep[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return raw as ExitStep[];
  return raw.map((st) => {
    const o = (st ?? {}) as Partial<ExitStep>;
    return { at: String(o.at ?? ''), value: Number(o.value) };
  });
}

/**
 * Only the keys we know how to read, so a stray field cannot reach the row --
 * which is also what retires a setting: a key the desk no longer has is
 * dropped on the next save of any strategy that still carried it.
 */
function cleanConfig(raw: unknown): StrategyConfig {
  const c = (raw ?? {}) as Partial<StrategyConfig>;
  return {
    entryTime: String(c.entryTime ?? DEFAULT_CONFIG.entryTime),
    exitTime: String(c.exitTime ?? DEFAULT_CONFIG.exitTime),
    // A client that predates the strike rule sends neither field, and means
    // premium -- which is what it has been doing all along.
    strikeRule: c.strikeRule === 'strict' ? 'strict'
      : c.strikeRule === 'oiWall' ? 'oiWall'
        : c.strikeRule === 'delta' ? 'delta'
          : c.strikeRule === 'distance' ? 'distance'
            : 'premium',
    strikeStep: Math.trunc(Number(c.strikeStep ?? DEFAULT_CONFIG.strikeStep)) || 0,
    premium: {
      mode: c.premium?.mode === 'atMost' ? 'atMost' : 'atLeast',
      usd: Number(c.premium?.usd ?? DEFAULT_CONFIG.premium.usd),
      // Absent from a client or a strategy that predates it: no fallback.
      fallbackUsd: c.premium?.fallbackUsd === null || c.premium?.fallbackUsd === undefined
        ? null
        : Number(c.premium.fallbackUsd),
      ...cleanMinOtm(c.premium),
    },
    ...cleanDeltaDistance(c),
    // Absent or empty: the desk's floor, which is what every strategy used before it.
    minPremiumUsd: c.minPremiumUsd === null || c.minPremiumUsd === undefined || (c.minPremiumUsd as unknown) === ''
      ? null
      : Number(c.minPremiumUsd),
    entryPrice: c.entryPrice === 'now' || c.entryPrice === 'set' ? c.entryPrice : 'offer',
    // Only a set entry has a price of its own; a leftover one from before the
    // entry was switched back to the offer or the bid is dropped, not kept.
    entryLimit: c.entryPrice !== 'set' || c.entryLimit === null || c.entryLimit === undefined ? null : Number(c.entryLimit),
    crossAfterSec: Math.floor(Number(c.crossAfterSec ?? DEFAULT_CONFIG.crossAfterSec)),
    maxCrossSpreadPct: Number(c.maxCrossSpreadPct ?? DEFAULT_CONFIG.maxCrossSpreadPct),
    takeProfitPct: Number(c.takeProfitPct ?? DEFAULT_CONFIG.takeProfitPct),
    stopLossPct: Number(c.stopLossPct ?? DEFAULT_CONFIG.stopLossPct),
    // Absent from a client, or a strategy, that predates them: a percentage,
    // one value all day -- which is what those strategies have been doing.
    targetMode: c.targetMode === 'points' || c.targetMode === 'price' ? c.targetMode : 'pct',
    takeProfitPoints: Number(c.takeProfitPoints ?? 0),
    takeProfitAt: Number(c.takeProfitAt ?? 0),
    targetSteps: cleanSteps(c.targetSteps),
    stopMode: c.stopMode === 'points' || c.stopMode === 'price' ? c.stopMode : 'pct',
    stopLossPoints: Number(c.stopLossPoints ?? 0),
    stopLossAt: Number(c.stopLossAt ?? 0),
    stopSteps: cleanSteps(c.stopSteps),
    // A screen that predates the setting sends nothing and means the touch,
    // which is what every strategy has been doing.
    monitorOn: c.monitorOn === 'close' ? 'close' : 'ltp',
    lots: Math.floor(Number(c.lots ?? DEFAULT_CONFIG.lots)),
    legs: c.legs === 'CE' || c.legs === 'PE' ? c.legs : 'both',
    // A client that predates the setting sends nothing and means the old
    // constant, which is what DEFAULT_CONFIG carries.
    graceMin: Math.trunc(Number(c.graceMin ?? DEFAULT_CONFIG.graceMin)) || DEFAULT_CONFIG.graceMin,
    weekdays: Array.isArray(c.weekdays)
      ? [...new Set(c.weekdays.map((d) => Math.floor(Number(d))))].sort()
      : [...DEFAULT_CONFIG.weekdays],
    // A client that predates signal strategies sends none of these, and means the clock.
    // The blocks too: only a signal strategy has a window to split, so a clock strategy never carries them.
    ...(c.trigger === 'signal'
      ? { trigger: 'signal' as const, signal: cleanSignal(c.signal), liveOrders: c.liveOrders === true, strikeBlocks: cleanBlocks(c.strikeBlocks), ...cleanNoEntry(c.noEntry) }
      : {}),
  };
}

/**
 * The no-entry windows (9 Oct 2026): the switch and each window's two times, in the order sent; kept while
 * switched off, so switching back on finds them. Absent is no key at all, so a strategy that never used it is
 * stored as before. A shape it cannot read is left as sent, for validation to name.
 */
function cleanNoEntry(raw: unknown): { noEntry?: NoEntry } {
  if (raw === undefined || raw === null) return {};
  const n = raw as Partial<NoEntry>;
  if (typeof raw !== 'object' || !Array.isArray(n.windows)) return { noEntry: raw as NoEntry };
  return {
    noEntry: {
      on: n.on === true,
      windows: n.windows.map((w) => ({ from: String((w as Partial<NoEntryWindow> | null)?.from ?? ''), to: String((w as Partial<NoEntryWindow> | null)?.to ?? '') })),
    },
  };
}

/**
 * Each block's own keys, in the order sent -- not sorted, for the reason
 * `cleanSteps` gives: a block out of order is said, not quietly repaired. A
 * rule it cannot read is left as sent so validation can name it.
 */
function cleanBlocks(raw: unknown): StrikeBlock[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return raw as StrikeBlock[];
  return raw.map((b) => {
    const o = (b ?? {}) as Partial<StrikeBlock>;
    const f = o.premium?.fallbackUsd;
    return {
      at: String(o.at ?? ''),
      strikeRule: o.strikeRule as StrikeBlock['strikeRule'],
      strikeStep: Math.trunc(Number(o.strikeStep ?? 0)) || 0,
      premium: {
        mode: o.premium?.mode as StrikeBlock['premium']['mode'],
        usd: Number(o.premium?.usd ?? DEFAULT_CONFIG.premium.usd),
        fallbackUsd: f === null || f === undefined ? null : Number(f),
        ...cleanMinOtm(o.premium),
      },
      ...cleanDeltaDistance(o),
    };
  });
}

/**
 * A delta rule's number and a distance rule's, each kept only when it was sent:
 * a strategy that never used either is stored as it always was. Kept whichever
 * rule is chosen, the way the premium is, so a number typed under one rule is
 * still there on the way back to it. A number that cannot be read is left for
 * validation to name, under the rule that reads it.
 */
function cleanDeltaDistance(o: { delta?: unknown; distance?: unknown }): { delta?: DeltaRule; distance?: DistanceRule } {
  const d = o.delta as Partial<DeltaRule> | null | undefined;
  const far = o.distance as Partial<DistanceRule> | null | undefined;
  return {
    ...(d && typeof d === 'object' ? { delta: { max: Number(d.max) } } : {}),
    ...(far && typeof far === 'object'
      ? { distance: { pct: Number(far.pct), scale: far.scale as unknown as DistanceRule['scale'] } }
      : {}),
  };
}

/**
 * A premium rule's distance condition and its else strike, kept only when the
 * condition is set: off is no key at all, so a strategy that never used it is
 * stored as it always was -- and an else strike with no condition to be the
 * else of is dropped. The else is always written beside its condition, the
 * condition's own strike when none was sent, so the row says what is sold.
 */
function cleanMinOtm(p: { minOtm?: unknown; elseOtm?: unknown } | undefined): { minOtm?: number; elseOtm?: number } {
  const none = (v: unknown) => v === null || v === undefined || v === '';
  if (!p || none(p.minOtm)) return {};
  return { minOtm: Number(p.minOtm), elseOtm: Number(none(p.elseOtm) ? p.minOtm : p.elseOtm) };
}

/** A signal rule: only its own keys, the methods de-duplicated in the order sent. A mode or timeframe it cannot read is left for validation to name. */
const TF_ORDER: readonly string[] = SIGNAL_TFS;

function cleanSignal(raw: unknown): SignalRule {
  const r = (raw ?? {}) as Partial<SignalRule>;
  return {
    mode: r.mode as SignalRule['mode'],
    tf: (r.tf ?? '5m') as SignalTf,
    // Several timeframes without the chain; kept in the desk's order, each once.
    ...(Array.isArray(r.tfs) && r.tfs.length
      ? { tfs: [...new Set(r.tfs.map(String))].sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b)) as SignalTf[] }
      : {}),
    methods: Array.isArray(r.methods) ? [...new Set(r.methods.map(String))] : [],
    target: (r.target ?? 'tp1') as SignalRule['target'],
    maxOpen: r.maxOpen === undefined ? 1 : Math.trunc(Number(r.maxOpen)),
    enterOn: (r.enterOn ?? 'zone') as SignalRule['enterOn'],
    // Sold unless it says bought: what every strategy saved before the choice existed did.
    action: (r.action ?? 'sell') as SignalRule['action'],
    ...cleanPts('minSlPts', r.minSlPts),
    ...cleanPts('minTgtPts', r.minTgtPts),
    ...cleanPts('maxSlPts', r.maxSlPts),
    ...cleanPts('maxTgtPts', r.maxTgtPts),
  };
}

/**
 * A distance filter (the least or the most, SL or TGT), per timeframe: each number as sent, a blank or
 * zero left out -- off is no entry -- and the key itself only when one is set,
 * so a strategy that never used it is stored as before. Not a map: left for
 * validation to say.
 */
function cleanPts<K extends 'minSlPts' | 'minTgtPts' | 'maxSlPts' | 'maxTgtPts'>(key: K, raw: unknown): Partial<Pick<SignalRule, K>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return { [key]: raw } as Partial<Pick<SignalRule, K>>;
  const kept = Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && Number(v) !== 0)
    .map(([tf, v]) => [tf, Number(v)] as const);
  return (kept.length ? { [key]: Object.fromEntries(kept) } : {}) as Partial<Pick<SignalRule, K>>;
}

/** An id from a name: stable, readable in the journal, and URL-safe. */
const idFrom = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  || `s${Date.now()}`;

export function registerStrategyRoutes(app: FastifyInstance) {
  const svc = tradingService();

  /*
   * The signal strategies' trade history for a range of IST days (or minutes): the Live screen's Trade
   * history and its date picker. `from` / `to` as the Methods report takes them; neither, the latest.
   */
  app.get('/api/strategies/signal-trades', async (req, reply) => {
    const { from, to } = (req.query ?? {}) as { from?: string; to?: string };
    const range = istDayRange(from, to);
    if (range && 'error' in range) { reply.code(400); return { error: range.error }; }
    const trades = await strategyStore().signalTrades(2_000, undefined, range ?? undefined);
    const mine = await ofAccount(accountOf(req.query));
    return { from: from ?? null, to: to ?? null, trades: mine ? trades.filter((t) => mine.has(t.strategyId)) : trades };
  });

  /**
   * `?account=<id>`: the strategies of one broker account (and those that belong to none), as ids -- what a
   * run or a signal is kept by. Null: every account, nothing left out.
   */
  const OFF_ACCOUNT = 'not entering: its account is switched off';
  /** An account's name, for a group's heading on "All accounts"; null where there is none. */
  const accountNameOf = (id: number | null): string | null => {
    if (id === null) return null;
    try { return brokerAccounts().get(id)?.name ?? null; } catch { return null; }
  };
  /** A group as every answer gives it: with its account's name. */
  const named = (g: StrategyGroup) => ({ ...g, accountName: accountNameOf(g.accountId) });
  const belongs = (x: { accountId?: number | null }, account: number | null) =>
    account === null || (x.accountId ?? null) === null || x.accountId === account;
  async function ofAccount(account: number | null): Promise<Set<string> | null> {
    if (account === null) return null;
    return new Set((await strategyStore().all()).filter((x) => belongs(x, account)).map((x) => x.id));
  }

  // Every saved strategy, today's runs, the scheduler switch and each strategy's next entry. `?account=<id>`: one broker account's.
  app.get('/api/strategies', async (req) => {
    const s = strategyStore();
    const account = accountOf(req.query);
    /*
     * `?lite=1` (10 Oct 2026): the phone's read, every 20 s -- the strategies, the runs and the figures, without the
     * signal journal and the trade history it never shows: 203 KB of the 266 a read weighed, and the two queries
     * behind them. The keys stay, empty, so one shape answers both.
     */
    const lite = (req.query as { lite?: string } | undefined)?.lite === '1';
    const shown = (await s.all()).filter((x) => belongs(x, account));
    const mine = account === null ? null : new Set(shown.map((x) => x.id));
    const kept = <T extends { strategyId: string }>(xs: T[]): T[] => (mine ? xs.filter((x) => mine.has(x.strategyId)) : xs);
    // An account other than the one the desk is trading on is being looked at: the desk's wallet and holdings are not its.
    const elsewhere = account !== null && svc.accountId !== null && account !== svc.accountId;
    const now = Date.now();
    const today = istDate(now);
    /*
     * What each strategy holds open now -- positions and working orders -- as
     * trades and as lots, so its card can say how much of its own limit is in
     * use. A working entry holds no position yet and counts at the size it
     * asked for: that margin is already spoken for.
     */
    const openTrades = await svc.openTrades().catch(() => []);
    const lotsOf = (t: typeof openTrades[number]) => Math.abs(t.state.position) || t.state.requestedSize || 0;
    const openOf = (id: string) => {
      const mine = openTrades.filter((t) => t.plan.strategyId === id);
      return { trades: mine.length, lots: mine.reduce((n, t) => n + lotsOf(t), 0) };
    };
    // Delta's own wallet: what the account is worth and what is free. Null where the exchange cannot say (paper).
    const wallet = await svc.walletForDisplay().catch(() => null);
    return {
      today,
      /**
       * The master switch. Every strategy is inert until this is on, so a
       * config saved in the evening cannot surprise anybody at 05:30. It is a
       * setting rather than an env var because turning the desk off in a hurry
       * should not need a deploy.
       */
      schedulerOn: svc.settings.get('scheduler_enabled') === '1',
      // The desk-wide cap on open trades (0: none), and how many the desk holds now -- positions and working orders.
      // Kept per broker account: the shown account's own cap, the trading account's when none is asked for.
      signalMaxOpen: globalMaxOpenOf(accountSetting(svc.settings, GLOBAL_MAX_OPEN_KEY, account ?? svc.accountId)),
      // What the desk holds is the trading account's; another account, looked at, holds nothing of it.
      openNow: elsewhere ? 0 : openTrades.length,
      /*
       * The desk's limit on lots short at once (the order gate's MAX_POSITION), and
       * the lots the desk holds short now, working entries at the size they asked
       * for. The summary holds "still to open" to what this leaves: an entry the
       * strategies' limits allow is still refused when it would pass this.
       */
      shortCap: svc.maxShortContracts,
      shortNow: elsewhere ? 0 : openTrades.reduce((n, t) => n + lotsOf(t), 0),
      // Delta's own figures, where it gives them: the account's value, and the margin in use (value less what is free).
      // The trading account's wallet -- not shown as another account's when that one is being looked at.
      walletUsd: elsewhere ? null : wallet?.balance ?? null,
      marginUsedUsd: elsewhere || !wallet ? null : Math.max(0, wallet.balance - wallet.available),
      // Which build this is and since when, so "is the change live" is read off the screen.
      build: { tag: config.buildTag, startedAt: STARTED_AT },
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
      strategies: await Promise.all(shown.map(async (x) => {
        // Another account's strategy: shown, and said plainly that it is not entering while the desk is elsewhere.
        const here = tradingServiceFor(x.accountId) !== null;
        if (x.config.trigger === 'signal') {
          // A signal strategy has no entry time to count down to: it is taking signals now, or it is not.
          const on = inSignalWindow(x, now);
          // Inside a no-entry window it is in its hours but not entering: said, with when entries open again.
          const blocked = on ? noEntryWindowAt(x.config, istMinutes(now)) : null;
          return {
            ...x, lastRunDate: null, ranToday: false, nextEntryAt: null,
            open: openOf(x.id),
            status: !here ? OFF_ACCOUNT : blocked
              ? `no new entry until ${time12(blocked.to)} (no-entry window ${noEntryWords(blocked)}) -- what is open keeps its exits`
              : on
                ? `taking signals until ${time12(x.config.exitTime)}${x.config.liveOrders ? '' : ' -- live orders off: writing down what it would place'}`
                : `outside its window (${time12(x.config.entryTime)} to ${time12(x.config.exitTime)} IST, its days)`,
          };
        }
        const last = await s.lastRunDate(x.id);
        const due = entryDue(x, now, last);
        return {
          ...x,
          lastRunDate: last,
          ranToday: last === today,
          nextEntryAt: nextEntryAt(x, now, last),
          /** Why it is not entering this second. The screen shows this verbatim. */
          status: !here ? OFF_ACCOUNT : due.due ? 'due now' : due.because,
        };
      })),
      /*
       * The groups (10 Oct 2026): the account's, or every account's on "All accounts", each with its account's name.
       * A strategy says its own (`groupId`); one in none is listed apart.
       */
      groups: (await s.groups()).filter((g) => belongs(g, account)).map(named),
      runs: kept(await s.runs(mine ? 200 : 40)).slice(0, 40),
      // Each signal a signal strategy saw, and what became of it.
      signalRuns: lite ? [] : kept(await s.signalRuns(mine ? 300 : 60)).slice(0, 60),
      // The signal strategies' trades, with the signal's perp levels, the paper log's verdict and the option's money.
      // Never the reason the list fails: an unreadable history is an empty one, and an entry in the error log.
      signalTrades: lite ? [] : kept(await s.signalTrades(300).catch((e: Error) => {
        noteError({ source: 'server', level: 'warn', where: 'signal-trades', message: `signal trade history not read: ${e.message}` });
        return [];
      })),
    };
  });

  // Create or update a strategy, validated the way the form validates it.
  app.post('/api/strategies', async (req, reply) => {
    const b = (req.body ?? {}) as { id?: string; name?: string; enabled?: boolean; config?: unknown; accountId?: unknown; groupId?: unknown };
    const name = String(b.name ?? '').trim();
    if (!name) { reply.code(400); return { error: 'name is required' }; }
    // The account a new strategy is made for: the one named (the screen's selected tab), else the one the desk is on.
    let accountId = svc.accountId;
    if (b.accountId !== undefined && b.accountId !== null) {
      const named = Number(b.accountId);
      let known = false;
      try { known = Number.isInteger(named) && brokerAccounts().get(named) !== null; } catch { known = false; }
      if (!known) return refuse(reply, 422, { error: 'No such broker account.', problems: ['No such broker account.'] });
      accountId = named;
    }

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
    // A new one may be made in a group -- one of its own account's. A saved one keeps its group (moved on its own route).
    let groupId: string | null = null;
    if (!existing && b.groupId !== undefined && b.groupId !== null && b.groupId !== '') {
      const g = await s.group(String(b.groupId));
      if (!g) return refuse(reply, 422, { error: 'No such group.', problems: ['No such group.'] });
      if ((g.accountId ?? null) !== (accountId ?? null)) {
        return refuse(reply, 422, { error: 'That group is another account\'s: a strategy is made in a group of its own account.', problems: ['That group is another account\'s.'] });
      }
      groupId = g.id;
    }
    // A saved strategy keeps the account it was made for (the store never rewrites it).
    return { ok: true, strategy: await s.save({ id, name, enabled, config, accountId, groupId }) };
  });

  /**
   * Copy a strategy, settings and all, as a new one that is not armed.
   *
   * The desk's strategies differ from each other in one or two fields --
   * another strike distance, an hour later, a different stop -- and building
   * the second one by hand from the first is how a field gets missed. A copy
   * carries everything and changes two things: the name, and the fact that it
   * is off.
   *
   * **Never armed.** Cloning an armed strategy and leaving it armed would
   * double the position the scheduler takes, at the moment the operator is
   * least expecting it -- they asked for a draft, not a second live rule.
   */
  app.post('/api/strategies/:id/clone', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; id?: string };
    const s = strategyStore();
    const from = await s.get(id);
    if (!from) { reply.code(404); return { error: 'no such strategy' }; }

    const name = String(b.name ?? `${from.name} copy`).trim();
    if (!name) { reply.code(400); return { error: 'name is required' }; }

    // A name already taken gets a number rather than silently overwriting the
    // strategy it collides with: a copy that eats its own source is the worst
    // possible reading of "clone".
    const wanted = b.id ? String(b.id) : idFrom(name);
    let newId = wanted;
    for (let n = 2; await s.get(newId); n++) newId = `${wanted}-${n}`.slice(0, 48);

    return {
      ok: true,
      /*
       * Off, and -- for a signal strategy -- with live orders off too: a copy is a draft to be renamed and
       * changed, and enabling it must not start real orders before it has been looked at (2 Oct 2026).
       */
      strategy: await s.save({
        id: newId, name, enabled: false, accountId: from.accountId ?? null, groupId: from.groupId ?? null,
        config: from.config.trigger === 'signal' ? { ...from.config, liveOrders: false } : from.config,
      }),
    };
  });

  // Switch one strategy on or off.
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

  // Delete a strategy. Its run history stays in strategy_runs.
  app.delete('/api/strategies/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = strategyStore();
    if (!(await s.get(id))) { reply.code(404); return { error: 'no such strategy' }; }
    await s.remove(id);
    return { ok: true };
  });

  // ------------------------------------------------------------ groups (owner, 10 Oct 2026)
  /*
   * A group is one account's way of keeping its strategies: made, renamed, cloned -- to the same account or
   * another -- and removed, and its switch turns every strategy in it on or off. Nothing here changes how a
   * strategy runs: each still trades by its own switch, which is all the group's switch writes. Each answer is
   * the group as it now stands, or the refusal in words.
   */

  /** A group's account, checked: the one named, else the one the desk is on. */
  const groupAccountOf = (raw: unknown): { accountId: number | null } | { error: string } => {
    if (raw === undefined || raw === null || raw === '') return { accountId: svc.accountId };
    const n = Number(raw);
    let known = false;
    try { known = Number.isInteger(n) && brokerAccounts().get(n) !== null; } catch { known = false; }
    return known ? { accountId: n } : { error: 'No such broker account.' };
  };
  /** A fresh id from a name: `g-` and the name's words, numbered when taken. */
  const freshGroupId = async (name: string) => {
    const base = `g-${idFrom(name)}`.slice(0, 44);
    let id = base;
    for (let n = 2; await strategyStore().group(id); n++) id = `${base}-${n}`;
    return id;
  };

  // Make a group, empty, for one account.
  app.post('/api/strategy-groups', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: unknown; accountId?: unknown };
    const name = String(b.name ?? '').trim();
    const bad = groupNameProblem(name);
    if (bad) return refuse(reply, 422, { error: bad, problems: [bad] });
    const acct = groupAccountOf(b.accountId);
    if ('error' in acct) return refuse(reply, 422, { error: acct.error, problems: [acct.error] });
    const s = strategyStore();
    if (await s.groupNameTaken(name, acct.accountId)) {
      const taken = `This account already has a group named "${name}".`;
      return refuse(reply, 409, { error: taken, problems: [taken] });
    }
    return { ok: true, group: named(await s.saveGroup({ id: await freshGroupId(name), name, accountId: acct.accountId })) };
  });

  // Rename a group. Its account and its strategies are not touched.
  app.post('/api/strategy-groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = strategyStore();
    const g = await s.group(id);
    if (!g) { reply.code(404); return { error: 'no such group' }; }
    const name = String(((req.body ?? {}) as { name?: unknown }).name ?? '').trim();
    const bad = groupNameProblem(name);
    if (bad) return refuse(reply, 422, { error: bad, problems: [bad] });
    if (await s.groupNameTaken(name, g.accountId, g.id)) {
      const taken = `This account already has a group named "${name}".`;
      return refuse(reply, 409, { error: taken, problems: [taken] });
    }
    return { ok: true, group: named(await s.saveGroup({ id: g.id, name, accountId: g.accountId })) };
  });

  /*
   * Every strategy of the group on, or off, at once -- each written as its own switch would write it. On is held to
   * the same check as one strategy's switch: a strategy whose settings no longer pass is left off and named, and the
   * rest go on. Off always goes through: what is open keeps its exits, as for one strategy.
   */
  app.post('/api/strategy-groups/:id/enabled', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== 'boolean') { reply.code(400); return { error: 'enabled must be true or false' }; }
    const s = strategyStore();
    const g = await s.group(id);
    if (!g) { reply.code(404); return { error: 'no such group' }; }
    const members = (await s.all()).filter((x) => x.groupId === g.id);
    const changed: string[] = [];
    const leftOff: { id: string; name: string; problems: string[] }[] = [];
    for (const x of members) {
      if (x.enabled === enabled) continue;
      if (enabled) {
        const problems = validateConfig(x.config);
        if (problems.length) { leftOff.push({ id: x.id, name: x.name, problems }); continue; }
      }
      await s.setEnabled(x.id, enabled);
      changed.push(x.id);
    }
    return { ok: true, group: named(g), changed, leftOff };
  });

  /*
   * The display order (owner, 10 Oct 2026: "change the strategy list's display order"). Of one group's strategies
   * (`/:id/order`), or of one account's groups (`/order`): the whole list, in the order wanted. A list that is not
   * exactly the group's -- one added or moved since the screen read it -- is refused, so nothing is half-ordered.
   * Display only: the runner reads the strategies in its own order, as before.
   */
  const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));
  const CHANGED = 'The list changed while it was being ordered: it has been read again. Order it once more.';
  app.post('/api/strategy-groups/order', async (req, reply) => {
    const b = (req.body ?? {}) as { accountId?: unknown; groupIds?: unknown };
    const ids = Array.isArray(b.groupIds) ? b.groupIds.map(String) : null;
    if (!ids) return refuse(reply, 400, { error: 'groupIds must be a list', problems: ['groupIds must be a list'] });
    const acct = groupAccountOf(b.accountId);
    if ('error' in acct) return refuse(reply, 422, { error: acct.error, problems: [acct.error] });
    const s = strategyStore();
    const theirs = (await s.groups()).filter((g) => (g.accountId ?? null) === acct.accountId).map((g) => g.id);
    if (!sameSet(ids, theirs)) return refuse(reply, 409, { error: CHANGED, problems: [CHANGED] });
    await s.setOrder('strategy_groups', ids);
    return { ok: true };
  });
  app.post('/api/strategy-groups/:id/order', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { strategyIds?: unknown };
    const ids = Array.isArray(b.strategyIds) ? b.strategyIds.map(String) : null;
    if (!ids) return refuse(reply, 400, { error: 'strategyIds must be a list', problems: ['strategyIds must be a list'] });
    const s = strategyStore();
    if (!(await s.group(id))) { reply.code(404); return { error: 'no such group' }; }
    const members = (await s.all()).filter((x) => x.groupId === id).map((x) => x.id);
    if (!sameSet(ids, members)) return refuse(reply, 409, { error: CHANGED, problems: [CHANGED] });
    await s.setOrder('strategies', ids);
    return { ok: true };
  });

  /*
   * Which group each strategy is in, every account's (owner, 10 Oct 2026: "wherever a strategy's name is, its group's
   * name as a tag -- desk and phone"). Small on purpose: read by every screen that names a strategy -- positions,
   * orders, history, a trade -- whichever account they show, and the strategies' own read is many times this.
   */
  app.get('/api/strategy-groups/index', async () => {
    const s = strategyStore();
    const of: Record<string, string> = {};
    for (const x of await s.all()) if (x.groupId) of[x.id] = x.groupId;
    return { groups: (await s.groups()).map((g) => ({ id: g.id, name: g.name, accountId: g.accountId, accountName: accountNameOf(g.accountId) })), of };
  });

  /*
   * Strategies copied into a group (owner, 10 Oct 2026: "from another account's, another group's, into a new group or
   * an existing one"). Any strategies, of any account and group, into one group: one that exists (`groupId`), or one
   * made for it (`newGroup: { name, accountId }`). Each copy belongs to the group's account, switched off, a signal
   * strategy's with live orders off -- as every copy. It keeps its name unless the account has one by that name
   * already: then "<name> copy" (" copy 2", ...). All or nothing: one transaction, everything checked first.
   */
  app.post('/api/strategy-groups/copy-in', async (req, reply) => {
    const b = (req.body ?? {}) as { strategyIds?: unknown; groupId?: unknown; newGroup?: { name?: unknown; accountId?: unknown } | null };
    const no = (code: number, error: string) => refuse(reply, code, { error, problems: [error] });
    const ids = Array.isArray(b.strategyIds) ? [...new Set(b.strategyIds.map(String))] : [];
    if (ids.length === 0) return no(422, 'Pick at least one strategy to copy.');
    if (ids.length > 100) return no(422, 'At most 100 strategies at once.');
    if ((b.groupId === undefined || b.groupId === null) === !b.newGroup) return no(422, 'Copy into one group: an existing one or a new one.');
    const s = strategyStore();
    const all = await s.all();
    const from = ids.map((id) => all.find((x) => x.id === id));
    const missing = ids.filter((_, i) => !from[i]);
    if (missing.length) return no(422, `No such strateg${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}.`);

    let target: { groupId: string; accountId: number | null; newGroup: { id: string; name: string; accountId: number | null } | null };
    if (b.newGroup) {
      const name = String(b.newGroup.name ?? '').trim();
      const bad = groupNameProblem(name);
      if (bad) return no(422, bad);
      const acct = groupAccountOf(b.newGroup.accountId);
      if ('error' in acct) return no(422, acct.error);
      if (await s.groupNameTaken(name, acct.accountId)) return no(409, `That account already has a group named "${name}".`);
      const id = await freshGroupId(name);
      target = { groupId: id, accountId: acct.accountId, newGroup: { id, name, accountId: acct.accountId } };
    } else {
      const g = await s.group(String(b.groupId));
      if (!g) { reply.code(404); return { error: 'no such group' }; }
      target = { groupId: g.id, accountId: g.accountId, newGroup: null };
    }

    // Names: the account's own, and each copy's as it is named, so two copies of one name are told apart too.
    const names = new Set(all.filter((x) => (x.accountId ?? null) === target.accountId).map((x) => x.name.trim().toLowerCase()));
    const takenIds = new Set(all.map((x) => x.id));
    const copies = from.map((x) => {
      let name = x!.name;
      for (let n = 1; names.has(name.trim().toLowerCase()); n++) name = `${x!.name} copy${n > 1 ? ` ${n}` : ''}`;
      names.add(name.trim().toLowerCase());
      const wanted = idFrom(name);
      let id = wanted;
      for (let n = 2; takenIds.has(id); n++) id = `${wanted}-${n}`.slice(0, 48);
      takenIds.add(id);
      return { id, name, config: x!.config.trigger === 'signal' ? { ...x!.config, liveOrders: false } : x!.config };
    });
    const made = await s.copyIn({ newGroup: target.newGroup, groupId: target.groupId, accountId: target.accountId, copies });
    const group = (await s.group(target.groupId))!;
    return { ok: true, group: named(group), strategies: await Promise.all(made.map(async (id) => (await s.get(id))!)) };
  });

  /*
   * A copy of the group and every strategy in it -- to the same account, or to another (owner: "account 1 and 2,
   * shuffle"). Every copy is made switched off, and a signal strategy's with live orders off: a copied group is a
   * draft to look over, never a second set of orders. On the same account a copy is named "<name> copy"; on another
   * account it keeps its name, the account telling the two apart.
   */
  app.post('/api/strategy-groups/:id/clone', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: unknown; accountId?: unknown };
    const s = strategyStore();
    const from = await s.group(id);
    if (!from) { reply.code(404); return { error: 'no such group' }; }
    const acct = b.accountId === undefined || b.accountId === null || b.accountId === '' ? { accountId: from.accountId } : groupAccountOf(b.accountId);
    if ('error' in acct) return refuse(reply, 422, { error: acct.error, problems: [acct.error] });
    const sameAccount = (acct.accountId ?? null) === (from.accountId ?? null);
    const name = String(b.name ?? (sameAccount ? `${from.name} copy` : from.name)).trim();
    const bad = groupNameProblem(name);
    if (bad) return refuse(reply, 422, { error: bad, problems: [bad] });
    if (await s.groupNameTaken(name, acct.accountId)) {
      const taken = `${sameAccount ? 'This' : 'That'} account already has a group named "${name}".`;
      return refuse(reply, 409, { error: taken, problems: [taken] });
    }
    const group = await s.saveGroup({ id: await freshGroupId(name), name, accountId: acct.accountId });
    const copies: Strategy[] = [];
    for (const x of (await s.all()).filter((y) => y.groupId === from.id)) {
      const copyName = sameAccount ? `${x.name} copy` : x.name;
      const wanted = idFrom(copyName);
      let newId = wanted;
      for (let n = 2; await s.get(newId); n++) newId = `${wanted}-${n}`.slice(0, 48);
      copies.push(await s.save({
        id: newId, name: copyName, enabled: false, accountId: acct.accountId, groupId: group.id,
        config: x.config.trigger === 'signal' ? { ...x.config, liveOrders: false } : x.config,
      }));
    }
    return { ok: true, group: named(group), strategies: copies };
  });

  // Remove a group. Its strategies stay -- switch, settings and all -- in no group.
  app.delete('/api/strategy-groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = strategyStore();
    if (!(await s.group(id))) { reply.code(404); return { error: 'no such group' }; }
    return { ok: true, ungrouped: await s.removeGroup(id) };
  });

  // Move a strategy into a group of its own account, or out of any (`groupId` null).
  app.post('/api/strategies/:id/group', async (req, reply) => {
    const { id } = req.params as { id: string };
    const raw = ((req.body ?? {}) as { groupId?: unknown }).groupId;
    const s = strategyStore();
    const x = await s.get(id);
    if (!x) { reply.code(404); return { error: 'no such strategy' }; }
    if (raw === null || raw === undefined || raw === '') return { ok: true, strategy: await s.setGroup(id, null) };
    const g: StrategyGroup | null = await s.group(String(raw));
    if (!g) return refuse(reply, 422, { error: 'No such group.', problems: ['No such group.'] });
    if ((g.accountId ?? null) !== (x.accountId ?? null)) {
      const other = 'That group is another account\'s: a strategy goes in a group of its own account (clone the group to the other account instead).';
      return refuse(reply, 422, { error: other, problems: [other] });
    }
    return { ok: true, strategy: await s.setGroup(id, g.id) };
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

  // The desk-wide "at most open at once": one number over every strategy; 0 takes the cap off.
  app.post('/api/strategies/max-open', async (req, reply) => {
    const { max, accountId } = (req.body ?? {}) as { max?: unknown; accountId?: unknown };
    // The cap is one account's (5 Oct 2026): the account named -- the screen's tab -- else the one the desk is on.
    const account = accountOf({ account: accountId === undefined || accountId === null ? undefined : String(accountId) }) ?? svc.accountId;
    // Held to what that account's strategies, switched on, allow between them: a cap above that can never bind.
    const its = (await strategyStore().all()).filter((x) => belongs(x, account));
    const problem = globalMaxOpenProblem(max, signalEntriesAllowed(its));
    if (problem) return refuse(reply, 422, { error: problem, problems: [problem] });
    await svc.settings.set(accountKey(GLOBAL_MAX_OPEN_KEY, account), String(max));
    return { ok: true, signalMaxOpen: max as number };
  });

  /** The run journal on its own, for the history panel. */
  app.get('/api/strategies/runs', async (req) => {
    const runs = await strategyStore().runs(200);
    const mine = await ofAccount(accountOf(req.query));
    return { runs: mine ? runs.filter((r) => mine.has(r.strategyId)) : runs };
  });
}
