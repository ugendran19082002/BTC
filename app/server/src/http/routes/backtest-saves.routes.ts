import type { FastifyInstance } from 'fastify';
import { tradingService } from '../../trading/service.js';
import {
  PORTFOLIO_MEMBERS_MAX, clonePortfolio, cloneSave, dropPortfolio, dropSave, groupProblem, keepPortfolio, keepSave, listSaves, nameProblem, renameGroup, savesByIds, type SavedQuery,
} from '../../report/backtest-saves.js';
import { DEFAULT_PARAMS, type BacktestParams } from '../../report/signal-backtest.js';
import { liveCheck, portfolioBacktest, portfolioSessionStudy, portfolioSessionStudyTrades, portfolioTrades, portfolioVolStudy, portfolioVolStudyTrades, signalBacktest, winSweep, winSweepTrades } from '../../report/backtest-run.js';
import { pickMethods } from '../../strategy/auto-methods.js';
import { backtestParamsFrom, backtestParamsOf, backtestStrategies, liveAccounts, rangeOf, sessionRuleOf, sessionTradesPickOf, sweepBarsOf, sweepCellOf, volRuleOf, volTradesPickOf, winDaysOf } from './market.routes.js';
import { refuse } from '../refuse.js';

/**
 * Backtests kept by name, and run together (owner, 13 Oct 2026: "save a backtest's settings, run a saved one;
 * several saved as a portfolio, and the total of them all"). The store is `report/backtest-saves.ts`; a saved
 * backtest is settings, never a result, and is held to the same rules as settings typed on the screen.
 */

const keys = (raw: unknown, most: number): string[] =>
  (Array.isArray(raw) ? [...new Set(raw.map((x) => String(x).trim()).filter((x) => x !== '' && x.length <= 120))].slice(0, most) : []);

/** What is kept of a query: the settings checked, the filters as lists, the strategy as an id. Or why not, in words. */
function savedQueryOf(raw: unknown): SavedQuery | string {
  const q = (raw ?? {}) as { params?: unknown; tfs?: unknown; methods?: unknown; strategy?: unknown };
  const params = backtestParamsFrom(q.params);
  if (typeof params === 'string') return params;
  return { params, tfs: keys(q.tfs, 20), methods: keys(q.methods, 200), strategy: typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null };
}

/**
 * A run together as it is asked for in a query: the days, the saved backtests, whose limit, and the hours and the
 * settings put over the run. Read in one place because two things are asked with it -- the run itself, and the
 * same run laid beside the live desk (`/api/backtest-portfolio/live-check`) -- and they must mean the same run.
 * Or why it cannot be meant, with the status to refuse it by.
 */
async function portfolioQuery(q: Record<string, unknown>) {
    const runDays = rangeOf(q);
    if (typeof runDays === 'string') return { code: 400, error: runDays };
    // The days the run is on: those asked, less the first ones where methods by win % are picked on them (`first`).
    let r = runDays;
    const ids = keys(typeof q.ids === 'string' ? q.ids.split(',') : [], PORTFOLIO_MEMBERS_MAX + 1);
    if (ids.length === 0) return { code: 400, error: 'Which saved backtests: ?ids=a,b.' };
    if (ids.length > PORTFOLIO_MEMBERS_MAX) return { code: 400, error: `At most ${PORTFOLIO_MEMBERS_MAX} saved backtests at once.` };
    const saves = await savesByIds(ids);
    if (saves.length !== ids.length) return { code: 404, error: 'One of those saved backtests is gone: it may have been deleted.' };
    const strategies = await backtestStrategies();
    if (q.limit !== undefined && q.limit !== '' && q.limit !== 'shared' && q.limit !== 'own') return { code: 400, error: 'The limit is "shared" (one account) or "own" (each its own).' };
    let shared: { deskMax: number; cePct: number; pePct: number; strikePct?: number; strikeFull?: 'next' | 'skip' } | null = null;
    if (q.limit !== 'own') {
      const num = (v: unknown) => (v === undefined || v === '' ? null : Number(v));
      const max = num(q.max), ce = num(q.ce), pe = num(q.pe);
      if (max !== null) {
        if (!Number.isInteger(max) || max < 1 || max > 500) return { code: 400, error: 'At most open is a whole number from 1 to 500.' };
        if ((ce !== null && !(ce >= 1 && ce <= 100)) || (pe !== null && !(pe >= 1 && pe <= 100))) return { code: 400, error: 'CE max and PE max are from 1% to 100%.' };
        // The most on one strike over all of them (22 Oct 2026), as one account's runner holds it.
        const sk = num(q.sk);
        if (sk !== null && !(Number.isInteger(sk) && sk >= 1 && sk <= 100)) return { code: 400, error: 'The most on one strike is a whole per cent of at most open, from 1 to 100.' };
        if (q.skf !== undefined && q.skf !== '' && q.skf !== 'next' && q.skf !== 'skip') return { code: 400, error: 'At a full strike: "next" (the next strike out) or "skip".' };
        shared = { deskMax: max, cePct: ce ?? 100, pePct: pe ?? 100, strikePct: sk ?? 100, strikeFull: q.skf === 'skip' ? 'skip' : 'next' };
      } else {
        // The account's limit as the saved backtests themselves carry it: the largest of them.
        const top = saves.map((s) => s.query.params).filter((p) => (p.deskMax ?? 0) > 0).sort((a, b) => (b.deskMax ?? 0) - (a.deskMax ?? 0))[0];
        if (top) shared = { deskMax: top.deskMax!, cePct: top.cePct ?? 100, pePct: top.pePct ?? 100, strikePct: top.strikePct ?? 100, strikeFull: top.strikeFull ?? 'next' };
      }
    }
    /*
     * The hours, for the run (owner, 13 Oct 2026: the single backtest's hours choice, "wanted in the portfolio
     * section"): `?hours=saved` -- each as it was saved, the default -- or `desk`, `all` or `custom` with
     * `hfrom` / `hto`, put over every member worked by settings for this run only; nothing saved is changed.
     * A member worked by a strategy keeps that strategy's own days and hours, as it does alone: `hours.own`
     * names them, so the screen can say which were not moved.
     */
    const hoursAsk = q.hours === undefined || q.hours === '' ? 'saved' : q.hours;
    if (hoursAsk !== 'saved' && hoursAsk !== 'desk' && hoursAsk !== 'all' && hoursAsk !== 'custom') return { code: 400, error: 'The hours are "saved", "desk", "all" or "custom".' };
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    const hoursFrom = typeof q.hfrom === 'string' ? q.hfrom : '', hoursTo = typeof q.hto === 'string' ? q.hto : '';
    if (hoursAsk === 'custom' && (!hhmm.test(hoursFrom) || !hhmm.test(hoursTo))) return { code: 400, error: 'Custom hours are a From and a To time, HH:MM (IST).' };
    if (hoursAsk === 'custom' && hoursFrom === hoursTo) return { code: 400, error: 'The From and To times must differ.' };
    const over: Pick<BacktestParams, 'window' | 'hoursFrom' | 'hoursTo'> | null = hoursAsk === 'saved' ? null
      : { window: hoursAsk, hoursFrom: hoursAsk === 'custom' ? hoursFrom : undefined, hoursTo: hoursAsk === 'custom' ? hoursTo : undefined };
    /*
     * The other settings, for the run (owner, 14 Oct 2026: "on the portfolio side the filter is off and each
     * backtest runs with its own; switched on, that filter is taken for now and applied to every backtest").
     * Each is its own switch: `o_rule` + `o_value` (the strike), `o_tp` with `o_tsteps` (the option's target,
     * fixed or by the clock), `o_sl` (its stop), `o_lots`, `o_minprem`, and `o_slmin` / `o_slmax` / `o_tgtmin` /
     * `o_tgtmax` (the SL and TGT range, the four together), `o_noentry` (no-entry windows, 15 Oct 2026), `o_vol` /
     * `o_volby` (the volatility filter, as the single backtest's, 17 Oct 2026 -- asked of the market, so over a member
     * by a strategy too), `o_sblocks` (a strike rule by time of day, 18 Oct 2026: the blocks after each member's own
     * rule -- or the run's strike -- held to the whole day; a member by a strategy keeps its own), `o_tsl` (a trailing SL on the
     * option's stop, 18 Oct 2026: `5pts:5pts`, or `off` to take every member's away; a member by a strategy keeps its own
     * stop, as on the desk), `o_wsl` / `o_wtgt` / `o_wmode` (the perp's SL and target widened with the 1m ATR, and when volatility falls again
     * `widest` or `calm` -- together, 0 off;
     * a member by a strategy keeps its own levels), `o_be` (the option's stop to the price sold once the premium has fallen
     * so far, `10pct` / `5pts`, or `off`), `o_noperpsl` / `o_noperptgt` (the perp's SL and TGT left out, 1, or used, 0 --
     * the two together; a member by a strategy keeps the desk's), `o_chase` (the chase guard, 22 Oct 2026: `07:00-11:00-400`,
     * or `off` to take every member's away -- over a member by a strategy too, as the volatility filter is). One that is absent is off: each member's own. They are
     * read and held to their limits by the single backtest's own parser, so a value means here what it means there.
     */
    const O_KEYS = ['rule', 'value', 'tp', 'tsteps', 'sl', 'lots', 'minprem', 'slmin', 'slmax', 'tgtmin', 'tgtmax', 'noentry', 'vol', 'volby', 'sblocks', 'tsl', 'wsl', 'wtgt', 'wmode', 'be', 'noperpsl', 'noperptgt', 'chase'] as const;
    const asked: Record<string, unknown> = {};
    for (const k of O_KEYS) if (q[`o_${k}`] !== undefined && q[`o_${k}`] !== '') asked[k] = q[`o_${k}`];
    const has = (k: (typeof O_KEYS)[number]) => k in asked;
    if (has('value') && !has('rule')) return { code: 400, error: 'A strike for the run is its rule and its limit: o_rule=delta|premium with o_value.' };
    if (has('rule') && !has('value')) return { code: 400, error: 'A strike for the run is its rule and its limit: o_rule=delta|premium with o_value.' };
    if (has('tsteps') && !has('tp')) return { code: 400, error: 'A target by the clock for the run needs the target it starts from: o_tp.' };
    // The no-entry windows and strike blocks for the run are held to the whole day: each member keeps its own hours, or the run's.
    // A trailing SL for the run is checked against the run's stop where there is one, else as if a stop were set: each member's own.
    const read = backtestParamsOf({ ...(has('noentry') || has('sblocks') ? { ...asked, window: 'all' } : asked), ...(has('tsl') && !has('sl') ? { sl: DEFAULT_PARAMS.stopPct } : {}) });
    if (typeof read === 'string') return { code: 400, error: `For the run: ${read}` };
    const range = has('slmin') || has('slmax') || has('tgtmin') || has('tgtmax');
    const settings: Partial<BacktestParams> = {
      ...(has('rule') ? { rule: read.rule, value: read.value } : {}),
      // A fixed target put over a member whose own moves by the clock takes its steps away: named, and undefined.
      ...(has('tp') ? { targetPct: read.targetPct, targetSteps: read.targetSteps } : {}),
      ...(has('sl') ? { stopPct: read.stopPct } : {}),
      ...(has('lots') ? { lots: read.lots } : {}),
      ...(has('minprem') ? { minPremium: read.minPremium } : {}),
      ...(range ? { slMin: read.slMin, slMax: read.slMax, tgtMin: read.tgtMin, tgtMax: read.tgtMax } : {}),
      ...(has('noentry') ? { noEntry: read.noEntry } : {}),
      ...(has('sblocks') ? { strikeBlocks: read.strikeBlocks ?? [] } : {}),
      // `off` takes a member's own away: named, and undefined.
      ...(has('tsl') ? { tsl: read.tsl } : {}),
      // The perp's widening with volatility, the two together: 0 is off for the run.
      ...(has('wsl') || has('wtgt') || has('wmode') ? { widenSlAtr: read.widenSlAtr ?? 0, widenTgtAtr: read.widenTgtAtr ?? 0, widenMode: read.widenMode ?? 'widest' } : {}),
      // The perp's levels left out for the run, the two together: 0 is used, 1 left out.
      ...(has('noperpsl') || has('noperptgt') ? { skipPerpSl: read.skipPerpSl === true, skipPerpTgt: read.skipPerpTgt === true } : {}),
      // The stop to the price sold, for the run; `off` takes each member's own away.
      ...(has('be') ? { breakEven: read.breakEven } : {}),
    };
    const market: Partial<BacktestParams> = {
      ...(has('vol') ? { vol: read.vol ?? 'off' } : {}),
      // Read by the candles unless the run says the IV; a strategy that sets its delta by volatility keeps its own source.
      ...(has('volby') ? { volBy: read.volBy ?? 'atr' } : {}),
      // The chase guard is asked of the market, as the volatility filter is; `off` takes each member's own away.
      ...(has('chase') ? { chase: read.chase } : {}),
    };
    Object.assign(settings, market);
    const changed = Object.keys(settings).length > 0;
    /*
     * Methods by win % for the run (owner, 19 Oct 2026: "in the portfolio, pick the saved backtests' methods by win %
     * with a tap -- not Backtest, edit, Win, update, and back"): `o_win=` the least share won (1 to 100), `o_wintrades=`
     * the least trades (1 to 100, 3), and the days the record is read on -- `o_winon=before` (the default) the
     * `o_windays=` (1 to 30, 7) finished days before the run, so the methods are picked and then tested on days that
     * took no part in picking them; or `o_winon=same`, the run's own days, as the Backtest screen's Win tab picks,
     * in-sample and said so; or `o_winon=first` (19 Oct 2026, owner: "portfolio not working" -- a run from 1 Oct has no
     * finished days before it, the record starting then): picked on the run's own first `o_windays` days and run on
     * the days after them, so the test is still on days that took no part in the pick; or `o_winon=custom` (19 Oct 2026,
     * owner: "first day custom, last day"): picked on `o_winfrom` to `o_winto`, any days of the record, and run on the
     * run's days after `o_winto` -- never on a day of the pick. Each saved backtest worked by settings is given the methods that won so on its own record
     * (every method, on its own time frames and settings, as the Win tab lists them); one by a strategy keeps the
     * strategy's. Nothing saved is changed.
     */
    let win: { pct: number; minTrades: number; on: 'before' | 'same' | 'first' | 'custom'; from: string; to: string } | null = null;
    if (q.o_win !== undefined && q.o_win !== '') {
      const pct = Number(q.o_win), minTrades = q.o_wintrades === undefined || q.o_wintrades === '' ? 3 : Number(q.o_wintrades);
      if (!(pct >= 1 && pct <= 100)) return { code: 400, error: 'For the run: the win rate is from 1% to 100%.' };
      if (!Number.isInteger(minTrades) || minTrades < 1 || minTrades > 100) return { code: 400, error: 'For the run: the least trades are a whole number from 1 to 100.' };
      const d = winDaysOf(q, r);
      if (typeof d === 'string') return { code: 400, error: `For the run: ${d}` };
      win = { pct, minTrades, on: d.on, from: d.pick.from, to: d.pick.to };
      r = d.run;
    }
    const own = saves.filter((s) => s.query.strategy !== null).map((s) => s.id);
    const members = saves.map((s) => {
        const strategy = s.query.strategy === null ? null : strategies.find((x) => x.id === s.query.strategy) ?? null;
        if (s.query.strategy !== null && !strategy) return { id: s.id, name: s.name, ask: null, problem: 'The strategy it is worked by has been deleted, or buys now rather than sells.' };
        const params = (over || changed) && !strategy ? { ...s.query.params, ...settings, ...(over ?? {}) } : { ...s.query.params, ...market };
        return { id: s.id, name: s.name, ask: { params, tfs: s.query.tfs.length ? s.query.tfs : null, methods: s.query.methods.length ? s.query.methods : null, strategy } } as Member;
      });
    // Each one by settings given the methods that won so on its own record -- one at a time, as the backtest thread takes them.
    const picked: Record<string, string[]> = {};
    if (win) {
      for (const m of members) {
        if (!m.ask || m.ask.strategy) continue;
        const rec = await signalBacktest({ from: win.from, to: win.to, now: Date.now(), params: m.ask.params, tfs: m.ask.tfs, methods: null, strategy: null, spot: tradingService().spot });
        const ids = pickMethods(rec.choices.methods.map((x) => ({ method: x.key, trades: x.n, wins: x.wins, net: x.net })), { winPct: win.pct, minTrades: win.minTrades });
        picked[m.id] = ids;
        if (ids.length) m.ask = { ...m.ask, methods: ids };
        else Object.assign(m, { ask: null, problem: `No method won ${win.pct}% of ${win.minTrades}+ trades ${win.from === win.to ? `on ${win.from}` : `from ${win.from} to ${win.to}`}: nothing to trade.` });
      }
    }
    return {
      r, shared,
      members,
      /** The methods by win % the run was given, and each one's pick; null, each its own. `own`: those by a strategy, which kept theirs. */
      // `run`: the days the run was on -- after the pick's own with `first`.
      winPick: win ? { ...win, picked, own, run: r } : null,
      /** The hours the run was held to; null, each member's own as saved. `own`: the members a strategy works, whose hours are its own. */
      hours: over ? { window: over.window, ...(over.hoursFrom ? { hoursFrom: over.hoursFrom, hoursTo: over.hoursTo } : {}), own } : null,
      /** The settings put over the run, as they were read -- only those switched on; null, none. `own` as for the hours. */
      over: changed ? { settings: { ...settings, ...(has('tp') ? { targetSteps: read.targetSteps ?? [] } : {}), ...(has('tsl') ? { tsl: read.tsl ?? null } : {}), ...(has('be') ? { breakEven: read.breakEven ?? null } : {}) }, own } : null,
    };
}

type Member = { id: string; name: string; ask: { params: BacktestParams; tfs: string[] | null; methods: string[] | null; strategy: Awaited<ReturnType<typeof backtestStrategies>>[number] | null } | null; problem?: string };

export function registerBacktestSavesRoutes(app: FastifyInstance) {
  /** Every saved backtest and every portfolio, by name. */
  app.get('/api/backtest-saves', async () => listSaves());

  /**
   * Keep a backtest's settings under a name; with `id`, the same one again -- other settings, or another name.
   * `group` files it in a group (blank or null: none); left out, a saved one keeps its own.
   */
  app.post('/api/backtest-saves', async (req, reply) => {
    const b = (req.body ?? {}) as { id?: unknown; name?: unknown; query?: unknown; group?: unknown };
    const named = nameProblem(b.name);
    if ('problem' in named) return refuse(reply, 422, { error: named.problem, problems: [named.problem] });
    const query = savedQueryOf(b.query);
    if (typeof query === 'string') return refuse(reply, 422, { error: query, problems: [query] });
    const grouped = b.group === undefined ? undefined : groupProblem(b.group);
    if (grouped && 'problem' in grouped) return refuse(reply, 422, { error: grouped.problem, problems: [grouped.problem] });
    const kept = await keepSave({ id: typeof b.id === 'string' && b.id ? b.id : null, name: named.name, query, now: Date.now(), ...(grouped ? { group: grouped.group } : {}) });
    if ('problem' in kept) return refuse(reply, kept.status, { error: kept.problem, problems: [kept.problem] });
    return { ok: true, save: kept };
  });

  /** A copy of a saved backtest -- its settings and its group -- as "<name> copy" (16 Oct 2026). */
  app.post('/api/backtest-saves/:id/clone', async (req, reply) => {
    const kept = await cloneSave((req.params as { id: string }).id, Date.now());
    if ('problem' in kept) return refuse(reply, kept.status, { error: kept.problem, problems: [kept.problem] });
    return { ok: true, save: kept };
  });

  /** A group renamed, every saved backtest in it moved with it; `to` blank or null takes them out of any group. */
  app.post('/api/backtest-saves/group', async (req, reply) => {
    const b = (req.body ?? {}) as { from?: unknown; to?: unknown };
    const from = groupProblem(b.from);
    if ('problem' in from || from.group === null) return refuse(reply, 422, { error: 'Which group: its name is needed.' });
    const to = groupProblem(b.to);
    if ('problem' in to) return refuse(reply, 422, { error: to.problem, problems: [to.problem] });
    return { ok: true, moved: await renameGroup(from.group, to.group, Date.now()) };
  });

  /** Delete a saved backtest. It leaves its portfolios; one left with fewer than two goes with it, and is named in the answer. */
  app.delete('/api/backtest-saves/:id', async (req, reply) => {
    const r = await dropSave((req.params as { id: string }).id, Date.now());
    if (!r.ok) return refuse(reply, 404, { error: 'That saved backtest is gone already.' });
    return r;
  });

  /** Keep a portfolio: a name, and two or more saved backtests in order. With `id`, the same one again. */
  app.post('/api/backtest-portfolios', async (req, reply) => {
    const b = (req.body ?? {}) as { id?: unknown; name?: unknown; saveIds?: unknown };
    const named = nameProblem(b.name);
    if ('problem' in named) return refuse(reply, 422, { error: named.problem, problems: [named.problem] });
    const kept = await keepPortfolio({ id: typeof b.id === 'string' && b.id ? b.id : null, name: named.name, saveIds: keys(b.saveIds, PORTFOLIO_MEMBERS_MAX + 1), now: Date.now() });
    if ('problem' in kept) return refuse(reply, kept.status, { error: kept.problem, problems: [kept.problem] });
    return { ok: true, portfolio: kept };
  });

  /** A copy of a portfolio, the same saved backtests in the same order, as "<name> copy" (16 Oct 2026). */
  app.post('/api/backtest-portfolios/:id/clone', async (req, reply) => {
    const kept = await clonePortfolio((req.params as { id: string }).id, Date.now());
    if ('problem' in kept) return refuse(reply, kept.status, { error: kept.problem, problems: [kept.problem] });
    return { ok: true, portfolio: kept };
  });

  app.delete('/api/backtest-portfolios/:id', async (req, reply) => {
    if (!(await dropPortfolio((req.params as { id: string }).id))) return refuse(reply, 404, { error: 'That portfolio is gone already.' });
    return { ok: true };
  });

  /**
   * Saved backtests run together over one range of expiry days, and their total: `?ids=a,b,c&from=&to=`.
   *
   * `?limit=shared` (the default): as ONE ACCOUNT -- the desk's "at most open" and its CE and PE shares are an
   * account's, so the members are traded on one clock, in the desk's own order, for the same places. The limit is
   * `?max=&ce=&pe=` where given, else the largest "at most open" among the saved backtests themselves, with its
   * shares; where none of them has one, there is no limit to share and they are simply added up.
   * `?limit=own`: each worked as it is alone, its own limit on its own trades, and added up.
   *
   * Either way the margin is the most held at once across all of them. One whose strategy has been deleted is
   * listed, with why, and counted as nothing.
   */
  app.get('/api/backtest-portfolio', async (req, reply) => {
    const asked = await portfolioQuery((req.query ?? {}) as Record<string, unknown>);
    if ('error' in asked) return refuse(reply, asked.code ?? 400, { error: asked.error ?? '' });
    const result = await portfolioBacktest({ ...asked.r, now: Date.now(), spot: tradingService().spot, shared: asked.shared, members: asked.members });
    return { ...result, hours: asked.hours, over: asked.over, winPick: asked.winPick };
  });

  /**
   * The run's trades, one by one (owner, 14 Oct 2026: "tap the count"; 15 Oct: "by session too"): the same query as
   * the run, narrowed by `?day=`, `?sfrom=&sto=` and `?smethod=` as the single backtest's are. Read-only.
   */
  app.get('/api/backtest-portfolio/trades', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const asked = await portfolioQuery(q);
    if ('error' in asked) return refuse(reply, asked.code ?? 400, { error: asked.error ?? '' });
    // Which trades (`TradePick`): one of its days, or all; a session of the day as fifteen-minute slots; one method.
    const day = typeof q.day === 'string' && q.day !== '' ? q.day : null;
    if (day !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < asked.r.from || day > asked.r.to)) return refuse(reply, 400, { error: 'The day is one of the expiry days asked for, as YYYY-MM-DD.' });
    const slot = (k: string) => (q[k] === undefined || q[k] === '' ? null : Number(q[k]));
    const slotFrom = slot('sfrom'), slotTo = slot('sto');
    if ([slotFrom, slotTo].some((x) => x !== null && !(Number.isInteger(x) && x >= 0 && x <= 95))) return refuse(reply, 400, { error: 'A session is fifteen-minute slots from 0 (5:30 PM) to 95.' });
    const pick = { day, slotFrom, slotTo, method: typeof q.smethod === 'string' && q.smethod !== '' ? q.smethod : null };
    return portfolioTrades({ ...asked.r, now: Date.now(), spot: tradingService().spot, shared: asked.shared, members: asked.members }, pick);
  });

  /**
   * The option's stop and strike as saved, against a stop and a delta by volatility, over the saved backtests of a run
   * (17 Oct 2026): the run's own query -- its hours and the settings put over it -- with what is set by level as the
   * single backtest's study (`volRuleOf`).
   * Each is traded on its own signals with no limit, the run's shared one included, so both rules trade the same
   * signals; their trades are added up day by day. Read-only.
   */
  app.get('/api/backtest-portfolio/vol-study', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const asked = await portfolioQuery(q);
    if ('error' in asked) return refuse(reply, asked.code ?? 400, { error: asked.error ?? '' });
    const rule = volRuleOf(q);
    if (typeof rule === 'string') return refuse(reply, 400, { error: rule });
    return portfolioVolStudy({ ...asked.r, now: Date.now(), spot: tradingService().spot, members: asked.members, ...rule });
  });

  /** One expiry day of the run's volatility study, trade by trade, each with its saved backtest and its level: `?day=&side=&by=`. */
  app.get('/api/backtest-portfolio/vol-study/trades', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const asked = await portfolioQuery(q);
    if ('error' in asked) return refuse(reply, asked.code ?? 400, { error: asked.error ?? '' });
    const rule = volRuleOf(q);
    if (typeof rule === 'string') return refuse(reply, 400, { error: rule });
    const pick = volTradesPickOf(q, asked.r);
    if (typeof pick === 'string') return refuse(reply, 400, { error: pick });
    return portfolioVolStudyTrades({ ...asked.r, now: Date.now(), spot: tradingService().spot, members: asked.members, ...rule }, pick);
  });

  /**
   * The SL, the delta and win % by session over the saved backtests of a run (23 Oct 2026): the run's own query with
   * the sessions as the single backtest's study takes them (`sessionRuleOf`); each traded on its own signals with no
   * limit, added up. Read-only.
   */
  app.get('/api/backtest-portfolio/session-study', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const asked = await portfolioQuery(q);
    if ('error' in asked) return refuse(reply, asked.code ?? 400, { error: asked.error ?? '' });
    const rule = sessionRuleOf(q);
    if (typeof rule === 'string') return refuse(reply, 400, { error: rule });
    return portfolioSessionStudy({ ...asked.r, now: Date.now(), spot: tradingService().spot, members: asked.members, ...rule });
  });

  /** The run's session study, trade by trade, each with its saved backtest and its session: `?side=&session=&day=`. */
  app.get('/api/backtest-portfolio/session-study/trades', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const asked = await portfolioQuery(q);
    if ('error' in asked) return refuse(reply, asked.code ?? 400, { error: asked.error ?? '' });
    const rule = sessionRuleOf(q);
    if (typeof rule === 'string') return refuse(reply, 400, { error: rule });
    const pick = sessionTradesPickOf(q, asked.r, rule.sessions.length);
    if (typeof pick === 'string') return refuse(reply, 400, { error: pick });
    return portfolioSessionStudyTrades({ ...asked.r, now: Date.now(), spot: tradingService().spot, members: asked.members, ...rule }, pick);
  });

  /**
   * Methods by win % at several bars over the run's saved backtests (owner, 20 Oct 2026: "an editable range -- the
   * win %, the strategies and the least trades -- in the portfolio"): the run's own query -- its saved backtests
   * (`ids`, those ticked), hours and settings -- less its own pick, which the sweep makes at every bar; `w_pcts` and
   * `w_trades` the bars (`sweepBarsOf`), and the days picked on as the run's pick reads them (`winDaysOf`). Each
   * saved backtest alone, on its own limit: the run's shared one is not over it. Read-only.
   */
  app.get('/api/backtest-portfolio/win-sweep', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const bars = sweepBarsOf(q);
    if (typeof bars === 'string') return refuse(reply, 400, { error: bars });
    const { o_win: _win, o_wintrades: _trades, ...rest } = q;
    const asked = await portfolioQuery(rest);
    if ('error' in asked) return refuse(reply, asked.code ?? 400, { error: asked.error ?? '' });
    const d = winDaysOf(q, asked.r);
    if (typeof d === 'string') return refuse(reply, 400, { error: `For the sweep: ${d}` });
    return winSweep({ ...d.run, now: Date.now(), spot: tradingService().spot, pick: d.pick, ...bars, members: asked.members });
  });

  /**
   * One cell of the run's sweep, trade by trade (owner, 20 Oct 2026: "each cell, a tap, a popup, trade by trade"): the
   * run's query with `ids` the row's saved backtest, and the cell (`sweepCellOf`). Read-only.
   */
  app.get('/api/backtest-portfolio/win-sweep/trades', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const at = sweepCellOf(q);
    if (typeof at === 'string') return refuse(reply, 400, { error: at });
    const { o_win: _win, o_wintrades: _trades, ...rest } = q;
    const asked = await portfolioQuery(rest);
    if ('error' in asked) return refuse(reply, asked.code ?? 400, { error: asked.error ?? '' });
    const m = asked.members.find((x) => x.id === at.row);
    if (!m) return refuse(reply, 404, { error: 'That saved backtest is not in this run.' });
    if (!m.ask || m.problem || m.ask.strategy) return refuse(reply, 400, { error: m.problem ?? 'Worked by a strategy: it keeps the strategy\'s methods, and was not swept.' });
    const d = winDaysOf(q, asked.r);
    if (typeof d === 'string') return refuse(reply, 400, { error: `For the sweep: ${d}` });
    return winSweepTrades({ ...d.run, now: Date.now(), spot: tradingService().spot, pick: d.pick, pcts: [], minTrades: [], members: asked.members }, at);
  });

  /**
   * The same run laid beside the live desk, signal for signal (owner, 14 Oct 2026: "bring the live check inside
   * the backtest and the portfolio -- no tab of its own"): every trade of the saved backtests looked up in what
   * the desk did with that signal, every order the desk placed looked up in theirs, and each expiry day's count
   * and money on both sides. The query is the run's own, so the hours and settings put over the run are over
   * this too. Read-only.
   */
  app.get('/api/backtest-portfolio/live-check', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const asked = await portfolioQuery(q);
    if ('error' in asked) return refuse(reply, asked.code ?? 400, { error: asked.error ?? '' });
    const members = asked.members.flatMap((m) => (m.ask ? [{ id: m.id, name: m.name, ask: m.ask }] : []));
    return liveCheck({
      ...asked.r, now: Date.now(), spot: tradingService().spot, accounts: await liveAccounts(),
      portfolio: { name: typeof q.name === 'string' && q.name.trim() !== '' ? q.name.trim().slice(0, 120) : 'these saved backtests', shared: asked.shared, members },
    });
  });
}
