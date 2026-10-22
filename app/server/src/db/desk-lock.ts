import pg from 'pg';
import { config } from '../config.js';

/**
 * One desk trading at a time (22 Oct 2026, the architecture plan's step 3: "a single active SL executor with safe
 * failover").
 *
 * Every order the desk sends comes from one process: the stop watch, the loop, the strategies, the ticket. Two of them
 * against the same accounts -- a second container started by mistake, a laptop pointed at this database, a deploy
 * that overlaps -- would each send every stop, and Delta would fill both. So the process takes a PostgreSQL advisory
 * lock, on a connection of its own, before it does anything else (index.ts): before the migrations, before the
 * exchange is spoken to. A second process waits there, as a standby, until the lock is free; then it boots as the first
 * did, and the boot's own recovery (`engine.recover()`) reads every open trade back from Delta before anything is
 * acted on -- a takeover is a restart, not a hand-over of memory.
 *
 * Held, it is kept honest three ways:
 *   - a heartbeat (`SELECT 1`, every `HEARTBEAT_MS`) on the lock's connection, and that connection's end or error, mean
 *     the lock may be gone: the process is told (`onLost`; index.ts exits, and Docker starts it again to wait its turn);
 *   - every write to Delta asks `deskLockOk()` first (`delta/signed.ts`): a process whose heartbeat has not answered
 *     for `FRESH_MS` -- frozen, or cut off -- sends no order, cancel or edit, though it has not noticed yet;
 *   - a waiting process that finds the holder's connection silent past `STALE_MS` -- its heartbeat stopped, a process
 *     that hung or a container gone without closing its socket -- ends that session (`pg_terminate_backend`) and takes
 *     the lock, rather than wait for the server's own TCP timeout, which is hours.
 *
 * The migrations' own lock (`db/migrate.ts`) is another key, held only while they run.
 */

/** The lock's two keys: 'btcd', and which lock of the desk's. */
export const DESK_LOCK_KEYS = [0x6274_6364, 2] as const;
export const HEARTBEAT_MS = 5_000;
/** A heartbeat older than this and the process sends nothing to Delta. */
export const FRESH_MS = 15_000;
/** A holder silent this long is taken to be gone. Six missed heartbeats. */
export const STALE_MS = 30_000;
export const RETRY_MS = 2_000;

export type DeskLock = {
  /** Held, with a heartbeat answered inside `FRESH_MS`. */
  ok(): boolean;
  /** Let it go: for a test, or a process shutting down on purpose. */
  release(): Promise<void>;
};

type Holder = { pid: number; idleMs: number; app: string; addr: string | null };

let armed: DeskLock | null = null;

/** Whether this process may write to Delta: always, until a lock is taken (a test, a script); then only while it is held. */
export const deskLockOk = (): boolean => (armed ? armed.ok() : true);

export async function takeDeskLock(o: {
  log: (msg: string, fields?: Record<string, unknown>) => void;
  onLost: (why: string) => void;
  connect?: () => pg.Client;
  now?: () => number;
  heartbeatMs?: number; freshMs?: number; staleMs?: number; retryMs?: number;
} ): Promise<DeskLock> {
  const now = o.now ?? Date.now;
  const heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS, freshMs = o.freshMs ?? FRESH_MS, staleMs = o.staleMs ?? STALE_MS, retryMs = o.retryMs ?? RETRY_MS;
  const client = (o.connect ?? (() => new pg.Client({
    connectionString: config.databaseUrl ?? undefined,
    application_name: 'btc-desk-api lock',
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  })))();
  let held = false, lost = false, lastOk = 0;
  let beat: NodeJS.Timeout | null = null;
  const lose = (why: string) => {
    if (lost) return;
    lost = true;
    held = false;
    if (beat) { clearInterval(beat); beat = null; }
    o.log(`desk lock lost: ${why} -- this process sends nothing more to Delta`, { deskLock: 'lost' });
    try { o.onLost(why); } catch { /* the fence above already holds */ }
  };
  client.on('error', (e) => lose(`its connection failed (${e.message})`));
  client.on('end', () => lose('its connection ended'));
  await client.connect();
  // The server's side of the same watch: a peer gone without a word is noticed in about half a minute, not two hours.
  await client.query('SET tcp_keepalives_idle = 10; SET tcp_keepalives_interval = 5; SET tcp_keepalives_count = 3');

  const holder = async (): Promise<Holder | null> => {
    const r = await client.query<{ pid: number; idle_ms: number; app: string; addr: string | null }>(
      `SELECT a.pid, (EXTRACT(EPOCH FROM (now() - a.state_change)) * 1000)::bigint AS idle_ms,
              a.application_name AS app, host(a.client_addr) AS addr
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2 AND l.objsubid = 2 AND l.granted
          AND l.pid <> pg_backend_pid()`,
      [DESK_LOCK_KEYS[0], DESK_LOCK_KEYS[1]],
    );
    const h = r.rows[0];
    return h ? { pid: h.pid, idleMs: Number(h.idle_ms), app: h.app, addr: h.addr } : null;
  };

  let saidAt = 0;
  for (;;) {
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [DESK_LOCK_KEYS[0], DESK_LOCK_KEYS[1]]);
    if (got.rows[0]?.ok) break;
    const h = await holder();
    if (h && h.idleMs > staleMs) {
      o.log(`desk lock: the holder (pid ${h.pid}, ${h.app}${h.addr ? ` at ${h.addr}` : ''}) has been silent ${Math.round(h.idleMs / 1000)} s -- ending its session and taking over`, { deskLock: 'takeover', holder: h });
      await client.query('SELECT pg_terminate_backend($1)', [h.pid]);
      continue;
    }
    if (now() - saidAt >= 30_000) {
      saidAt = now();
      o.log(`desk lock held by another process${h ? ` (pid ${h.pid}, ${h.app}${h.addr ? ` at ${h.addr}` : ''})` : ''}: waiting as a standby -- nothing is traded from here until it is free`, { deskLock: 'standby', holder: h });
    }
    await new Promise((done) => setTimeout(done, retryMs));
  }
  held = true;
  lastOk = now();
  o.log('desk lock taken: this process is the one desk trading', { deskLock: 'held' });
  beat = setInterval(() => {
    client.query('SELECT 1').then(() => { lastOk = now(); }, (e: Error) => lose(`its heartbeat failed (${e.message})`));
  }, heartbeatMs);
  beat.unref();

  const lock: DeskLock = {
    ok: () => held && !lost && now() - lastOk <= freshMs,
    release: async () => {
      if (beat) { clearInterval(beat); beat = null; }
      lost = true; held = false;
      client.removeAllListeners('end'); client.removeAllListeners('error');
      if (armed === lock) armed = null;
      await client.end().catch(() => {});
    },
  };
  armed = lock;
  return lock;
}
