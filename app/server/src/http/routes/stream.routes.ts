import type { FastifyInstance } from 'fastify';
import { StreamHub } from '../stream.js';
import { tradingService } from '../../trading/service.js';
import { liveSpot, tickerBatchAt, tickerFeedHealth } from '../../market/delta.js';
import { liveLtp } from '../../market/flow.js';

/**
 * `GET /api/stream` -- the status, the price and "the board changed", pushed.
 *
 * One tick a second, the same clock the polls used, but a tick only writes
 * what differs from the last one written (`StreamHub.publish`). The status
 * comes from the service's background answer, so a tick costs a JSON
 * comparison and nothing else; the price from the ticker cache; the board
 * event is the batch time, which is enough for a tab to know its chain is
 * behind.
 *
 * `ltp` is faster: the perpetual's last trade and the 1m / 5m candles in
 * progress, built from the tape, checked four times a second and written only
 * when a new trade has printed. The chart's forming candle is drawn from it,
 * so its close, high and low are the perp's own trades -- not the index spot,
 * which differs by the basis and refreshes every eight seconds.
 *
 * Fully signed in, like every route: the gate runs before this handler.
 * The reply is hijacked so Fastify does not try to end it; the raw response
 * stays open until the browser goes.
 */
export const STREAM_TICK_MS = 1_000;
export const LTP_TICK_MS = 250;
const PING_MS = 15_000;

export function registerStreamRoutes(app: FastifyInstance) {
  const hub = new StreamHub();
  let ticker: ReturnType<typeof setInterval> | null = null;
  let pinger: ReturnType<typeof setInterval> | null = null;
  let ltpTimer: ReturnType<typeof setInterval> | null = null;
  let lastLtpKey = '';

  const ltpTick = () => {
    if (hub.size === 0) return;
    const now = Date.now();
    const live = liveLtp(now);
    // A new trade, or a candle boundary passed with none: either changes what the chart shows.
    if (!live) return;
    const key = `${live.at}:${Math.floor(now / 60_000)}`;
    if (key === lastLtpKey) return;
    lastLtpKey = key;
    hub.publish('ltp', live);
  };

  const tick = async () => {
    if (hub.size === 0) return;
    const svc = tradingService();
    const [status, spot] = await Promise.all([
      svc.status<unknown>().catch(() => null),
      liveSpot().catch(() => null),
    ]);
    if (status !== null) hub.publish('status', status);
    if (spot !== null) hub.publish('spot', { spot });
    const feed = tickerFeedHealth();
    hub.publish('board', { at: tickerBatchAt(), source: feed.source });
  };

  // The timers run only while someone is listening; an empty hub costs nothing.
  const ensureTimers = () => {
    ticker ??= setInterval(() => { void tick(); }, STREAM_TICK_MS);
    pinger ??= setInterval(() => hub.ping(), PING_MS);
    ltpTimer ??= setInterval(ltpTick, LTP_TICK_MS);
    ticker.unref?.();
    pinger.unref?.();
    ltpTimer.unref?.();
  };
  const settleTimers = () => {
    if (hub.size > 0) return;
    if (ticker) clearInterval(ticker);
    if (pinger) clearInterval(pinger);
    if (ltpTimer) clearInterval(ltpTimer);
    ticker = null;
    pinger = null;
    ltpTimer = null;
    lastLtpKey = '';
  };

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx reads this and stops buffering the response, at every layer,
      // without a config change on either proxy.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const leave = hub.add({ write: (chunk) => { res.write(chunk); } });
    ensureTimers();
    void tick();
    ltpTick();
    req.raw.on('close', () => {
      leave();
      settleTimers();
    });
  });

  app.addHook('onClose', async () => {
    if (ticker) clearInterval(ticker);
    if (pinger) clearInterval(pinger);
    if (ltpTimer) clearInterval(ltpTimer);
  });

  return hub;
}
