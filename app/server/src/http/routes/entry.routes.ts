import type { FastifyInstance } from 'fastify';
import { entryBoard, timeframeRows, type TimeframeRow } from '../../entry/engine.js';
import { readEntryContext } from '../../entry/read.js';
import { entryRecord, recentSetups } from '../../entry/paper.js';
import { GateLocked, gateSettings, gatesOff, isGateKey, setGate } from '../../entry/gates.js';
import { alertSettings, isMode, setAlert } from '../../entry/alerts.js';
import { CHAIN, TF_SEC, type MethodRead, type Tf } from '../../entry/types.js';
import { ttlCache } from '../ttl-cache.js';

/**
 * The entry section's routes: the 24 reads (twelve methods, with the
 * timeframe chain and without it) and their paper record.
 */

/** Timeframes a read without the chain may be taken on. */
const SINGLE_TFS: readonly Tf[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];

/**
 * `notifier`: where a test alert is sent, or null when Telegram is not set up
 * (TG_TOKEN / TG_CHAT_ID). Passed in so the routes do not reach for the
 * trading service themselves.
 */
export function registerEntryRoutes(app: FastifyInstance, notifier: () => { send(text: string): Promise<boolean> } | null = () => null) {
  // One read per timeframe for ten seconds, whatever the number of screens asking.
  const boardCache = ttlCache<{ at: number; tf: Tf; reads: MethodRead[]; timeframes: TimeframeRow[] }>(10_000);

  // The 24 reads: each method with the timeframe chain (entry on 5m), then without it on `tf` (default 5m).
  app.get('/api/entry/board', async (req, reply) => {
    const q = req.query as { tf?: string };
    const tf = (SINGLE_TFS as readonly string[]).includes(q.tf ?? '') ? (q.tf as Tf) : '5m';
    try {
      // The switches are part of the key: a gate turned off shows on the next read, not ten seconds later.
      const off = await gatesOff().catch(() => []);
      const board = await boardCache(`${tf}|${off.join(',')}`, async () => {
        const ctx = await readEntryContext();
        return { at: ctx.now, tf, reads: entryBoard(ctx, tf), timeframes: timeframeRows(ctx) };
      });
      return { ...board, chain: CHAIN, tfSec: TF_SEC };
    } catch (e) {
      reply.code(502);
      return { error: (e as Error).message };
    }
  });

  // The hard gates' switches: every gate, whether it is on, and whether it can be turned off.
  app.get('/api/entry/gates', async () => ({ gates: await gateSettings() }));

  // Turn one gate on or off. Data fresh is locked on (422).
  app.post('/api/entry/gates/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };
    if (!isGateKey(key)) { reply.code(404); return { error: 'no such gate' }; }
    if (typeof enabled !== 'boolean') { reply.code(400); return { error: 'enabled must be true or false' }; }
    try {
      return { gates: await setGate(key, enabled) };
    } catch (e) {
      if (e instanceof GateLocked) { reply.code(422); return { error: e.message }; }
      throw e;
    }
  });

  // Telegram alerts for each way's TRADEs: whether each is on, and whether Telegram is set up at all.
  app.get('/api/entry/alerts', async () => ({ alerts: await alertSettings(), telegram: notifier() !== null }));

  app.post('/api/entry/alerts/:mode', async (req, reply) => {
    const { mode } = req.params as { mode: string };
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };
    if (mode === 'test') {
      const n = notifier();
      if (!n) { reply.code(409); return { error: 'Telegram is not set up on the server (TG_TOKEN, TG_CHAT_ID).' }; }
      const ok = await n.send('🔔 <b>Entry setups</b>: a test alert. TRADE alerts arrive like this, once per setup.');
      if (!ok) { reply.code(502); return { error: 'Telegram did not accept the message; see the error log.' }; }
      return { ok: true };
    }
    if (!isMode(mode)) { reply.code(404); return { error: 'no such way: single or mtf' }; }
    if (typeof enabled !== 'boolean') { reply.code(400); return { error: 'enabled must be true or false' }; }
    return { alerts: await setAlert(mode, enabled), telegram: notifier() !== null };
  });

  // Each method's paper record, with the chain and without it, and the latest setups written.
  app.get('/api/entry/record', async () => ({
    ...(await entryRecord()),
    recent: await recentSetups(50),
  }));
}
