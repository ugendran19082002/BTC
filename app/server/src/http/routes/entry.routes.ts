import type { FastifyInstance } from 'fastify';
import { entryBoard } from '../../entry/engine.js';
import { readEntryContext } from '../../entry/read.js';
import { entryRecord, recentSetups } from '../../entry/paper.js';
import { CHAIN, TF_SEC, type MethodRead, type Tf } from '../../entry/types.js';
import { ttlCache } from '../ttl-cache.js';

/**
 * The entry section's routes: the 24 reads (twelve methods, with the
 * timeframe chain and without it) and their paper record.
 */

/** Timeframes a read without the chain may be taken on. */
const SINGLE_TFS: readonly Tf[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];

export function registerEntryRoutes(app: FastifyInstance) {
  // One read per timeframe for ten seconds, whatever the number of screens asking.
  const boardCache = ttlCache<{ at: number; tf: Tf; reads: MethodRead[] }>(10_000);

  // The 24 reads: each method with the timeframe chain (entry on 5m), then without it on `tf` (default 5m).
  app.get('/api/entry/board', async (req, reply) => {
    const q = req.query as { tf?: string };
    const tf = (SINGLE_TFS as readonly string[]).includes(q.tf ?? '') ? (q.tf as Tf) : '5m';
    try {
      const board = await boardCache(tf, async () => {
        const ctx = await readEntryContext();
        return { at: ctx.now, tf, reads: entryBoard(ctx, tf) };
      });
      return { ...board, chain: CHAIN, tfSec: TF_SEC };
    } catch (e) {
      reply.code(502);
      return { error: (e as Error).message };
    }
  });

  // Each method's paper record, with the chain and without it, and the latest setups written.
  app.get('/api/entry/record', async () => ({
    records: await entryRecord(),
    recent: await recentSetups(50),
  }));
}
