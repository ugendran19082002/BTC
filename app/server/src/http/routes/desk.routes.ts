import type { FastifyInstance } from 'fastify';
import { liveChain, historicalChain, liveExpiries, hoursSinceDeskOpen, simulationBacklog, WHOLE_BOARD, type Snapshot } from '../../market/chain.js';
import { readMarket, seriesForAnalytics } from '../../market/moves.js';
import { measuredOutlook } from '../../analytics/client.js';
import { liveSpot, liveTickers, candles, tickerFeedHealth } from '../../market/delta.js';
import { scoreLegs, pickSells, bias, verdict, maxLots, MARGIN_PER_LOT_USD, USDINR } from '../../domain/score.js';
import { recommend, type PickMode } from '../../domain/recommend.js';
import { DEFAULT_WALL_WITHIN_EM, optionStructure } from '../../domain/structure.js';
import { forecast, reloadHorizons } from '../../domain/forecast.js';
import { loadCalibration, reloadCalibration } from '../../domain/calibration.js';
import { loadDays, reloadDays, DEFAULTS } from '../../backtest/backtest.js';
import { tradingService, SHORT_CAP_KEY } from '../../trading/service.js';
import { appliedMigrations } from '../../db/migrate.js';
import { termStructure } from '../../market/term.js';
import { lastOptionSnapshot, lastOptionSnapshotAt } from '../../market/option-snapshots.js';
import { flowFeedHealth, flowSummary, ivRank, liveBook, livePerp, oiPulse, optionFlowSummary, skewRank } from '../../market/flow.js';
import { movementByWindow } from '../../market/movement.js';
import { changes } from '../../market/changes.js';
import { one } from '../../db/pool.js';
import { strategyStore } from './strategy.routes.js';
import { refuse } from '../refuse.js';
import { emBuffer, verdict as sideVerdict } from '../../domain/direction.js';
import { DEFAULT_LIMITS } from '../../trading/precheck.js';
import { bestTradeNow } from '../../domain/best-trade-now.js';
import { outlook, withMeasured } from '../../domain/outlook.js';
import { pBetween } from '../../domain/probability.js';
import { attachEv } from '../../domain/ev.js';
import { noteOpenInterest, openInterestChange, ivChange, type OiChange } from '../../market/oi-history.js';
import { chainBoard, recordBoard } from '../../market/chain-features.js';
import { SHOCK_WINDOWS } from '../../domain/shock.js';
import { shockFrom } from '../../market/shock-now.js';

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

/** Where the level band is remembered. A desk setting, like the short cap. */
export const WALL_WITHIN_EM_KEY = 'wall_within_em';

/** The band in force: how far a wall may sit and still be a level, in expected moves. */
export function wallWithinEm(): number {
  const raw = Number(tradingService().settings.get(WALL_WITHIN_EM_KEY));
  return Number.isFinite(raw) && raw >= 0.25 && raw <= 20 ? raw : DEFAULT_WALL_WITHIN_EM;
}

export function registerDeskRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    const days = loadDays();
    // One round trip, timed: a database that answers slowly is the first sign
    // of one about to stop answering, and it should be readable from outside.
    const t0 = Date.now();
    const db = await one('SELECT 1 AS ok')
      .then(() => ({ ok: true, latencyMs: Date.now() - t0 }))
      .catch((e: Error) => ({ ok: false, latencyMs: Date.now() - t0, error: e.message }));
    const optionSnapshots = db.ok ? await lastOptionSnapshot().catch(() => null) : null;
    return {
      ok: true,
      db,
      optionSnapshots,
      days: days.length,
      first: days[0]?.date ?? null,
      last: days[days.length - 1]?.date ?? null,
      // Which schema the database is on. A container that started against an
      // older database should be visible from outside rather than by symptom.
      schema: db.ok ? (await appliedMigrations()).map((m) => m.id) : [],
      // Both stores share one ledger, but only asking the trade store hid a
      // deploy whose strategy tables had never been created.
      strategies: db.ok ? (await strategyStore().all()).length : 0,
      // Where the board is coming from, and whether the simulation is keeping
      // up. A feed that has fallen back to polling should be visible from
      // outside rather than by a board that is eight seconds old.
      feed: tickerFeedHealth(),
      flowFeed: flowFeedHealth(),
      simulationBacklog: simulationBacklog(),
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

  /**
   * What changed over 1m … 12h for BTC, one strike and its board, from the
   * desk's own records. The caller may pass the live figures for "now" so the
   * newest change is against the board on screen, not the last 5-minute row.
   */
  app.get('/api/changes', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const symbol = String(q.symbol ?? '');
    if (!/^[CP]-BTC-\d+-\d{6}$/.test(symbol)) return refuse(reply, 400, { error: 'symbol like C-BTC-78000-190926' });
    const expiry = symbol.split('-').pop()!;
    const n = (k: string) => { const v = Number(q[k]); return Number.isFinite(v) ? v : undefined; };
    // `entry`: the strategy's entry moment, epoch ms, for the since-entry row.
    const entry = n('entry');
    return changes(symbol, expiry, Date.now(), {
      spot: n('spot'), mark: n('mark'), oi: n('oi'), iv: n('iv'), volume: n('volume'),
      ceOi: n('ceOi'), peOi: n('peOi'), callVolume: n('callVolume'), putVolume: n('putVolume'), pcr: n('pcr'), atmIv: n('atmIv'),
    }, entry ?? null);
  });

  /**
   * ATM IV across every listed expiry, from the live board, with the skew's
   * and the IV's rank among every reading the desk has recorded.
   *
   * It used to carry "a week ago" and "a month ago" lines too, read from
   * `iv_term_snapshots`. The card that showed them was removed on 22 September
   * and the table on the 23rd (`market-009`), so the two questions this asked
   * the database every minute, per open browser, are gone with them. The ranks
   * are read from `chain_features`, which plenty else needs.
   */
  app.get('/api/term', async (req, reply) => {
    try {
      const now = Date.now();
      const q = req.query as { skewPts?: string; atmIv?: string };
      const skewPts = Number(q.skewPts);
      const atmIv = Number(q.atmIv);
      const [tickers, skew, iv] = await Promise.all([
        liveTickers(),
        skewRank(Number.isFinite(skewPts) ? skewPts : null).catch(() => null),
        ivRank(Number.isFinite(atmIv) && atmIv > 0 ? atmIv : null).catch(() => null),
      ]);
      return { at: now, points: termStructure(tickers, Math.floor(now / 1000)), skew, iv };
    } catch (e) {
      reply.code(502);
      return { error: (e as Error).message };
    }
  });

  /**
   * The perpetual: its ticker (funding, open interest, turnover), the top of
   * its book, and the last hour's order flow by aggressor side. The three
   * things docs/test.md §10 names as the desk's biggest gap; the flow is
   * summed from every print on the socket, and says how many of the sixty
   * minutes it actually has.
   */
  /**
   * The character of the move by window -- long buildup, short covering,
   * short buildup, long unwinding, or mixed -- from the perpetual's price,
   * open interest and tape. Strength from volume against the day's pace; the
   * aggressor read beside it as confirmation.
   */
  app.get('/api/movement', async (req, reply) => {
    try {
      const q = req.query as { entry?: string; expiry?: string };
      const now = Date.now();
      // The desk's marks for the price-change table: the entry window (epoch ms) and the contract's day start,
      // the previous 17:30 IST settlement -- a day before the expiry's own (epoch seconds).
      const entryMs = /^\d{12,13}$/.test(q.entry ?? '') ? Number(q.entry) : null;
      const expiryTs = /^\d{9,10}$/.test(q.expiry ?? '') ? Number(q.expiry) : null;
      const dayStartMs = expiryTs === null ? null : expiryTs * 1000 - 24 * 3_600_000;
      return await movementByWindow(now, { entryMs, dayStartMs });
    } catch (e) { reply.code(502); return { error: (e as Error).message }; }
  });

  app.get('/api/perp', async (req, reply) => {
    try {
      const now = Date.now();
      const q = req.query as { window?: string; expiry?: string };
      // Up to a day: the contract's whole life, or since the desk opened.
      const windowMin = Math.min(1440, Math.max(5, Number(q.window ?? 60) || 60));
      const expiry = /^\d{6}$/.test(q.expiry ?? '') ? q.expiry! : null;
      const [ticker, book, flow, oi, optionFlow] = await Promise.all([
        livePerp(now).catch(() => null),
        liveBook(now).catch(() => null),
        flowSummary(windowMin, now),
        expiry ? oiPulse(expiry, now).catch(() => null) : Promise.resolve(null),
        expiry ? optionFlowSummary(expiry, windowMin, now).catch(() => null) : Promise.resolve(null),
      ]);
      return { at: now, ticker, book, flow, oi, optionFlow };
    } catch (e) {
      reply.code(502);
      return { error: (e as Error).message };
    }
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
      /*
       * The whole board is read; `width` only decides how much of it is sent.
       *
       * The two are different questions. How many rows the chain table should
       * show is a preference; where the open interest sits is a fact about the
       * expiry, and answering it from a window meant the desk's own
       * open-interest wall moved when somebody changed the table size -- and
       * disagreed with the strategy, which read a window of its own. Everything
       * computed below sees every listed strike; only `legs` is trimmed.
       */
      const width = Number(q.width ?? 12);
      const shown = Number.isFinite(width) ? Math.max(1, width) : 12;
      const snap = await snapshotFor(q.at, WHOLE_BOARD, q.expiry || undefined);
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
      // The day's move is measured from 05:30 IST, like every other "today".
      const market = snap.live
        ? await readMarket(hoursSinceDeskOpen(snap.ts)).catch(() => null)
        : null;

      // The margin model needs a spot, and the chain is where one arrives.
      if (snap.live) tradingService().noteSpot(snap.spot);

      /*
       * Open interest, remembered so a change can be read at all -- Delta's
       * ticker carries the current figure and no previous one.
       *
       * Live boards only. A historical snapshot reading today's buckets would
       * report a change that happened after the moment being looked at, and
       * writing into them would file a past board's open interest under now.
       */
      let oiChanges = new Map<string, OiChange>();
      let iv: Awaited<ReturnType<typeof ivChange>> = null;
      if (snap.live) {
        await noteOpenInterest({ ...snap, atmIv: snap.atmIv }, scored);
        oiChanges = await openInterestChange(snap, scored, 1);
        iv = await ivChange({ expiry: snap.expiry, ts: snap.ts, atmIv: snap.atmIv }, 15);
      }

      const recommendation = recommend(snap, scored, market, minPremium, lots, hedgeGap, mode, safetyBar);
      const structure = optionStructure(snap, market?.realisedVol ?? null, wallWithinEm());

      /*
       * Is there a side today, and would the desk's own gates take it?
       *
       * Description, not instruction: what the lots actually do is still
       * `recommendation.split`, which carries the 733-day record. This is the
       * reading a person does before trusting it -- and the answer on most days
       * is "no side", which is the point. See `domain/direction.ts`.
       */
      const shorts = {
        ce: recommendation.sides.find((x) => x.side === 'CE')?.leg.strike ?? null,
        pe: recommendation.sides.find((x) => x.side === 'PE')?.leg.strike ?? null,
      };
      const spreads = recommendation.sides
        .map((x) => {
          const leg = x.leg;
          const mid = leg.bid != null && leg.ask != null ? (leg.bid + leg.ask) / 2 : null;
          return mid && mid > 0 && leg.ask != null && leg.bid != null ? (leg.ask - leg.bid) / mid : null;
        })
        .filter((v): v is number => v !== null);
      const direction = sideVerdict({
        market,
        snap,
        shorts,
        execution: {
          worstSpreadPct: spreads.length ? Math.max(...spreads) : null,
          quoteAgeMs: null,
          hedged: recommendation.hedgeMissing ? false : null,
        },
        maxSpreadPct: DEFAULT_LIMITS.maxSpreadPct,
      });

      /*
       * The corridor: the chance BTC finishes between the two strikes the desk
       * would sell. `recommendation.bothZeroChance` is the same fact reached
       * from the two one-sided probabilities; this is it stated as the corridor
       * itself, with the expected move beside it for scale.
       */
      /*
       * One trade, named, with the six numbers it was chosen on.
       *
       * Ranked on arithmetic that has never been through the cross-period
       * screen -- the card says so -- and hedged the same way the engine
       * hedges, by counting listed strikes.
       */
      // The same function the watcher uses, so the phone and the screen can
      // never name different strikes for the same board. The premium floor is
      // the card's own setting, not the chain's.
      const best = bestTradeNow({
        snap, market, lots, hedgeGap, minPremiumUsd: tradingService().bestTradeMinPremiumUsd,
      });

      const containment = shorts.ce !== null && shorts.pe !== null && snap.atmIv !== null
        ? {
            low: shorts.pe,
            high: shorts.ce,
            probability: pBetween(snap.spot, shorts.pe, shorts.ce, snap.tte, snap.atmIv),
            lowBuffer: emBuffer(snap.spot, shorts.pe, snap.expectedMove),
            highBuffer: emBuffer(snap.spot, shorts.ce, snap.expectedMove),
          }
        : null;

      /*
       * Down / Side / Up, measured, from the analytics service -- display only.
       * Node's own outlook is built first and stands on its own; the service's
       * rows are attached to it when they arrive inside the client's timeout,
       * and simply absent when they do not.
       */
      const ownOutlook = outlook({ snap, market });
      const settlement = ownOutlook.rows.find((r) => r.isExpiry);

      /*
       * The option board, as raw marks and volumes.
       *
       * The service buckets it with the functions that labelled 735 mornings of
       * chain.db, and only a reading that held in all three years may move a
       * figure -- which, measured on 17 September, is the implied move alone,
       * and only on the settlement card. The rest is context on the screen.
       *
       * Recorded on a live board (never a past one, which would file an old
       * chain under now), because the readings nobody can measure yet -- open
       * interest, its change, the walls, max pain -- have no history at all
       * until this has been running for a year.
       */
      const board = chainBoard(snap, scored);
      if (snap.live) await recordBoard(snap, scored, structure, oiChanges);

      const feed = tickerFeedHealth();
      const measured = await measuredOutlook({
        now: Date.now(),
        spot: snap.spot,
        series: seriesForAnalytics(),
        extra: settlement ? [{ label: settlement.label, minutes: settlement.minutes }] : [],
        chain: board,
      });

      const fullOutlook = withMeasured(ownOutlook, measured);
      return {
        snapshot: { ...snap, legs: undefined },
        legs: attachEv(scored, {
          spot: snap.spot, lots, minPremium,
          atmIv: snap.atmIv, expectedMove: snap.expectedMove,
        })
          .filter((l) => Math.abs(l.off) <= shown)
          .map((l) => ({ ...l, oiChange: oiChanges.get(`${l.cp}${l.strike}`) ?? null })),
        bias: bias(snap, scored),
        picks,
        market,
        structure,
        /*
         * Every window, not one.
         *
         * Five minutes says whether something is happening *now*; four hours
         * says whether the session has been unusual, and they are different
         * questions. The readings are arithmetic over series already fetched,
         * so computing all four costs nothing measurable and lets the screen
         * switch between them without going back to the server.
         */
        shocks: SHOCK_WINDOWS.map((window) => shockFrom({
          snap,
          market,
          structure,
          oiChanges,
          iv: iv && {
            changePct: iv.changePct, overMinutes: iv.overMinutes,
            from: iv.from, to: iv.to,
          },
          window,
        })),
        forecast: forecast(snap),
        direction,
        containment,
        best,
        /*
         * Where BTC could be at each horizon: the implied band, the measured
         * one, and how often the measured distribution finished inside the
         * implied. Prediction only -- the options risk and the trade's
         * eligibility are separate answers from separate files, and mixing
         * them into one number is how "the market looks bullish" becomes
         * "sell this put".
         */
        outlook: fullOutlook,
        recommendation,
        requireHedge,
        verdict: verdict(snap, picks, minPremium, lots, market, {
          requireHedge,
          hedgeMissing: recommendation.hedgeMissing,
        }),
        usdinr: USDINR,
        /*
         * How old each thing on the screen is, as epoch ms, so the bar can say
         * "market 2s · chain 4s · OI 3m · model 2d" and go amber when one of
         * them is not moving. Null where there is no record yet; null as a
         * whole on a past snapshot, where age means nothing.
         */
        freshness: snap.live ? {
          // The newer of the two feeds: a dead socket's last message must not
          // age a board the REST poll refreshed seconds ago ("market 1d", 22 Sep).
          marketAt: Math.max(feed.lastMessageAt ?? 0, feed.batchAt ?? 0) || null,
          chainAt: snap.ts * 1000,
          oiAt: await lastOptionSnapshotAt(),
          modelAt: fullOutlook.model?.measuredAt && Number.isFinite(Date.parse(fullOutlook.model.measuredAt)) ? Date.parse(fullOutlook.model.measuredAt) : null,
        } : null,
      };
    } catch (e) {
      const msg = (e as Error).message;
      // A stale expiry from the browser is not a bug — it happens whenever the
      // page was left open past settlement. Mark it deliberate so it stays out
      // of the error log, and answer 404 so the browser knows to refresh.
      if (msg.includes('no live contracts for expiry')) {
        return refuse(reply, 404, { error: msg });
      }
      // The upstream exchange being unreachable is not a client mistake.
      if (msg.includes('ticker feed empty') || msg.includes('delta request failed')) {
        reply.code(502);
        return { error: msg };
      }
      reply.code(400);
      return { error: msg };
    }
  });

  /**
   * BTC bars for the chart under the board, at the three resolutions the screen
   * offers. Public data, same feed the chain and the multi-timeframe read use.
   *
   * The span is fixed per resolution rather than taken from the query: the
   * chart is there to put the open-interest walls against recent price, and a
   * caller free to ask for a year of 1m bars is a caller who can hang the page.
   */
  app.get('/api/candles', async (req, reply) => {
    const q = req.query as { tf?: string };
    // Roughly 100-160 bars each, which is what fits the width legibly. A
    // caller free to ask for a year of 1m bars is a caller who can hang the
    // page, so the span belongs to the resolution rather than to the query.
    const spans: Record<string, { resolution: string; hours: number }> = {
      // Enough bars to zoom *out* into, not just enough to fill the width:
      // a chart you cannot pull back from is a chart that hides the context.
      '1m': { resolution: '1m', hours: 8 },
      '5m': { resolution: '5m', hours: 36 },
      '15m': { resolution: '15m', hours: 96 },
      '30m': { resolution: '30m', hours: 24 * 7 },
      '1h': { resolution: '1h', hours: 24 * 14 },
      '4h': { resolution: '4h', hours: 24 * 60 },
      '1d': { resolution: '1d', hours: 24 * 150 },
    };
    const tf = spans[q.tf ?? '5m'] ? (q.tf ?? '5m') : '5m';
    const span = spans[tf]!;
    const now = Math.floor(Date.now() / 1000);
    try {
      const bars = await candles('BTCUSD', now - span.hours * 3600, now, span.resolution);
      return { tf, resolution: span.resolution, bars };
    } catch (e) {
      // The chart is decoration around a board that still works without it.
      reply.code(502);
      return { error: (e as Error).message, tf, resolution: span.resolution, bars: [] };
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
  const NUMERIC_SETTINGS = [SHORT_CAP_KEY, WALL_WITHIN_EM_KEY];

  /**
   * Desk settings that survive a restart.
   *
   * GET returns every key the desk knows about. POST accepts one key/value
   * pair and validates it against the allow-list so the database never holds
   * a value nobody wrote the code to read.
   */
  app.get('/api/settings', async () => {
    const svc = tradingService();
    /*
     * Read the account before quoting a ceiling from it.
     *
     * The ceiling is "what margin can carry", which is what is free plus what
     * is already committed to open shorts. Both figures are remembered from the
     * last time something asked the exchange, and this route asked for neither
     * -- so a card that loaded just after a restart was told the desk was flat
     * and quoted a cap of 332 while 425 contracts were short. A cap below the
     * position it is capping is not a number anybody can act on.
     *
     * Both calls are cached for well under a second, so this costs nothing on
     * a screen that polls.
     */
    await Promise.all([
      svc.positionsForDisplay().catch(() => []),
      svc.balance().catch(() => 0),
    ]);
    const out: Record<string, string | null> = {};
    for (const key of [...Object.keys(ALLOWED_SETTINGS), ...NUMERIC_SETTINGS]) {
      out[key] = svc.settings.get(key);
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
    /*
     * How far a wall may sit and still be drawn as support or resistance, in
     * expected moves. A fraction, not a whole number: half an expected move is
     * a reasonable band on a quiet afternoon.
     */
    if (key === WALL_WITHIN_EM_KEY) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0.25 || n > 20) {
        reply.code(400);
        return { error: 'The level band must be between 0.25 and 20 expected moves.' };
      }
      await tradingService().settings.set(WALL_WITHIN_EM_KEY, String(n));
      return { ok: true, key, value: String(n) };
    }

    if (key === SHORT_CAP_KEY) {
      const svc = tradingService();
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        reply.code(400);
        return { error: 'the short cap must be a whole number of contracts, at least 1' };
      }
      const res = await svc.setShortCap(n);
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
    await tradingService().settings.set(key, value);
    return { ok: true, key, value };
  });
}
