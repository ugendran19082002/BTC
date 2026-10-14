import type { FastifyInstance } from 'fastify';
import { tradingService } from '../../trading/service.js';
import {
  PORTFOLIO_MEMBERS_MAX, dropPortfolio, dropSave, keepPortfolio, keepSave, listSaves, nameProblem, savesByIds, type SavedQuery,
} from '../../report/backtest-saves.js';
import { backtestable, type BacktestParams } from '../../report/signal-backtest.js';
import { portfolioBacktest } from '../../report/backtest-run.js';
import { backtestParamsFrom, backtestParamsOf, rangeOf } from './market.routes.js';
import { strategyStore } from './strategy.routes.js';
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

export function registerBacktestSavesRoutes(app: FastifyInstance) {
  /** Every saved backtest and every portfolio, by name. */
  app.get('/api/backtest-saves', async () => listSaves());

  /** Keep a backtest's settings under a name; with `id`, the same one again -- other settings, or another name. */
  app.post('/api/backtest-saves', async (req, reply) => {
    const b = (req.body ?? {}) as { id?: unknown; name?: unknown; query?: unknown };
    const named = nameProblem(b.name);
    if ('problem' in named) return refuse(reply, 422, { error: named.problem, problems: [named.problem] });
    const query = savedQueryOf(b.query);
    if (typeof query === 'string') return refuse(reply, 422, { error: query, problems: [query] });
    const kept = await keepSave({ id: typeof b.id === 'string' && b.id ? b.id : null, name: named.name, query, now: Date.now() });
    if ('problem' in kept) return refuse(reply, kept.status, { error: kept.problem, problems: [kept.problem] });
    return { ok: true, save: kept };
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
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const ids = keys(typeof q.ids === 'string' ? q.ids.split(',') : [], PORTFOLIO_MEMBERS_MAX + 1);
    if (ids.length === 0) return refuse(reply, 400, { error: 'Which saved backtests: ?ids=a,b.' });
    if (ids.length > PORTFOLIO_MEMBERS_MAX) return refuse(reply, 400, { error: `At most ${PORTFOLIO_MEMBERS_MAX} saved backtests at once.` });
    const saves = await savesByIds(ids);
    if (saves.length !== ids.length) return refuse(reply, 404, { error: 'One of those saved backtests is gone: it may have been deleted.' });
    const strategies = (await strategyStore().all().catch(() => [])).filter(backtestable);
    if (q.limit !== undefined && q.limit !== '' && q.limit !== 'shared' && q.limit !== 'own') return refuse(reply, 400, { error: 'The limit is "shared" (one account) or "own" (each its own).' });
    let shared: { deskMax: number; cePct: number; pePct: number } | null = null;
    if (q.limit !== 'own') {
      const num = (v: unknown) => (v === undefined || v === '' ? null : Number(v));
      const max = num(q.max), ce = num(q.ce), pe = num(q.pe);
      if (max !== null) {
        if (!Number.isInteger(max) || max < 1 || max > 500) return refuse(reply, 400, { error: 'At most open is a whole number from 1 to 500.' });
        if ((ce !== null && !(ce >= 1 && ce <= 100)) || (pe !== null && !(pe >= 1 && pe <= 100))) return refuse(reply, 400, { error: 'CE max and PE max are from 1% to 100%.' });
        shared = { deskMax: max, cePct: ce ?? 100, pePct: pe ?? 100 };
      } else {
        // The account's limit as the saved backtests themselves carry it: the largest of them.
        const top = saves.map((s) => s.query.params).filter((p) => (p.deskMax ?? 0) > 0).sort((a, b) => (b.deskMax ?? 0) - (a.deskMax ?? 0))[0];
        if (top) shared = { deskMax: top.deskMax!, cePct: top.cePct ?? 100, pePct: top.pePct ?? 100 };
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
    if (hoursAsk !== 'saved' && hoursAsk !== 'desk' && hoursAsk !== 'all' && hoursAsk !== 'custom') return refuse(reply, 400, { error: 'The hours are "saved", "desk", "all" or "custom".' });
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    const hoursFrom = typeof q.hfrom === 'string' ? q.hfrom : '', hoursTo = typeof q.hto === 'string' ? q.hto : '';
    if (hoursAsk === 'custom' && (!hhmm.test(hoursFrom) || !hhmm.test(hoursTo))) return refuse(reply, 400, { error: 'Custom hours are a From and a To time, HH:MM (IST).' });
    if (hoursAsk === 'custom' && hoursFrom === hoursTo) return refuse(reply, 400, { error: 'The From and To times must differ.' });
    const over: Pick<BacktestParams, 'window' | 'hoursFrom' | 'hoursTo'> | null = hoursAsk === 'saved' ? null
      : { window: hoursAsk, hoursFrom: hoursAsk === 'custom' ? hoursFrom : undefined, hoursTo: hoursAsk === 'custom' ? hoursTo : undefined };
    /*
     * The other settings, for the run (owner, 14 Oct 2026: "on the portfolio side the filter is off and each
     * backtest runs with its own; switched on, that filter is taken for now and applied to every backtest").
     * Each is its own switch: `o_rule` + `o_value` (the strike), `o_tp` with `o_tsteps` (the option's target,
     * fixed or by the clock), `o_sl` (its stop), `o_lots`, `o_minprem`, and `o_slmin` / `o_slmax` / `o_tgtmin` /
     * `o_tgtmax` (the SL and TGT range, the four together). One that is absent is off: each member's own. They are
     * read and held to their limits by the single backtest's own parser, so a value means here what it means there.
     */
    const O_KEYS = ['rule', 'value', 'tp', 'tsteps', 'sl', 'lots', 'minprem', 'slmin', 'slmax', 'tgtmin', 'tgtmax'] as const;
    const asked: Record<string, unknown> = {};
    for (const k of O_KEYS) if (q[`o_${k}`] !== undefined && q[`o_${k}`] !== '') asked[k] = q[`o_${k}`];
    const has = (k: (typeof O_KEYS)[number]) => k in asked;
    if (has('value') && !has('rule')) return refuse(reply, 400, { error: 'A strike for the run is its rule and its limit: o_rule=delta|premium with o_value.' });
    if (has('rule') && !has('value')) return refuse(reply, 400, { error: 'A strike for the run is its rule and its limit: o_rule=delta|premium with o_value.' });
    if (has('tsteps') && !has('tp')) return refuse(reply, 400, { error: 'A target by the clock for the run needs the target it starts from: o_tp.' });
    const read = backtestParamsOf(asked);
    if (typeof read === 'string') return refuse(reply, 400, { error: `For the run: ${read}` });
    const range = has('slmin') || has('slmax') || has('tgtmin') || has('tgtmax');
    const settings: Partial<BacktestParams> = {
      ...(has('rule') ? { rule: read.rule, value: read.value } : {}),
      // A fixed target put over a member whose own moves by the clock takes its steps away: named, and undefined.
      ...(has('tp') ? { targetPct: read.targetPct, targetSteps: read.targetSteps } : {}),
      ...(has('sl') ? { stopPct: read.stopPct } : {}),
      ...(has('lots') ? { lots: read.lots } : {}),
      ...(has('minprem') ? { minPremium: read.minPremium } : {}),
      ...(range ? { slMin: read.slMin, slMax: read.slMax, tgtMin: read.tgtMin, tgtMax: read.tgtMax } : {}),
    };
    const changed = Object.keys(settings).length > 0;
    const result = await portfolioBacktest({
      ...r, now: Date.now(), spot: tradingService().spot, shared,
      members: saves.map((s) => {
        const strategy = s.query.strategy === null ? null : strategies.find((x) => x.id === s.query.strategy) ?? null;
        if (s.query.strategy !== null && !strategy) return { id: s.id, name: s.name, ask: null, problem: 'The strategy it is worked by has been deleted, or buys now rather than sells.' };
        const params = (over || changed) && !strategy ? { ...s.query.params, ...settings, ...(over ?? {}) } : s.query.params;
        return { id: s.id, name: s.name, ask: { params, tfs: s.query.tfs.length ? s.query.tfs : null, methods: s.query.methods.length ? s.query.methods : null, strategy } };
      }),
    });
    return {
      ...result,
      /** The hours the run was held to; null, each member's own as saved. `own`: the members a strategy works, whose hours are its own. */
      hours: over ? { window: over.window, ...(over.hoursFrom ? { hoursFrom: over.hoursFrom, hoursTo: over.hoursTo } : {}), own: saves.filter((s) => s.query.strategy !== null).map((s) => s.id) } : null,
      /** The settings put over the run, as they were read -- only those switched on; null, none. `own` as for the hours. */
      over: changed ? { settings: { ...settings, ...(has('tp') ? { targetSteps: read.targetSteps ?? [] } : {}) }, own: saves.filter((s) => s.query.strategy !== null).map((s) => s.id) } : null,
    };
  });
}
