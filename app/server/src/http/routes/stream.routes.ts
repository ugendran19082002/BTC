import type { FastifyInstance } from 'fastify';
import { StreamHub } from '../stream.js';
import { tradingService } from '../../trading/service.js';
import { liveSpot, tickerBatchAt, tickerFeedHealth } from '../../market/delta.js';

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
 * Fully signed in, like every route: the gate runs before this handler.
 * The reply is hijacked so Fastify does not try to end it; the raw response
 * stays open until the browser goes.
 */
export const STREAM_TICK_MS = 1_000;
const PING_MS = 15_000;

export function registerStreamRoutes(app: FastifyInstance) {
  const hub = new StreamHub();
  let ticker: ReturnType<typeof setInterval> | null = null;
  let pinger: ReturnType<typeof setInterval> | null = null;

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
    ticker.unref?.();
    pinger.unref?.();
  };
  const settleTimers = () => {
    if (hub.size > 0) return;
    if (ticker) clearInterval(ticker);
    if (pinger) clearInterval(pinger);
    ticker = null;
    pinger = null;
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
    req.raw.on('close', () => {
      leave();
      settleTimers();
    });
  });

  app.addHook('onClose', async () => {
    if (ticker) clearInterval(ticker);
    if (pinger) clearInterval(pinger);
  });

  return hub;
}
