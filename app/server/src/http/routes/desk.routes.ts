import type { FastifyInstance } from 'fastify';
import { liveChain, historicalChain, liveExpiries, type Snapshot } from '../../market/chain.js';
import { readMarket } from '../../market/moves.js';
import { liveSpot } from '../../market/delta.js';
import { scoreLegs, pickSells, bias, verdict, maxLots, MARGIN_PER_LOT_USD, USDINR } from '../../domain/score.js';
import { recommend, type PickMode } from '../../domain/recommend.js';
import { optionStructure } from '../../domain/structure.js';
import { forecast, reloadHorizons } from '../../domain/forecast.js';
import { loadCalibration, reloadCalibration } from '../../domain/calibration.js';
import { loadDays, reloadDays, DEFAULTS } from '../../backtest/backtest.js';
import { tradingService, SHORT_CAP_KEY } from '../../trading/service.js';
import { strategyStore } from './strategy.routes.js';
import { refuse } from '../refuse.js';

/** Resolve the `at` query param: "now" (or absent) means live. */
function resolveAt(at: string | undefined): number | null {
  if (!at || at === 'now' || at === 'live') return null;
  const n = Number(at);
  if (Number.isFinite(n) && n > 1e9) return Math.floor(n);
  const t = Date.parse(at);
  if (Number.isNaN(t)) throw new Error(`cannot parse time "${at}"`);
  return Math.floor(t / 1000);
}

function snapshotFor(at: string | undefined, width: number, expiry?: string): Promise<Snapshot> {
  const ts = resolveAt(at);
  return ts === null ? liveChain(width, expiry) : historicalChain(ts, width, expiry);
}

type ChainQuery = {
  at?: string; width?: string; minPremium?: string; hedgeGap?: string;
  lots?: string; expiry?: string; requireHedge?: string; mode?: string; safetyBar?: string;
};

export function registerDeskRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    const days = loadDays();
    return {
      ok: true,
      days: days.length,
      first: days[0]?.date ?? null,
      last: days[days.length - 1]?.date ?? null,
      // Which schema the journal is on. A container that started against an
      // older database should be visible from outside rather than by symptom.
      schema: tradingService().store.migrations().map((m) => m.id),
      // Both stores share one ledger, but only asking the trade store hid a
      // deploy whose strategy tables had never been created.
      strategies: strategyStore().all().length,
      now: new Date().toISOString(),
    };
  });

  /**
   * Just the price.
   *
   * Deliberately tiny and deliberately separate from /api/chain: the board is
   * expensive and refreshes every five seconds, while the number at the top of
   * the screen should tick. Polling the chain faster to move one figure would
   * be a hundred times the payload for the same answer.
   */
  app.get('/api/spot', async (_req, reply) => {
    const spot = await liveSpot().catch(() => null);
    if (spot === null) { reply.code(503); return { error: 'no price' }; }
    // Remembered here too, so the margin model has a fresh figure even when
    // nobody has loaded the chain recently.
    tradingService().noteSpot(spot);
    return { spot, at: Date.now() };
  });

  app.get('/api/expiries', async (_req, reply) => {
    try {
      return { expiries: await liveExpiries() };
    } catch (e) {
      reply.code(502);
      return { error: (e as Error).message };
    }
  });

  app.get('/api/chain', async (req, reply) => {
    const q = req.query as ChainQuery;
    try {
      const width = Number(q.width ?? 12);
      const snap = await snapshotFor(q.at, Number.isFinite(width) ? width : 12, q.expiry || undefined);
      const scored = scoreLegs(snap);
      const minPremium = Number(q.minPremium ?? 15);
      const hedgeGap = Number(q.hedgeGap ?? 3);
      const lots = Number(q.lots ?? 10);
      const requireHedge = q.requireHedge === '1' || q.requireHedge === 'true';
      const mode: PickMode = q.mode === 'safety' ? 'safety' : 'premium';
      const safetyBar = Math.min(0.999, Math.max(0.5, Number(q.safetyBar ?? 0.98)));
      const picks = pickSells(snap, scored, minPremium, hedgeGap);

      // Market context is best-effort: a throttled candle feed must not take the
      // chain down with it, it only costs the split its tested skew.
      // A daily contract opens 12 hours before it settles, so what is left tells
      // you how much of its life has already run.
      const elapsedHours = Math.max(0, 12 - snap.hoursToExpiry);
      const market = snap.live
        ? await readMarket(elapsedHours > 0 ? elapsedHours : undefined).catch(() => null)
        : null;

      // The margin model needs a spot, and the chain is where one arrives.
      if (snap.live) tradingService().noteSpot(snap.spot);

      const recommendation = recommend(snap, scored, market, minPremium, lots, hedgeGap, mode, safetyBar);

      return {
        snapshot: { ...snap, legs: undefined },
        legs: scored,
        bias: bias(snap, scored),
        picks,
        market,
        structure: optionStructure(snap, market?.realisedVol ?? null),
        forecast: forecast(snap),
        recommendation,
        requireHedge,
        verdict: verdict(snap, picks, minPremium, lots, market, {
          requireHedge,
          hedgeMissing: recommendation.hedgeMissing,
        }),
        usdinr: USDINR,
      };
    } catch (e) {
      reply.code(400);
      return { error: (e as Error).message };
    }
  });

  app.get('/api/sizing', async (req) => {
    const funds = Number((req.query as { funds?: string }).funds ?? 100);
    return {
      availableUsd: funds,
      availableInr: funds * USDINR,
      marginPerLotUsd: MARGIN_PER_LOT_USD,
      maxLots: maxLots(funds),
    };
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

  app.get('/api/calibration', async () => ({ buckets: loadCalibration() }));

  app.post('/api/reload', async () => ({
    days: reloadDays(),
    calibrationBuckets: reloadCalibration(),
    horizons: reloadHorizons(),
  }));

  /** Allowed setting keys and their valid values. */
  const ALLOWED_SETTINGS: Record<string, string[]> = {
    expiry_default: ['first', 'next_entry'],
  };

  /**
   * Settings holding a number rather than one of a fixed set.
   *
   * Listed separately because an allow-list cannot express "any whole number up
   * to whatever the margin covers today", and that ceiling is the whole point:
   * the browser may ask the desk to risk less, never more.
   */
  const NUMERIC_SETTINGS = [SHORT_CAP_KEY];

  /**
   * Desk settings that survive a restart.
   *
   * GET returns every key the desk knows about. POST accepts one key/value
   * pair and validates it against the allow-list so the database never holds
   * a value nobody wrote the code to read.
   */
  app.get('/api/settings', async () => {
    const svc = tradingService();
    const out: Record<string, string | null> = {};
    for (const key of [...Object.keys(ALLOWED_SETTINGS), ...NUMERIC_SETTINGS]) {
      out[key] = svc.store.getSetting(key);
    }
    return {
      settings: out,
      /**
       * What the short cap is allowed to be, so the screen can show the room
       * rather than letting someone type a number the server will refuse.
       */
      shortCap: {
        inForce: svc.maxShortContracts,
        ceiling: svc.shortCeilingContracts,
        chosen: svc.shortCapSetting,
      },
    };
  });

  app.post('/api/settings', async (req, reply) => {
    const { key, value } = (req.body ?? {}) as { key?: string; value?: string };
    if (!key || typeof value !== 'string') {
      reply.code(400);
      return { error: 'key and value are required' };
    }

    // The short cap is a number with a ceiling rather than one of a fixed set,
    // and the ceiling moves with the balance, so the service owns the decision.
    if (key === SHORT_CAP_KEY) {
      const svc = tradingService();
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        reply.code(400);
        return { error: 'the short cap must be a whole number of contracts, at least 1' };
      }
      const res = svc.setShortCap(n);
      // Holding the line against too large a cap is the desk working, not a
      // fault, so it is marked and stays out of the error log.
      if (!res.ok) return refuse(reply, 422, { error: res.reason });
      return { ok: true, key, value: String(res.cap), shortCap: {
        inForce: res.cap, ceiling: svc.shortCeilingContracts, chosen: svc.shortCapSetting,
      } };
    }

    const allowed = ALLOWED_SETTINGS[key];
    if (!allowed) {
      reply.code(400);
      return { error: `unknown setting "${key}"` };
    }
    if (!allowed.includes(value)) {
      reply.code(400);
      return { error: `invalid value "${value}" for setting "${key}"; allowed: ${allowed.join(', ')}` };
    }
    tradingService().store.setSetting(key, value);
    return { ok: true, key, value };
  });
}
