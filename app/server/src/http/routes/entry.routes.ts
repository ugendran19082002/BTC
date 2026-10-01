import type { FastifyInstance } from 'fastify';
import { SINGLE_TFS, VIEW_ONLY_TFS, entryBoard, timeframeRows, type TimeframeRow } from '../../entry/engine.js';
import { readEntryContext } from '../../entry/read.js';
import { entryRecord, recentSetups } from '../../entry/paper.js';
import { GateLocked, gateSettings, gatesOff, isGateKey, setGate } from '../../entry/gates.js';
import { alertSettings, isMode, recentAlerts, sampleAlertText, setAlert } from '../../entry/alerts.js';
import { clockKeyOf, exportSignals, isSignalSort, setupClocks, signalPage, signalsCsv, type SignalQuery } from '../../entry/signals.js';
import { CHAIN, TF_SEC, type MethodRead, type SetupClock, type Tf } from '../../entry/types.js';
import { ttlCache } from '../ttl-cache.js';

/**
 * The entry section's routes: the 24 reads (twelve methods, with the
 * timeframe chain and without it) and their paper record.
 */


/**
 * `notifier`: where a test alert is sent, or null when Telegram is not set up
 * (TG_TOKEN / TG_CHAT_ID). Passed in so the routes do not reach for the
 * trading service themselves.
 */
export function registerEntryRoutes(app: FastifyInstance, notifier: () => { send(text: string): Promise<boolean> } | null = () => null) {
  // One read per timeframe for three seconds, whatever the number of screens asking (a read is ~50 ms).
  const boardCache = ttlCache<{ at: number; tf: Tf; reads: MethodRead[]; timeframes: TimeframeRow[]; ltp: { price: number; at: number } | null }>(3_000);

  // The 24 reads: each method with the timeframe chain (entry on 5m), then without it on `tf` (default 5m).
  app.get('/api/entry/board', async (req, reply) => {
    const q = req.query as { tf?: string };
    const tf = ([...SINGLE_TFS, ...VIEW_ONLY_TFS] as readonly string[]).includes(q.tf ?? '') ? (q.tf as Tf) : '5m';
    // 1m is a chart only: the twelve with the chain as ever, none without it.
    const viewOnly = VIEW_ONLY_TFS.includes(tf);
    try {
      // The switches are part of the key: a gate turned off shows on the next read, not ten seconds later.
      const off = await gatesOff().catch(() => []);
      const board = await boardCache(`${tf}|${off.join(',')}`, async () => {
        const ctx = await readEntryContext();
        const reads = entryBoard(ctx, tf);
        // Each TRADE's paper-log clock, for the panel's counter; the board stands without it if the read fails.
        const clocks = await setupClocks(reads).catch(() => new Map<string, SetupClock>());
        const withClocks = reads.map((r) => (r.state === 'TRADE' ? { ...r, paper: clocks.get(clockKeyOf(r)) ?? null } : r));
        return { at: ctx.now, tf, reads: withClocks, timeframes: timeframeRows(ctx), ltp: ctx.ltp ?? null };
      });
      return { ...board, viewOnly, chain: CHAIN, tfSec: TF_SEC };
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
  app.get('/api/entry/alerts', async () => ({ alerts: await alertSettings(), telegram: notifier() !== null, recent: await recentAlerts(20) }));

  app.post('/api/entry/alerts/:mode', async (req, reply) => {
    const { mode } = req.params as { mode: string };
    const { enabled, tfs } = (req.body ?? {}) as { enabled?: unknown; tfs?: unknown };
    if (mode === 'test') {
      const n = notifier();
      if (!n) { reply.code(409); return { error: 'Telegram is not set up on the server (TG_TOKEN, TG_CHAT_ID).' }; }
      // A made-up signal in the real format, marked TEST: what a TRADE will look like on the phone.
      const ok = await n.send(sampleAlertText());
      if (!ok) { reply.code(502); return { error: 'Telegram did not accept the message; see the error log.' }; }
      return { ok: true };
    }
    if (!isMode(mode)) { reply.code(404); return { error: 'no such way: single or mtf' }; }
    if (typeof enabled !== 'boolean') { reply.code(400); return { error: 'enabled must be true or false' }; }
    if (tfs !== undefined && (!Array.isArray(tfs) || !tfs.every((t) => typeof t === 'string'))) {
      reply.code(400); return { error: 'tfs must be a list of timeframes' };
    }
    try {
      return { alerts: await setAlert(mode, enabled, Date.now(), tfs as string[] | undefined), telegram: notifier() !== null, recent: await recentAlerts(20) };
    } catch (e) {
      reply.code(422); return { error: (e as Error).message };
    }
  });

  // The signal journal: every WAIT and TRADE shown, newest first; filter by mode, tf, state.
  app.get('/api/entry/signals', async (req) => signalPage(signalQueryOf(req.query)));

  // The same history as a spreadsheet: every row the filters match, in the table's order, not just a page.
  app.get('/api/entry/signals.csv', async (req, reply) => {
    const { rows: all } = await exportSignals(signalQueryOf(req.query));
    const day = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="signal-history-${day}.csv"`);
    reply.header('Cache-Control', 'no-store');
    return signalsCsv(all);
  });

  // Each method's paper record, with the chain and without it, and the latest setups written.
  app.get('/api/entry/record', async () => ({
    ...(await entryRecord()),
    recent: await recentSetups(50),
  }));
}

/** The history's filters from a query string: each checked against its own list, anything else dropped. */
function signalQueryOf(query: unknown): SignalQuery {
  const q = (query ?? {}) as Record<string, string | undefined>;
  const num = (v?: string) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    limit: num(q.limit) ?? 100,
    offset: num(q.offset),
    mode: q.mode && isMode(q.mode) ? q.mode : undefined,
    tf: q.tf && (SINGLE_TFS as readonly string[]).includes(q.tf) ? q.tf : undefined,
    state: q.state === 'WAIT' || q.state === 'TRADE' ? q.state : undefined,
    dir: q.dir === '1' || q.dir === '-1' ? Number(q.dir) : undefined,
    since: num(q.since),
    live: q.live === 'true',
    sort: isSignalSort(q.sort) ? q.sort : undefined,
    asc: q.asc === 'true',
  };
}

