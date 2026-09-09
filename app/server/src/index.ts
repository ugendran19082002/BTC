import { buildApp } from './http/app.js';
import { config } from './config.js';
import { authFromEnv } from './http/session.js';
import { loadDays } from './backtest/backtest.js';
import { credsFromEnv } from './delta/signed.js';
import { tradingService } from './trading/service.js';
import { liveTickers, startTickerPoller } from './market/delta.js';
import { liveChain } from './market/chain.js';
import { readMarket } from './market/moves.js';

/**
 * Start the desk.
 *
 * Composition only: what the process is made of, and what it says about itself
 * on the way up. The routing lives in http/, the thinking in domain/, the
 * order path in trading/.
 */

const app = await buildApp();
await app.listen({ port: config.port, host: '0.0.0.0' });

const auth = authFromEnv();
app.log.info(`chain snapshots loaded: ${loadDays().length}`);
app.log.info(
  credsFromEnv() !== null
    ? 'Delta credentials present'
    : 'no Delta credentials -- account and order endpoints are off, market data unaffected',
);
const desk = tradingService();
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
  auth.enabled
    ? `login required, user "${auth.username}", sessions last ${auth.ttl / 3600}h`
    : 'login NOT required -- set DESK_USER, DESK_PASSWORD_HASH and DESK_SESSION_SECRET to require one',
);

// Start background ticker poller and pre-warm caches so the first page load
// is served instantly from memory with zero cold-start delay.
startTickerPoller(8_000);
liveTickers()
  .then((t) => {
    app.log.info(`ticker cache warmed: ${t.length} BTC contracts`);
    // Pre-warm the default chain snapshot and market moves concurrently
    void liveChain().catch(() => {});
    void readMarket().catch(() => {});
  })
  .catch((e) => app.log.warn(`ticker warm-up failed (first request will retry): ${(e as Error).message}`));

