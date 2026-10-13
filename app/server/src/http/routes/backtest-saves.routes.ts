import type { FastifyInstance } from 'fastify';
import { tradingService } from '../../trading/service.js';
import {
  PORTFOLIO_MEMBERS_MAX, dropPortfolio, dropSave, keepPortfolio, keepSave, listSaves, nameProblem, savesByIds, type SavedQuery,
} from '../../report/backtest-saves.js';
import { backtestable } from '../../report/signal-backtest.js';
import { portfolioBacktest } from '../../report/backtest-run.js';
import { backtestParamsFrom, rangeOf } from './market.routes.js';
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
   * Saved backtests run together over one range of expiry days, and their total: `?ids=a,b,c&from=&to=`. Each is
   * worked on its own -- as it is alone -- and added up; the margin is the most held at once across all of them.
   * One whose strategy has been deleted is listed, with why, and counted as nothing.
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
    return portfolioBacktest({
      ...r, now: Date.now(), spot: tradingService().spot,
      members: saves.map((s) => {
        const strategy = s.query.strategy === null ? null : strategies.find((x) => x.id === s.query.strategy) ?? null;
        if (s.query.strategy !== null && !strategy) return { id: s.id, name: s.name, ask: null, problem: 'The strategy it is worked by has been deleted, or buys now rather than sells.' };
        return { id: s.id, name: s.name, ask: { params: s.query.params, tfs: s.query.tfs.length ? s.query.tfs : null, methods: s.query.methods.length ? s.query.methods : null, strategy } };
      }),
    });
  });
}
