import { buildApp } from './http/app.js';
import { config } from './config.js';
import { authFromEnv } from './auth/service.js';
import { loadDays } from './backtest/backtest.js';
import { credsFromEnv } from './delta/signed.js';
import { initTradingService } from './trading/service.js';
import { initStrategyStore } from './http/routes/strategy.routes.js';
import { StrategyRunner } from './strategy/runner.js';
import { liveTickers, startTickerPoller, startTickerSocket } from './market/delta.js';
import { liveChain } from './market/chain.js';
import { readMarket } from './market/moves.js';
import { marketSchema } from './market/oi-history.js';
import { errorLog } from './observability/errors.js';
import { captureOptionSnapshots, optionSnapshotsSchema } from './market/option-snapshots.js';
import { captureBoard, chainFeaturesSchema } from './market/chain-features.js';
import { wallWithinEm } from './http/routes/desk.routes.js';
import { captureIndex, indexSchema } from './market/index-1m.js';
import { capturePerpSnapshot, flowSchema, flushTradeFlow, perpTape, startFlowSocket } from './market/flow.js';
import { gradeLive } from './entry/live-grade.js';
import { bookHeatSchema, flushBookHeat, startBookHeat } from './market/book-heat.js';
import { noteError } from './observability/errors.js';
import { entrySchema, gradeSetups, onSetupFilled, recordSetups } from './entry/paper.js';
import { gatesSchema } from './entry/gates.js';
import { alertSettings, alertsSchema, sendEntryAlert, wanted } from './entry/alerts.js';
import { allReads } from './entry/engine.js';
import { telegramLogSchema } from './notify/telegram-log.js';
import { pruneSignals, recordSignals, signalsSchema } from './entry/signals.js';
import { methodsSchema } from './entry/catalogue.js';
import { readEntryContext } from './entry/read.js';

/**
 * Start the desk.
 *
 * Composition only: what the process is made of, and what it says about itself
 * on the way up. The routing lives in http/, the thinking in domain/, the
 * order path in trading/.
 */

/*
 * The database first. Every schema is migrated here, before anything listens:
 * a migration that fails stops the boot, and a desk that cannot reach its
 * journal must not take an order. `initTradingService` also loads the
 * settings cache every sync getter reads from.
 */
const desk = await initTradingService();
// The rest of the schemas, for the same reason: a table that is only created
// on the first request that needs it is a deploy that reports healthy with
// the table missing. Every ledger entry is on `/api/health` before `listen`.
await marketSchema();
await errorLog().ready;
await optionSnapshotsSchema();
await flowSchema();
// These five were migrated on their first write until 30 Sep 2026, so a fresh
// deploy reported healthy with their tables missing until a recorder ran.
await chainFeaturesSchema();
await indexSchema();
await bookHeatSchema();
await entrySchema();
await gatesSchema();
await alertsSchema();
await telegramLogSchema();
await signalsSchema();
await methodsSchema();
const strategies = await initStrategyStore();

// One sign-in service for the process: the gate and the routes share the pool.
const auth = await authFromEnv({
  // One key, not one per message: a bot working through passwords raises the
  // same lockout alert again and again, and the notifier's repeat guard only
  // recognises a repeat when the key is the same. The words differ between
  // kinds of security news, so nothing is lost by sharing it.
  onAlert: (text) => desk.notifier?.notify({ key: 'security', text }),
});
const app = await buildApp({ auth });
await app.listen({ port: config.port, host: '0.0.0.0' });

app.log.info(`chain snapshots loaded: ${loadDays().length}`);
app.log.info(
  credsFromEnv() !== null
    ? 'Delta credentials present'
    : 'no Delta credentials -- account and order endpoints are off, market data unaffected',
);
/*
 * Migrate the strategy tables on the way up, not on the first request.
 *
 * They were lazy at first, behind the route that reads them -- and the route is
 * behind the session gate, so an unauthenticated probe got a 401, the store was
 * never constructed, and a deploy came up reporting healthy with the tables
 * missing. docs/decisions/0008-one-database-one-schema.md says why this is the wrong shape: a
 * half-migrated database should stop the boot, and a migration that only runs
 * when somebody logs in cannot.
 */
app.log.info(`strategy schema: ${strategies.applied.length
  ? strategies.applied.join(', ') + ' applied'
  : 'already up to date'}`);

/*
 * The scheduler loop. Inert until `scheduler_enabled` is set, which is a
 * deliberate act with its own button, so starting it here costs nothing.
 */
const runner = new StrategyRunner(strategies);
runner.start();
/*
 * A signal "in the trade": the paper log's graders (live tape, or the candles as the backstop) report each
 * fill the moment they write it, and signal strategies that enter at the zone -- the default -- sell their leg.
 */
onSetupFilled((f) => { void runner.onSetupFilled(f).catch((e: Error) => noteError({ source: 'server', level: 'warn', where: 'signal-strategy', message: `zone entry not taken: ${e.message}` })); });

app.log.info(
  desk.mode === 'live'
    ? 'LIVE TRADING IS ON -- orders placed here reach the real exchange'
    : config.paperLocked
      ? 'paper trading, locked by DELTA_LIVE_TRADING=0 -- the switch is disabled'
      : desk.canGoLive
        ? 'paper trading -- the switch on the desk can turn this live'
        : 'paper trading -- no credentials, so live is not available',
);
app.log.info(
  await auth.configured()
    ? `sign-in required: password and authenticator code, user "${await auth.username()}", sessions last a week`
    : 'sign-in NOT set up -- the API refuses everything but /api/health and /api/me until DESK_USER, '
      + 'DESK_PASSWORD_HASH and DESK_SESSION_SECRET are set (or `npm run auth -- create` has run)',
);

app.log.info(
  config.telegram
    ? 'telegram fill alerts on'
    : 'telegram fill alerts off -- set TG_TOKEN and TG_CHAT_ID to enable',
);

// The board: the socket delivers it the moment it changes, the REST poll is
// the cold start and the fallback. Both warmed here so the first page load is
// served from memory.
startTickerPoller(8_000);
startTickerSocket((line) => app.log.info(line));
liveTickers()
  .then((t) => {
    app.log.info(`ticker cache warmed: ${t.length} BTC contracts`);
    // Pre-warm the default chain snapshot and market moves concurrently
    void liveChain().catch(() => {});
    void readMarket().catch(() => {});
  })
  .catch((e) => app.log.warn(`ticker warm-up failed (first request will retry): ${(e as Error).message}`));

/*
 * The per-strike recorder: every strike of the two nearest expiries, every
 * five minutes (docs/reference/market-data.md). Checked once a minute; the bucket guard in
 * the table makes it write once per five. Off the request path, and a failure
 * is one warning in the error log, never a stopped desk.
 */
const warn = (where: string) => (e: Error) => noteError({ source: 'server', level: 'warn', where, message: `${where} not written: ${e.message}` });
const recordOptions = () => {
  liveTickers()
    .then((t) => captureOptionSnapshots(t, Date.now()))
    .catch(warn('option-snapshots'));
  capturePerpSnapshot(Date.now()).catch(warn('perp-snapshots'));
  /*
   * BTC itself, once a minute (24 Sep 2026). Every other recorder keeps a
   * reading and carries the price as a column at its own cadence; this is the
   * price on its own, which is the series every "+350 pts" on the screen is
   * measured against. Checked on the same minute timer, and the minute is the
   * primary key, so a restart or a double tick cannot write it twice.
   */
  captureIndex(Date.now()).catch(warn('index-1m'));
};
setInterval(recordOptions, 60_000).unref();
setTimeout(recordOptions, 15_000).unref();
// The board's own record, every five minutes, viewer or no viewer: the hour-ago reads must have no gaps.
const recordBoardNow = () => { captureBoard(Date.now(), wallWithinEm()).catch(warn('board-record')); };
setInterval(recordBoardNow, 5 * 60_000).unref();
setTimeout(recordBoardNow, 25_000).unref();

/*
 * The perpetual's tape, off its own socket: every print, summed per minute
 * by which side crossed the spread, written every twenty seconds so a restart
 * loses at most that much of the hour's flow (the desk spec's order-flow section, `git show 2ed9ef2^:docs/test.md` §10).
 */
startFlowSocket((line) => app.log.info(line));
setInterval(() => { flushTradeFlow(Date.now()).catch(warn('trade-flow')); }, 20_000).unref();

/*
 * The perpetual's resting book, every ten seconds, averaged and written a
 * minute at a time: the chart's liquidity heatmap (market/book-heat.ts).
 */
startBookHeat();
setInterval(() => { flushBookHeat(Date.now()).catch(warn('book-heat')); }, 20_000).unref();

/*
 * The entry section, once a minute, on the server: every read on every
 * timeframe (the chain's twelve, and the twelve without it on 1m-4H). Every
 * WAIT and TRADE goes to the signal journal (entry/signals.ts); each new TRADE
 * to the paper log (entry/paper.ts), graded on the closed 1m candles; Telegram
 * for the ways switched on -- the chain, and without it on 5m only, so the
 * phone is not told the same market seven times. Nothing is ordered.
 */
const recordEntries = () => {
  readEntryContext()
    .then(async (ctx) => {
      // Telegram for the ways switched on and their chosen timeframes, once per setup as it is first
      // written, each attempt written down (entry_alert_log) -- sent or failed, and why.
      const settings = await alertSettings().catch(() => []);
      const reads = allReads(ctx);
      // With the market as it stood: the tape's last trade (fresh) and the option board's index.
      const fresh = ctx.ltp && ctx.now - ctx.ltp.at <= 15_000 ? ctx.ltp.price : null;
      await recordSignals(reads, ctx.now, { ltp: fresh, index: ctx.options?.spot ?? null });
      await recordSetups(reads, ctx.now, (r) => {
        if (wanted(r, settings)) void sendEntryAlert(r, desk.notifier, { ltp: ctx.ltp?.price ?? null, at: ctx.now });
        // Signal strategies take it the moment it is written -- the first sighting, once (strategy/runner.ts).
        void runner.onSignal(r).catch(warn('signal-strategy'));
      });
      await gradeSetups(ctx.frames['1m'] ?? []);
    })
    .catch(warn('entry-setups'));
};
// Aligned to the minute: three seconds after each 1m candle closes, so a new signal is written, a fill
// or an exit graded, and Telegram sent within seconds of the candle that made it -- not up to a minute later.
const ENTRY_OFFSET_MS = 3_000;
const nextEntryRun = () => {
  const wait = 60_000 - (Date.now() % 60_000) + ENTRY_OFFSET_MS;
  setTimeout(() => { recordEntries(); nextEntryRun(); }, wait).unref();
};
nextEntryRun();
// The journal keeps a year; the paper log keeps its graded trades for good.
setInterval(() => { pruneSignals(Date.now()).catch(warn('entry-signals')); }, 6 * 3_600_000).unref();
// The paper log on the live tape: fills, stops and targets the second they print (entry/live-grade.ts).
setInterval(() => { gradeLive(perpTape()).catch(warn('entry-live-grade')); }, 1_000).unref();
