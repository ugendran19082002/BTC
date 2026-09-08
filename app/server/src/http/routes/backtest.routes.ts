import type { FastifyInstance } from 'fastify';
import { run, type Params } from '../../backtest/backtest.js';

export function registerBacktestRoutes(app: FastifyInstance) {
  app.post('/api/backtest', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Partial<Params> & { limit?: number };
      const { limit = 400, ...params } = body;
      const res = run(params);
      return {
        params: res.params,
        summary: res.summary,
        // newest first, capped so a two-year run does not blow up the response
        trades: res.trades.slice(-limit).reverse(),
        truncated: res.trades.length > limit,
        totalDays: res.trades.length,
      };
    } catch (e) {
      reply.code(400);
      return { error: (e as Error).message };
    }
  });

  /** Per-year breakdown for one parameter set, so a single good year cannot hide. */
  app.post('/api/backtest/byyear', async (req) => {
    const params = (req.body ?? {}) as Partial<Params>;
    const all = run(params);
    const years = [...new Set(all.trades.map((t) => t.date.slice(0, 4)))].sort();
    return {
      overall: all.summary,
      years: years.map((y) => ({
        year: y,
        ...run({ ...params, from: `${y}-01-01`, to: `${y}-12-31` }).summary,
      })),
    };
  });

}
