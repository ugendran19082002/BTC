import Fastify from 'fastify';
import cors from '@fastify/cors';
import { liveChain, historicalChain, liveExpiries, type Snapshot } from './chain.js';
import { scoreLegs, pickSells, bias, verdict, maxLots, MARGIN_PER_LOT_USD, USDINR } from './score.js';
import { run, floorSweep, loadDays, reloadDays, DEFAULTS, type Params } from './backtest.js';
import { credsFromEnv, getBalances, getPositions, NotConfigured } from './auth.js';

// Read once at startup so a later log line cannot pick the secret out of env.
const creds = credsFromEnv();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cors, { origin: true });

/** Resolve the `at` query param: "now" (or absent) means live. */
function resolveAt(at: string | undefined): number | null {
  if (!at || at === 'now' || at === 'live') return null;
  const n = Number(at);
  if (Number.isFinite(n) && n > 1e9) return Math.floor(n);
  const t = Date.parse(at);
  if (Number.isNaN(t)) throw new Error(`cannot parse time "${at}"`);
  return Math.floor(t / 1000);
}

async function snapshotFor(
  at: string | undefined,
  width: number,
  expiry?: string,
): Promise<Snapshot> {
  const ts = resolveAt(at);
  return ts === null ? liveChain(width, expiry) : historicalChain(ts, width, expiry);
}

app.get('/api/expiries', async (_req, reply) => {
  try {
    return { expiries: await liveExpiries() };
  } catch (e) {
    reply.code(502);
    return { error: (e as Error).message };
  }
});

app.get('/api/health', async () => {
  const days = loadDays();
  return {
    ok: true,
    days: days.length,
    first: days[0]?.date ?? null,
    last: days[days.length - 1]?.date ?? null,
    now: new Date().toISOString(),
  };
});

app.get('/api/chain', async (req, reply) => {
  const q = req.query as { at?: string; width?: string; minPremium?: string; hedgeGap?: string; lots?: string; expiry?: string };
  try {
    const width = Number(q.width ?? 12);
    const snap = await snapshotFor(q.at, Number.isFinite(width) ? width : 12, q.expiry || undefined);
    const scored = scoreLegs(snap);
    const minPremium = Number(q.minPremium ?? 15);
    const hedgeGap = Number(q.hedgeGap ?? 3);
    const lots = Number(q.lots ?? 10);
    const picks = pickSells(snap, scored, minPremium, hedgeGap);
    return {
      snapshot: { ...snap, legs: undefined },
      legs: scored,
      bias: bias(snap, scored),
      picks,
      verdict: verdict(snap, picks, minPremium, lots),
      usdinr: USDINR,
    };
  } catch (e) {
    reply.code(400);
    return { error: (e as Error).message };
  }
});

/**
 * Account endpoints are disabled unless credentials are present. They are
 * read-only by construction: this process has no code path that places an order.
 */
app.get('/api/account', async (_req, reply) => {
  try {
    const [balances, positions] = await Promise.all([getBalances(creds), getPositions(creds)]);
    const usd = balances.find((b) => b.asset_symbol === 'USD' || b.asset_symbol === 'USDT');
    const available = Number(usd?.available_balance ?? 0);
    return {
      configured: true,
      availableUsd: available,
      availableInr: available * USDINR,
      maxLots: maxLots(available),
      balances,
      positions: positions.filter((p) => (p.size ?? 0) !== 0),
    };
  } catch (e) {
    if (e instanceof NotConfigured) {
      reply.code(501);
      return { configured: false, message: e.message };
    }
    reply.code(502);
    return { configured: true, error: (e as Error).message };
  }
});

app.get('/api/sizing', async (req) => {
  const q = req.query as { funds?: string };
  const funds = Number(q.funds ?? 100);
  return {
    availableUsd: funds,
    availableInr: funds * USDINR,
    marginPerLotUsd: MARGIN_PER_LOT_USD,
    maxLots: maxLots(funds),
  };
});

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

/**
 * "How much premium should I insist on?" answered from the data rather than
 * from a rule of thumb.
 */
app.post('/api/floors', async (req) => {
  const body = (req.body ?? {}) as Partial<Params> & { floors?: number[] };
  const { floors = [0, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100], ...params } = body;
  return { rows: floorSweep(floors, params) };
});

app.get('/api/presets', async () => ({
  defaults: DEFAULTS,
  presets: [
    { name: 'A  CE 0-15 + PE 0-15', ce: { min: 0, max: 15 }, pe: { min: 0, max: 15 } },
    { name: 'B  CE 0-15 + PE 15-30', ce: { min: 0, max: 15 }, pe: { min: 15, max: 30 } },
    { name: 'C  CE 0-15 + PE 15-40', ce: { min: 0, max: 15 }, pe: { min: 15, max: 40 } },
    { name: "D' CE 0-20 + PE 0-20", ce: { min: 0, max: 20 }, pe: { min: 0, max: 20 } },
    { name: 'Min $15 both sides', ce: { min: 15, max: 60 }, pe: { min: 15, max: 60 } },
    { name: 'CE only 0-15', ce: { min: 0, max: 15 }, pe: null },
    { name: 'PE only 0-15', ce: null, pe: { min: 0, max: 15 } },
  ],
}));

app.post('/api/reload', async () => ({ days: reloadDays() }));

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: '0.0.0.0' });
app.log.info(`chain snapshots loaded: ${loadDays().length}`);
app.log.info(
  creds
    ? 'account endpoints enabled (read-only)'
    : 'account endpoints disabled -- no credentials in env, market data unaffected',
);
