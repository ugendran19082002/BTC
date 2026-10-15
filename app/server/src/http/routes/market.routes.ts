import type { FastifyInstance } from 'fastify';
import { tradingService } from '../../trading/service.js';
import { sessionDayOf } from '../../report/market-day.js';
import { REPORT_FIRST_DAY, REPORT_MAX_DAYS, marketBreakdown, marketReport, type ReportFilters } from '../../report/market-report.js';
import { DEFAULT_PARAMS, MIN_PREMIUM, backtestable, strategyCaveats, type BacktestParams } from '../../report/signal-backtest.js';
import { rows } from '../../db/pool.js';
import { methodsSchema } from '../../entry/catalogue.js';
import { liveCheck, signalBacktest, signalBacktestTrades } from '../../report/backtest-run.js';
import { cleanConfig, strategyStore } from './strategy.routes.js';
import { GLOBAL_MAX_OPEN_KEY, SIDE_MAX_KEYS, actionOf, exitRules, globalMaxOpenOf, noEntryProblems, ruleTfs, sideMaxOf, validateConfig, type Strategy } from '../../strategy/types.js';
import { accountSetting } from '../../db/settings.js';
import { brokerAccounts } from '../../delta/accounts.js';
import { refuse } from '../refuse.js';
import { accountOf } from '../account-query.js';

/**
 * The market report (13 Oct 2026): every expiry day -- 5:30 PM IST to 5:30 PM IST -- with the kind of day the
 * BTC perp had, and what the signal history and the real orders made on it. Read-only.
 *
 * `?from=&to=` are expiry days (YYYY-MM-DD, the day the contract settles); without them, from 1 Oct 2026 to the
 * day in progress. `?account=` is one broker account's orders (the signal history has no account). `?tf=`,
 * `?method=` and `?strategy=` keep only those timeframes (`chain` for the timeframe chain), entry methods and
 * strategies; a strategy narrows the real orders only.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function rangeOf(q: { from?: unknown; to?: unknown }, now = Date.now()): { from: string; to: string } | string {
  const today = sessionDayOf(now);
  const from = q.from === undefined || q.from === '' ? REPORT_FIRST_DAY : String(q.from);
  const to = q.to === undefined || q.to === '' ? today : String(q.to);
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return 'Dates must be YYYY-MM-DD.';
  if (from > to) return 'The start date must not be after the end date.';
  if (Date.parse(to) - Date.parse(from) > REPORT_MAX_DAYS * 86_400_000) return `At most ${REPORT_MAX_DAYS} days at a time.`;
  return { from, to };
}

function listOf(q: unknown, name: 'tf' | 'method' | 'strategy'): string[] | null {
  const raw = (q as Record<string, unknown> | null | undefined)?.[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const keys = [...new Set(raw.split(',').map((k) => k.trim()).filter((k) => k !== '' && k.length <= 120))].slice(0, 200);
  return keys.length ? keys : null;
}
/** The report itself is not filtered any more (13 Oct 2026); the backtest still reads one strategy's orders through the same sums. */
const NO_FILTERS: ReportFilters = { account: null, tfs: null, methods: null, strategies: null };

/**
 * The backtest's settings, checked: `?rule=delta|premium`, `?value=` (a delta from 0.02 to 0.5, or a premium from
 * 10 to 500 dollars), `?lots=` (1 to 1,000), `?tp=` and `?sl=` (the option's own target and stop as shares of the
 * premium; 0 is none), `?window=desk|all`. Absent ones are the defaults.
 */
/**
 * Each trading account's signal strategies that sell, with its limit on open trades as it stands: the desk's side
 * of a live check (`liveCheckHere`), which works an account's strategies together under that limit.
 */
export async function liveAccounts(): Promise<{ id: number | null; name: string | null; caps: { deskMax: number; cePct: number; pePct: number } | null; strategies: Strategy[] }[]> {
  const every = (await strategyStore().all().catch(() => [])).filter(backtestable);
  const svc = tradingService();
  const nameOf = (id: number | null) => { try { return id == null ? null : brokerAccounts().get(id)?.name ?? null; } catch { return null; } };
  return [...new Set(every.map((s) => s.accountId ?? null))].map((id) => {
    const max = globalMaxOpenOf(accountSetting(svc.settings, GLOBAL_MAX_OPEN_KEY, id));
    return {
      id, name: nameOf(id),
      caps: max > 0 ? { deskMax: max, cePct: sideMaxOf(accountSetting(svc.settings, SIDE_MAX_KEYS.CE, id)), pePct: sideMaxOf(accountSetting(svc.settings, SIDE_MAX_KEYS.PE, id)) } : null,
      strategies: every.filter((s) => (s.accountId ?? null) === id),
    };
  });
}

export function backtestParamsOf(q: Record<string, unknown>): BacktestParams | string {
  const num = (name: string, fallback: number) => (q[name] === undefined || q[name] === '' ? fallback : Number(q[name]));
  const rule = q.rule === undefined || q.rule === '' ? DEFAULT_PARAMS.rule : q.rule;
  if (rule !== 'delta' && rule !== 'premium') return 'The strike rule is "delta" or "premium".';
  const value = num('value', rule === 'delta' ? 0.1 : 50);
  if (rule === 'delta' ? !(value >= 0.02 && value <= 0.5) : !(value >= 10 && value <= 500)) {
    return rule === 'delta' ? 'A delta limit is from 0.02 to 0.5.' : 'A premium limit is from 10 to 500 dollars.';
  }
  const lots = num('lots', DEFAULT_PARAMS.lots);
  if (!Number.isInteger(lots) || lots < 1 || lots > 1_000) return 'Lots are a whole number from 1 to 1,000.';
  const targetPct = num('tp', DEFAULT_PARAMS.targetPct), stopPct = num('sl', DEFAULT_PARAMS.stopPct);
  if (!(targetPct >= 0 && targetPct <= 0.99)) return 'The option target is a share of the premium from 0 (none) to 0.99.';
  if (!(stopPct >= 0 && stopPct <= 10)) return 'The option stop is a share of the premium from 0 (none) to 10.';
  const window = q.window === undefined || q.window === '' ? DEFAULT_PARAMS.window : q.window;
  if (window !== 'desk' && window !== 'all' && window !== 'custom') return 'The window is "desk", "all" or "custom".';
  // Custom hours: `?hfrom=22:00&hto=02:00`, IST, the end not included.
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const hoursFrom = typeof q.hfrom === 'string' ? q.hfrom : '', hoursTo = typeof q.hto === 'string' ? q.hto : '';
  if (window === 'custom' && (!hhmm.test(hoursFrom) || !hhmm.test(hoursTo))) return 'Custom hours are a From and a To time, HH:MM (IST).';
  if (window === 'custom' && hoursFrom === hoursTo) return 'The From and To times must differ.';
  // The desk's own limits, as the Signal Strategies card sets them: at most open 0 (none) to 500; each side 1 to 100%.
  const deskMax = num('max', 0), cePct = num('ce', 100), pePct = num('pe', 100);
  if (!Number.isInteger(deskMax) || deskMax < 0 || deskMax > 500) return 'At most open is a whole number from 0 (no limit) to 500.';
  if (!(cePct >= 1 && cePct <= 100) || !(pePct >= 1 && pePct <= 100)) return 'CE max and PE max are from 1% to 100%.';
  // The SL and TGT range, in BTC points: `?slmin=&slmax=&tgtmin=&tgtmax=`, 0 off.
  const slMin = num('slmin', 0), slMax = num('slmax', 0), tgtMin = num('tgtmin', 0), tgtMax = num('tgtmax', 0);
  for (const v of [slMin, slMax, tgtMin, tgtMax]) if (!(v >= 0 && v <= 20_000)) return 'An SL or TGT distance is from 0 (off) to 20,000 points.';
  if (slMin > 0 && slMax > 0 && slMax < slMin) return 'The SL maximum must not be under its minimum.';
  if (tgtMin > 0 && tgtMax > 0 && tgtMax < tgtMin) return 'The TGT maximum must not be under its minimum.';
  /*
   * A target by the clock: `?tsteps=23:30:73,01:30:76` -- from each IST time, that per cent of the premium kept;
   * `tp` is where it starts. Up to 24 steps, each time once, each 1 to 99%. Absent: the one target all day.
   */
  const targetSteps: { at: string; pct: number }[] = [];
  if (typeof q.tsteps === 'string' && q.tsteps.trim() !== '') {
    for (const part of q.tsteps.split(',')) {
      const m = /^(([01]\d|2[0-3]):[0-5]\d):(\d{1,2}(?:\.\d+)?)$/.exec(part.trim());
      if (!m) return 'A target step is a time and a per cent, HH:MM:NN -- for example 23:30:73.';
      const pc = Number(m[3]);
      if (!(pc >= 1 && pc <= 99)) return 'A target step keeps from 1% to 99% of the premium.';
      targetSteps.push({ at: m[1]!, pct: Math.round(pc * 100) / 10_000 });
    }
    if (targetSteps.length > 24) return 'At most 24 target steps.';
    if (new Set(targetSteps.map((x) => x.at)).size !== targetSteps.length) return 'Two target steps have the same time.';
    if (!(targetPct > 0)) return 'A target by the clock needs a target to start from.';
  }
  // The volatility when a signal fills: `?vol=off|low|medium|high`.
  const vol = q.vol === undefined || q.vol === '' ? 'off' : q.vol;
  if (vol !== 'off' && vol !== 'low' && vol !== 'medium' && vol !== 'high') return 'The volatility filter is "off", "low", "medium" or "high".';
  // The least premium an option is sold for: `?minprem=`, dollars, 0 for no floor. Absent: 10.
  const minPremium = num('minprem', MIN_PREMIUM);
  if (!(minPremium >= 0 && minPremium <= 500)) return 'The minimum premium is from 0 (no floor) to 500 dollars.';
  /*
   * No-entry windows: `?noentry=00:30-01:30,03:00-04:00`, IST, from (taken) until (not). Held to the strategy form's
   * own rules (`noEntryProblems`) against these settings' hours: each inside them, none all of them, no overlaps.
   */
  let noEntry: { on: boolean; windows: { from: string; to: string }[] } | undefined;
  if (typeof q.noentry === 'string' && q.noentry.trim() !== '') {
    const windows = q.noentry.split(',').map((x) => { const [from = '', to = ''] = x.trim().split('-'); return { from, to }; });
    const [entry, exit] = window === 'desk' ? ['21:30', '15:59'] : window === 'custom' ? [hoursFrom, hoursTo] : ['17:30', '17:25'];
    const bad = noEntryProblems({ on: true, windows }, entry, exit, true);
    if (bad.length) return bad[0]!.replace("this strategy's", 'the hours\'').replace('Switch the strategy off instead.', 'Take the window off instead.');
    noEntry = { on: true, windows };
  }
  return {
    rule, value, lots, targetPct, stopPct, window, deskMax, cePct, pePct, slMin, slMax, tgtMin, tgtMax, vol, minPremium,
    ...(window === 'custom' ? { hoursFrom, hoursTo } : {}), ...(targetSteps.length ? { targetSteps } : {}), ...(noEntry ? { noEntry } : {}),
  };
}

/** A set of settings as an object -- a saved one -- held to the same rules as one in a query string. */
export function backtestParamsFrom(p: unknown): BacktestParams | string {
  if (!p || typeof p !== 'object') return 'A backtest\'s settings are needed.';
  const x = p as Partial<BacktestParams>;
  return backtestParamsOf({
    rule: x.rule, value: x.value, lots: x.lots, tp: x.targetPct, sl: x.stopPct, window: x.window, hfrom: x.hoursFrom, hto: x.hoursTo,
    max: x.deskMax, ce: x.cePct, pe: x.pePct, slmin: x.slMin, slmax: x.slMax, tgtmin: x.tgtMin, tgtmax: x.tgtMax, vol: x.vol, minprem: x.minPremium,
    tsteps: Array.isArray(x.targetSteps) && x.targetSteps.length ? x.targetSteps.map((s) => `${s.at}:${Math.round(s.pct * 10_000) / 100}`).join(',') : undefined,
    // Kept off with its times, as the form keeps them; only an on switch is a rule.
    noentry: x.noEntry?.on && Array.isArray(x.noEntry.windows) ? x.noEntry.windows.map((w) => `${w.from}-${w.to}`).join(',') : undefined,
  });
}

/** A strategy's option target as the backtest's settings take one: where it starts and its time steps, or null where it is not a per cent. */
function targetOf(s: Strategy): { pct: number; steps: { at: string; pct: number }[] } | null {
  const t = exitRules(s.config).target;
  return t.mode === 'pct' && t.value > 0 ? { pct: t.value, steps: t.steps.map((x) => ({ at: x.at, pct: x.value })) } : null;
}

export function registerMarketRoutes(app: FastifyInstance) {
  /**
   * The signal history traded as options on the contracts' own recorded prices (13 Oct 2026): every signal in the
   * trade, an option sold at its fill and bought back at the perp's stop or target, the option's own target or
   * stop, or the window's end. `?from=&to=` are expiry days; `?tf=` and `?method=` narrow it. Read-only, and it
   * takes every signal: no limit on what is open.
   */
  app.get('/api/signal-backtest', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    /*
     * `?strategy=<id>`: backtest by that saved strategy's own rules instead of the screen's settings (owner, 13 Oct
     * 2026: "a strategy list in the backtest -- choose one and backtest by it, else don't"). The list to choose from
     * comes back with every answer: the signal strategies that sell, each with its account.
     */
    const every = (await strategyStore().all().catch(() => [])).filter(backtestable);
    const askedId = typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null;
    const strategy = askedId === null ? null : every.find((s) => s.id === askedId) ?? null;
    if (askedId !== null && !strategy) return refuse(reply, 404, { error: 'No such signal strategy to backtest: it may have been deleted, or it buys rather than sells.' });
    const accountName = (id: number | null | undefined) => { try { return id == null ? null : brokerAccounts().get(id)?.name ?? null; } catch { return null; } };
    const result = await signalBacktest({ ...r, now: Date.now(), params, tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategy, spot: tradingService().spot });
    // Each trading account's own limits as they stand, for the screen to offer as one tap.
    const svc = tradingService();
    let deskLimits: { account: string; max: number; ce: number; pe: number }[] = [];
    try {
      deskLimits = brokerAccounts().list().filter((a) => a.active).map((a) => ({
        account: a.name,
        max: globalMaxOpenOf(accountSetting(svc.settings, GLOBAL_MAX_OPEN_KEY, a.id)),
        ce: sideMaxOf(accountSetting(svc.settings, SIDE_MAX_KEYS.CE, a.id)),
        pe: sideMaxOf(accountSetting(svc.settings, SIDE_MAX_KEYS.PE, a.id)),
      })).filter((x) => x.max > 0);
    } catch { /* no account set up: none to offer */ }
    return {
      ...result,
      deskLimits,
      // With its methods and timeframes, so the screen can tick a strategy's methods for the settings (`chain`: the timeframe chain).
      strategies: every.map((s) => ({
        id: s.id, name: s.name, enabled: s.enabled, account: accountName(s.accountId),
        methods: [...s.config.signal!.methods], tfs: s.config.signal!.mode === 'mtf' ? ['chain'] : [...ruleTfs(s.config.signal!)],
        // Its option target and time steps, for the screen to copy into a dynamic target (per cent of the premium kept).
        target: targetOf(s),
      }))
        .sort((a, b) => (a.account ?? '').localeCompare(b.account ?? '') || a.name.localeCompare(b.name, 'en', { numeric: true })),
    };
  });

  /**
   * The backtest's trades, one by one (owner, 14 Oct 2026: "tap the count -- each trade's entry, exit, SL, TGT,
   * points and money"; 15 Oct: "by session too"): asked as the backtest itself is, and narrowed by `?day=` (one of
   * its expiry days), `?sfrom=&sto=` (a session of the day, fifteen-minute slots, both in) and `?smethod=` (one
   * method). Each day is played again as its row was. Read-only.
   */
  app.get('/api/signal-backtest/trades', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    // Which trades (`TradePick`): one of its days, or all; a session of the day as fifteen-minute slots; one method.
    const day = typeof q.day === 'string' && q.day !== '' ? q.day : null;
    if (day !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < r.from || day > r.to)) return refuse(reply, 400, { error: 'The day is one of the expiry days asked for, as YYYY-MM-DD.' });
    const slot = (k: string) => (q[k] === undefined || q[k] === '' ? null : Number(q[k]));
    const slotFrom = slot('sfrom'), slotTo = slot('sto');
    if ([slotFrom, slotTo].some((x) => x !== null && !(Number.isInteger(x) && x >= 0 && x <= 95))) return refuse(reply, 400, { error: 'A session is fifteen-minute slots from 0 (5:30 PM) to 95.' });
    const pick = { day, slotFrom, slotTo, method: typeof q.smethod === 'string' && q.smethod !== '' ? q.smethod : null };
    const askedId = typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null;
    const strategy = askedId === null ? null : (await strategyStore().all().catch(() => [])).filter(backtestable).find((s) => s.id === askedId) ?? null;
    if (askedId !== null && !strategy) return refuse(reply, 404, { error: 'No such signal strategy to backtest: it may have been deleted, or it buys rather than sells.' });
    return signalBacktestTrades({ ...r, now: Date.now(), params, tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategy, spot: tradingService().spot }, pick);
  });

  /**
   * The backtest against the live desk, signal for signal (owner, 14 Oct 2026: "the real trades since 9:30 last
   * night and the backtest's do not match in number"): every signal strategy that sells, backtested by its own
   * rules -- an account's strategies together under that account's limit, as the desk holds them -- and laid
   * beside the desk's record of what it did with the same signals. Asked as the single backtest is, so it is the
   * check of what is on the screen: `?strategy=<id>`, that strategy's own rules against its own record; else the
   * screen's settings and filters, as one book, against what the desk did with each signal under any strategy;
   * `?all=1`, every strategy by its own rules. `?from=&to=` are expiry days. Read-only.
   */
  app.get('/api/signal-backtest/live-check', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const accounts = await liveAccounts();
    const askedId = typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null;
    const base = { ...r, now: Date.now(), spot: tradingService().spot, accounts };
    // By a strategy: its own rules against its own record, worked with its account's other strategies as the desk holds them.
    if (askedId !== null) {
      if (!accounts.some((a) => a.strategies.some((s) => s.id === askedId))) return refuse(reply, 404, { error: 'No such signal strategy to check: it may have been deleted, or it buys rather than sells.' });
      return liveCheck({ ...base, only: [askedId] });
    }
    // Every strategy's own rules: asked for with nothing else.
    if (q.all === '1') return liveCheck(base);
    // The settings on the screen, as the single backtest reads them: one book, against what the desk did under any strategy.
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    return liveCheck({
      ...base,
      portfolio: { name: 'these settings', shared: (params.deskMax ?? 0) > 0 ? { deskMax: params.deskMax!, cePct: params.cePct ?? 100, pePct: params.pePct ?? 100 } : null, members: [{ id: 'screen', name: 'These settings', ask: { params, tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategy: null } }] },
    });
  });

  /**
   * Every method's record as options under a strategy's rules as they stand on the form (owner, 13 Oct 2026: "in
   * the strategy form the signal filter's profit and loss must be by the option's TGT and SL, not the perp's --
   * now it is the perp's"). The body is the form's own draft (`{ config }`), saved or not. Each method is tried
   * on every one of its signals in the strategy's way and timeframes -- not only the methods ticked, and with no
   * "at most open", so one method's place is not taken by another's -- sold as the strategy would sell it (its
   * strike rule at each hour, its lots, its hours and no-entry window, its SL / TGT distances) and bought back as
   * it would buy it back: the perp at the signal's stop or its target, or the option at its own target or stop
   * first. The money is the option's, after charges. Read-only; nothing is saved.
   */
  app.post('/api/signal-backtest/methods', async (req, reply) => {
    const body = (req.body ?? {}) as { config?: unknown; from?: unknown; to?: unknown };
    const raw = body.config;
    if (!raw || typeof raw !== 'object') return refuse(reply, 400, { error: 'A strategy\'s settings are needed: { config }.' });
    await methodsSchema();
    const every = (await rows<{ id: string }>('SELECT id FROM entry_methods ORDER BY id')).map((m) => m.id);
    const asked = cleanConfig(raw);
    if (asked.trigger !== 'signal' || !asked.signal) return refuse(reply, 422, { error: 'Only a signal strategy has methods to give a record.', problems: ['Only a signal strategy has methods to give a record.'] });
    if (actionOf(asked.signal) !== 'sell') {
      const why = 'A record as options is worked out for strategies that sell; one that buys is shown on the perp\'s points.';
      return refuse(reply, 422, { error: why, problems: [why] });
    }
    // Every method, whichever are ticked; and (`draft` below) each on all its signals, with no place for one to take from another.
    const config = { ...asked, signal: { ...asked.signal, methods: every } };
    const problems = validateConfig(config);
    if (problems.length) return refuse(reply, 422, { error: problems.join(' '), problems });
    const now = Date.now();
    // `from` and `to` (expiry days) where they are given; else from the report's first day, and no further back
    // than the days the backtest keeps ready.
    let from: string, to: string;
    if (body.from !== undefined || body.to !== undefined) {
      const given = rangeOf({ from: body.from, to: body.to }, now);
      if (typeof given === 'string') return refuse(reply, 400, { error: given });
      ({ from, to } = given);
    } else {
      to = sessionDayOf(now);
      const earliest = new Date(Date.parse(`${to}T00:00:00Z`) - 44 * 86_400_000).toISOString().slice(0, 10);
      from = earliest > REPORT_FIRST_DAY ? earliest : REPORT_FIRST_DAY;
    }
    const draft: Strategy = { id: 'draft', name: 'draft', enabled: false, config, accountId: null, createdAt: now, updatedAt: now };
    const r = await signalBacktest({ from, to, now, params: { ...DEFAULT_PARAMS }, tfs: null, methods: null, strategy: draft, draft: true, spot: tradingService().spot });
    type Rec = { trades: number; wins: number; net: number };
    const by = new Map<string, Rec & { method: string; byTf: (Rec & { tf: string })[] }>();
    for (const p of r.pairs) {
      // A pair's key is its method, its way and its timeframe; with the chain the timeframe is the chain itself.
      const [method, mode, tf] = p.key.split('|') as [string, string, string];
      let m = by.get(method);
      if (!m) { m = { method, trades: 0, wins: 0, net: 0, byTf: [] }; by.set(method, m); }
      m.trades += p.n; m.wins += p.wins; m.net += p.net;
      m.byTf.push({ tf: mode === 'mtf' ? 'chain' : tf, trades: p.n, wins: p.wins, net: p.net });
    }
    return {
      from, to, priced: r.priced, caveats: strategyCaveats(draft),
      signals: r.signals, trades: r.total.n,
      methods: [...by.values()].sort((a, b) => b.net - a.net),
    };
  });

  /** Each expiry day with its figures, its kind and both records' totals. `?account=` is one broker account's orders. */
  app.get('/api/market-report', async (req, reply) => {
    const r = rangeOf((req.query ?? {}) as { from?: unknown; to?: unknown });
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    return marketReport({ ...r, now: Date.now(), spot: tradingService().spot, ...NO_FILTERS, account: accountOf(req.query) });
  });

  /** One expiry day opened (`?day=`): both records by pair, timeframe, method and strategy. */
  app.get('/api/market-report/breakdown', async (req, reply) => {
    const day = (req.query as { day?: unknown } | null)?.day;
    if (typeof day !== 'string' || !DAY.test(day) || Number.isNaN(Date.parse(day))) return refuse(reply, 400, { error: 'Day must be YYYY-MM-DD.' });
    return marketBreakdown({ from: day, to: day, now: Date.now(), spot: tradingService().spot, day, ...NO_FILTERS, account: accountOf(req.query) });
  });
}
