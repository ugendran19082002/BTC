import { migrate, type Migration } from '../db/migrate.js';
import { one, query, rows } from '../db/pool.js';
import { quotaKeyOf, quotaUsedPctOf } from '../observability/desk-metrics.js';
import { signedPage, type Creds } from './signed.js';
import { fillOf, orderOf, OrderProgressBook, SeenIds, SeqTracker, type SocketOrderEvent, type WsFill } from './private-events.js';
import { PrivateSocket, type PrivateSocketHealth, type SocketLike } from './private-socket.js';

/**
 * Delta's private socket in **shadow** (8 Nov 2026): heard, written down, compared -- and nothing else.
 *
 * The desk learns of its fills by asking Delta over REST, a trade at a time, on each pass of the loop. Delta's
 * private socket would tell it the moment they happen. Before the desk ever acts on what the socket says, this
 * measures whether the socket can be trusted with it, on the real account, beside the path that trades:
 *
 *  - **Lead**: for each order both have seen fill, how much sooner the socket heard than the journal recorded
 *    (`trade_events` `fill`, written by the REST path). Positive is the socket first.
 *  - **Missed by the socket**: a fill the journal has, that the socket did not deliver while it was live
 *    (`restOnly`; `restOnlyWhileDown` when the socket was not live -- expected, and what recovery is for).
 *  - **Only on the socket**: a fill the journal never got (`socketOnly`) -- an order placed outside the desk (the
 *    Delta app), or one the desk missed. Either is worth knowing.
 *  - **Size**: the contracts each saw on one order, once both are quiet (`sizeMismatch`); and the socket's two
 *    channels against each other -- the order's filled size against its fills (`channelMismatch`).
 *  - **Recovery**: after a reconnect, and after a restart, Delta's REST fills for the time the socket could not hear
 *    are read once (`GET /v2/fills`, a read, inside the quota ladder) and the contracts it missed are counted.
 *    With `symbols: all` Delta sends no snapshot on subscribe (its docs), so REST is how a gap is closed.
 *
 * What it can never do: place, edit or cancel an order, or change a trade. It imports nothing from `trading/`, and
 * its one REST call is a GET (a test reads this file and holds it to both). The desk lock still decides which
 * process trades; this starts only once the lock is held (index.ts), so a standby during a hand-over does not count
 * fills twice.
 *
 * What it may do (11 Nov 2026, `DELTA_PRIVATE_WS=wake`): tell a listener, the moment it is heard, of each new fill and
 * each order Delta cancelled (`onEvent`). It still decides nothing -- the listener (index.ts) hands the trade's id to
 * its desk, whose own poll reads Delta over REST and acts as it always has (`trading/fill-wake.ts`). A listener that
 * throws is the listener's problem: the shadow carries on.
 *
 * Fills are kept in `private_ws_fills`, one row per Delta `fill_id` -- the key is what makes a fill delivered twice,
 * or again after a restart, count once. Order updates are counted, not kept.
 */

export const COMPARE_EVERY_MS = 10_000;
const SYNC_EVERY_MS = 30_000;
/** The socket is usually first; it gets this long after the journal's fill before the fill is called missed. */
export const REST_GRACE_MS = 60_000;
/** A socket fill the journal has not got after this long is the socket's alone. */
export const SOCKET_GRACE_MS = 5 * 60_000;
/** Sizes are compared once neither side has heard more for this long. */
export const SETTLE_MS = 60_000;
const KEEP_ORDERS_MS = 2 * 3_600_000;
/** How far back a recovery looks, at most: a socket down longer than this is a matter for the REST path alone. */
export const RECOVERY_MAX_LOOKBACK_MS = 60 * 60_000;
/** Above this share of the login's quota, a recovery waits (the quota ladder's "others", desk-metrics.ts). */
export const RECOVERY_BUSY_PCT = 50;
/** A recovery that could not run for this long is given up, and said. */
const RECOVERY_GIVE_UP_MS = 15 * 60_000;
const FILLS_KEEP_MS = 30 * 86_400_000;
const SUMMARY_EVERY_MS = 15 * 60_000;
const SAMPLES = 500;
/** How many journal ids each read looks back past the last one (`readJournal`). */
const JOURNAL_OVERLAP = 500;
const DISCREPANCIES = 20;

const MIGRATIONS: Migration[] = [{
  id: 'delta-001-private-ws-fills',
  up: `
    CREATE TABLE IF NOT EXISTS private_ws_fills (
      account_id      BIGINT           NOT NULL,
      fill_id         TEXT             NOT NULL,
      order_id        TEXT             NOT NULL,
      client_order_id TEXT,
      symbol          TEXT             NOT NULL,
      side            TEXT             NOT NULL,
      size            DOUBLE PRECISION NOT NULL,
      price           DOUBLE PRECISION NOT NULL,
      position_after  DOUBLE PRECISION,
      reason          TEXT,
      seq             BIGINT,
      exch_at         BIGINT           NOT NULL,
      seen_at         BIGINT           NOT NULL,
      PRIMARY KEY (account_id, fill_id)
    );
    CREATE INDEX IF NOT EXISTS private_ws_fills_by_order ON private_ws_fills (account_id, order_id);
    CREATE INDEX IF NOT EXISTS private_ws_fills_by_seen ON private_ws_fills (seen_at);
  `,
}];

let ready: Promise<void> | null = null;
export function privateShadowSchema(): Promise<void> {
  ready ??= migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/** A fill as Delta's REST has it, for a recovery. */
export type RestFill = { orderId: string; size: number; at: number };
export type RestFillReader = (creds: Creds, fromMs: number, toMs: number) => Promise<RestFill[]>;

/** The account's fills between two moments, every contract (`GET /v2/fills`): three pages of a hundred at most. */
export const restFillsBetween: RestFillReader = async (creds, fromMs, toMs) => {
  type DeltaFill = { order_id: number | string; size: number | string; created_at: string };
  const out: RestFill[] = [];
  let after: string | null = null;
  for (let page = 0; page < 3; page++) {
    const query = `?start_time=${Math.floor(fromMs) * 1_000}&end_time=${Math.floor(toMs) * 1_000}&page_size=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const r: { result: DeltaFill[]; after: string | null } = await signedPage<DeltaFill[]>(creds, { method: 'GET', path: '/v2/fills', query, timeoutMs: 10_000 });
    for (const f of r.result ?? []) {
      const size = Number(f.size), at = Date.parse(f.created_at);
      if (Number.isFinite(size) && size > 0 && Number.isFinite(at)) out.push({ orderId: String(f.order_id), size, at });
    }
    after = r.after;
    if (!after) break;
  }
  return out;
};

type Side = { firstAt: number; lastAt: number; size: number };
type Discrepancy = { at: number; kind: string; orderId: string; detail: string };
type Recovery = { from: number; to: number; queuedAt: number; why: 'reconnect' | 'restart' };

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]!);
};
const spread = (xs: number[]) => ({ n: xs.length, p50Ms: pct(xs, 0.5), p95Ms: pct(xs, 0.95), maxMs: xs.length ? Math.round(Math.max(...xs)) : null });
const push = <T>(xs: T[], x: T, max: number) => { xs.push(x); if (xs.length > max) xs.shift(); };

/** One account: its socket, what it heard, and how that compares with the journal. */
class AccountShadow {
  readonly socket: PrivateSocket;
  private readonly seq = new SeqTracker();
  private readonly seen = new SeenIds();
  private readonly book = new OrderProgressBook();
  /** Orders whose whole fill history the socket saw (first heard unfilled): only these are held to their fills' sum. */
  private readonly fullHistory = new Set<string>();
  readonly counts = {
    fills: 0, orderUpdates: 0, duplicates: 0, outOfOrder: 0, gaps: 0, missingBySeq: 0, seqResets: 0,
    staleOrderUpdates: 0, partialFills: 0, unreadable: 0, persistFailed: 0,
    /** Events handed to the listener (`onEvent`), and how many of those it threw on. */
    told: 0, listenerFailed: 0,
  };
  /** Fills the socket heard and the journal recorded, by Delta's order id. */
  private readonly ws = new Map<string, Side>();
  private readonly rest = new Map<string, Side & { socketLive: boolean }>();
  private readonly judged = new Set<string>();
  private readonly sized = new Set<string>();
  private readonly leads: number[] = [];
  private readonly delivery: number[] = [];
  readonly compare = { matched: 0, restOnly: 0, restOnlyWhileDown: 0, socketOnly: 0, sizeMismatch: 0, channelMismatch: 0 };
  private readonly discrepancies: Discrepancy[] = [];
  private pending: Recovery | null = null;
  readonly recovery = {
    runs: 0, skippedBusy: 0, failed: 0, givenUp: 0, restFills: 0, missedOrders: 0, missedContracts: 0,
    last: null as null | { at: number; why: string; windowMs: number; restFills: number; missedOrders: number; missedContracts: number },
  };
  private persistSaidAt = 0;
  /** Fills being written: a fill is counted once its row says whether it is new. */
  private readonly writing = new Set<Promise<void>>();

  /** Every fill heard so far written and counted. */
  async flushed(): Promise<void> { while (this.writing.size) await Promise.all([...this.writing]); }
  /** When the socket was first live, and each time it was down since: whether it could have heard a fill at a moment. */
  private firstLiveAt: number | null = null;
  private readonly downs: { from: number; to: number | null }[] = [];

  /** Whether the socket was live at `t` -- with two seconds' margin either side of an outage. */
  liveAt(t: number): boolean {
    if (this.firstLiveAt === null || t < this.firstLiveAt) return false;
    return !this.downs.some((d) => t >= d.from - 2_000 && (d.to === null || t <= d.to + 2_000));
  }

  constructor(
    readonly accountId: number,
    readonly creds: Creds,
    private readonly d: {
      now: () => number; log: (line: string) => void; reader: RestFillReader;
      connect?: () => SocketLike; manualTimers?: boolean; busyPct?: () => number;
      onEvent?: (e: SocketOrderEvent) => void;
    },
  ) {
    this.socket = new PrivateSocket({
      accountId, creds,
      onMessage: (raw, at) => this.receive(raw, at),
      onLive: (downSince) => {
        const now = d.now();
        this.firstLiveAt ??= now;
        const open = this.downs[this.downs.length - 1];
        if (open && open.to === null) open.to = now;
        void this.onLive(downSince);
      },
      onDown: (at) => push(this.downs, { from: at, to: null }, 50),
      log: d.log,
      ...(d.connect ? { connect: d.connect } : {}),
      now: d.now,
      ...(d.manualTimers ? { manualTimers: true } : {}),
    });
  }

  get keyHash(): string { return quotaKeyOf(this.creds); }

  /** One message after the auth, raw. */
  receive(raw: string, at: number): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw) as Record<string, unknown>; } catch { this.counts.unreadable++; return; }
    if (m.type === 'v2/user_trades') {
      const f = fillOf(m);
      if (!f) { this.counts.unreadable++; return; }
      this.sequence(`fills|${f.symbol}`, f.seq);
      if (!this.seen.add(f.fillId)) { this.counts.duplicates++; return; }
      // Told before it is written: what follows a fill should not wait for the database.
      this.tell({ kind: 'fill', symbol: f.symbol, orderId: f.orderId, clientOrderId: f.clientOrderId, heardAt: at });
      const w = this.persist(f, at).then((inserted) => {
        // Already kept before this process started: a duplicate across a restart.
        if (inserted === false) { this.counts.duplicates++; return; }
        this.counts.fills++;
        this.noteWs(f, at);
      });
      this.writing.add(w);
      void w.finally(() => this.writing.delete(w));
      return;
    }
    if (m.type === 'orders') {
      if (m.action === 'snapshot') return;
      const o = orderOf(m);
      if (!o) { this.counts.unreadable++; return; }
      this.counts.orderUpdates++;
      this.sequence(`orders|${o.symbol}`, o.seq);
      const verdict = this.book.apply(o);
      if (verdict === 'stale') { this.counts.staleOrderUpdates++; return; }
      if (verdict === 'new' && o.filled === 0) this.fullHistory.add(o.orderId);
      if (verdict !== 'unchanged' && this.book.get(o.orderId)?.status === 'partial') this.counts.partialFills++;
      // Cancelled, once: an order that is gone may have been a trade's stop or target, and its desk should know now.
      const status = this.book.get(o.orderId)?.status;
      if ((verdict === 'new' || verdict === 'progress') && (status === 'cancelled' || status === 'partial-cancelled')) {
        this.tell({ kind: 'cancelled', symbol: o.symbol, orderId: o.orderId, clientOrderId: o.clientOrderId, heardAt: at });
      }
    }
  }

  /** What was heard, to the listener -- whose failure never reaches the socket. */
  private tell(e: SocketOrderEvent): void {
    if (!this.d.onEvent) return;
    this.counts.told++;
    try { this.d.onEvent(e); } catch { this.counts.listenerFailed++; }
  }

  private sequence(key: string, seq: number | null): void {
    const v = this.seq.check(key, seq);
    if (v.kind === 'duplicate') this.counts.outOfOrder++;
    else if (v.kind === 'gap') { this.counts.gaps++; this.counts.missingBySeq += v.missing; }
    else if (v.kind === 'reset') this.counts.seqResets++;
  }

  /** True: written now; false: it was already there; null: the database did not answer (counted anyway). */
  private async persist(f: WsFill, at: number): Promise<boolean | null> {
    try {
      const r = await query(
        `INSERT INTO private_ws_fills (account_id, fill_id, order_id, client_order_id, symbol, side, size, price, position_after, reason, seq, exch_at, seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (account_id, fill_id) DO NOTHING`,
        [this.accountId, f.fillId, f.orderId, f.clientOrderId, f.symbol, f.side, f.size, f.price, f.positionAfter, f.reason, f.seq, f.exchAt, at],
      );
      return (r.rowCount ?? 0) > 0;
    } catch (e) {
      this.counts.persistFailed++;
      if (this.d.now() - this.persistSaidAt > 5 * 60_000) {
        this.persistSaidAt = this.d.now();
        this.d.log(`private socket, account ${this.accountId}: a fill was not kept (${(e as Error).message})`);
      }
      return null;
    }
  }

  private noteWs(f: WsFill, at: number): void {
    const s = this.ws.get(f.orderId);
    if (s) { s.size += f.size; s.lastAt = at; } else this.ws.set(f.orderId, { firstAt: at, lastAt: at, size: f.size });
    push(this.delivery, Math.max(0, at - f.exchAt), SAMPLES);
  }

  /** A fill the journal wrote for this account. */
  noteRest(orderId: string, size: number, at: number): void {
    const s = this.rest.get(orderId);
    if (s) { s.size += size; s.lastAt = Math.max(s.lastAt, at); return; }
    this.rest.set(orderId, { firstAt: at, lastAt: at, size, socketLive: this.liveAt(at) });
  }

  private flag(kind: string, orderId: string, detail: string, now: number): void {
    push(this.discrepancies, { at: now, kind, orderId, detail }, DISCREPANCIES);
  }

  /** Judge what can be judged: each order once for its lead, once for its size. */
  judge(now: number): void {
    for (const [orderId, r] of this.rest) {
      const w = this.ws.get(orderId);
      if (w && !this.judged.has(orderId)) {
        this.judged.add(orderId);
        this.compare.matched++;
        push(this.leads, r.firstAt - w.firstAt, SAMPLES);
      } else if (!w && !this.judged.has(orderId) && now - r.firstAt >= REST_GRACE_MS) {
        this.judged.add(orderId);
        if (r.socketLive) { this.compare.restOnly++; this.flag('restOnly', orderId, `journal ${r.size} contracts, socket none (live at the time)`, now); }
        else this.compare.restOnlyWhileDown++;
      }
      if (w && !this.sized.has(orderId) && now - Math.max(r.lastAt, w.lastAt) >= SETTLE_MS) {
        this.sized.add(orderId);
        if (Math.abs(w.size - r.size) > 1e-9) {
          this.compare.sizeMismatch++;
          this.flag('sizeMismatch', orderId, `journal ${r.size} contracts, socket ${w.size}`, now);
        }
      }
    }
    for (const [orderId, w] of this.ws) {
      if (!this.rest.has(orderId) && !this.judged.has(orderId) && now - w.firstAt >= SOCKET_GRACE_MS) {
        this.judged.add(orderId);
        this.compare.socketOnly++;
        this.flag('socketOnly', orderId, `socket ${w.size} contracts, not in the journal (an order from outside the desk, or one it missed)`, now);
      }
      // The socket's two channels on one order it saw from the start: the order's filled size against its fills.
      const book = this.book.get(orderId);
      const key = `ch|${orderId}`;
      if (book && this.fullHistory.has(orderId) && !this.sized.has(key) && now - w.lastAt >= SETTLE_MS) {
        this.sized.add(key);
        if (Math.abs(book.filled - w.size) > 1e-9) {
          this.compare.channelMismatch++;
          this.flag('channelMismatch', orderId, `orders channel ${book.filled} filled, fills channel ${w.size}`, now);
        }
      }
    }
    // Forget what is old -- an order at a time, both sides together, once the later of the two is old. Forgetting
    // each side by its own age dropped the socket's (heard first) with its verdict while the journal's was still
    // held, and the leftover was then judged a miss: 8 Nov's ~640 "missed live" were all on the socket.
    for (const m of [this.ws, this.rest] as Map<string, Side>[]) {
      for (const orderId of m.keys()) {
        if (now - this.lastHeard(orderId) > KEEP_ORDERS_MS) this.forget(orderId);
      }
    }
  }

  /** When either side last heard of an order. */
  private lastHeard(orderId: string): number {
    return Math.max(this.ws.get(orderId)?.lastAt ?? -Infinity, this.rest.get(orderId)?.lastAt ?? -Infinity);
  }

  private forget(orderId: string): void {
    this.ws.delete(orderId);
    this.rest.delete(orderId);
    this.judged.delete(orderId);
    this.sized.delete(orderId);
    this.sized.delete(`ch|${orderId}`);
  }

  private async onLive(downSince: number | null): Promise<void> {
    const now = this.d.now();
    if (downSince !== null) { this.queue(downSince, now, 'reconnect'); return; }
    // The first connection of this process: what was missed since the last fill this account's socket kept.
    try {
      const r = await one<{ at: string | null }>('SELECT MAX(seen_at)::text AS at FROM private_ws_fills WHERE account_id = $1', [this.accountId]);
      const last = r?.at ? Number(r.at) : null;
      if (last !== null && now - last <= RECOVERY_MAX_LOOKBACK_MS) this.queue(last, now, 'restart');
    } catch { /* nothing to look back from */ }
  }

  private queue(from: number, to: number, why: Recovery['why']): void {
    const start = Math.max(from - 5_000, to - RECOVERY_MAX_LOOKBACK_MS);
    // Two outages before one recovery ran: one window covering both.
    this.pending = this.pending
      ? { from: Math.min(this.pending.from, start), to: Math.max(this.pending.to, to), queuedAt: this.pending.queuedAt, why }
      : { from: start, to, queuedAt: this.d.now(), why };
  }

  /** The recovery that is due, if the socket is live and the login's quota has room. */
  async recover(now: number): Promise<void> {
    const p = this.pending;
    if (!p || !this.socket.isLive(now)) return;
    if (now - p.queuedAt > RECOVERY_GIVE_UP_MS) {
      this.pending = null;
      this.recovery.givenUp++;
      this.d.log(`private socket, account ${this.accountId}: recovery of ${Math.round((p.to - p.from) / 1000)} s given up -- the REST path is the record`);
      return;
    }
    const busy = this.d.busyPct ? this.d.busyPct() : quotaUsedPctOf(this.keyHash, now);
    if (busy > RECOVERY_BUSY_PCT) { this.recovery.skippedBusy++; return; }
    this.pending = null;
    try {
      const rest = await this.d.reader(this.creds, p.from, p.to);
      const heard = await rows<{ order_id: string; size: number }>(
        `SELECT order_id, SUM(size)::float8 AS size FROM private_ws_fills
          WHERE account_id = $1 AND exch_at >= $2 AND exch_at <= $3 GROUP BY order_id`,
        [this.accountId, p.from, p.to],
      );
      const socketBy = new Map(heard.map((h) => [h.order_id, Number(h.size)]));
      const restBy = new Map<string, number>();
      for (const f of rest) restBy.set(f.orderId, (restBy.get(f.orderId) ?? 0) + f.size);
      let missedOrders = 0, missedContracts = 0;
      for (const [orderId, size] of restBy) {
        const gap = size - (socketBy.get(orderId) ?? 0);
        if (gap > 1e-9) { missedOrders++; missedContracts += gap; }
      }
      this.recovery.runs++;
      this.recovery.restFills += rest.length;
      this.recovery.missedOrders += missedOrders;
      this.recovery.missedContracts += missedContracts;
      this.recovery.last = { at: now, why: p.why, windowMs: p.to - p.from, restFills: rest.length, missedOrders, missedContracts };
      if (rest.length) {
        this.d.log(`private socket, account ${this.accountId}: recovery after ${p.why} -- ${rest.length} fills on Delta in ${Math.round((p.to - p.from) / 1000)} s, `
          + `${missedOrders} orders (${missedContracts} contracts) not heard by the socket`);
      }
    } catch (e) {
      this.recovery.failed++;
      // Tried again on the next look, until it is given up.
      this.pending = p;
      this.d.log(`private socket, account ${this.accountId}: recovery read failed (${(e as Error).message})`);
    }
  }

  metrics(now: number) {
    const leads = spread(this.leads);
    return {
      accountId: this.accountId,
      socket: this.socket.health() as PrivateSocketHealth,
      live: this.socket.isLive(now),
      counts: { ...this.counts },
      compare: {
        ...this.compare,
        /** How much sooner the socket heard each fill than the journal recorded it; positive is the socket first. */
        leadMs: leads,
        socketFirst: this.leads.filter((l) => l > 0).length,
        /** Delta's fill time to the socket's delivery. */
        deliveryMs: spread(this.delivery),
        discrepancies: [...this.discrepancies].reverse(),
      },
      recovery: { ...this.recovery, pending: this.pending ? { from: this.pending.from, to: this.pending.to, why: this.pending.why } : null },
    };
  }
}

export type ShadowAccount = { id: number; creds: Creds };

/** Every trading account's shadow, kept in step with the accounts, and the journal read as it grows. */
export class PrivateShadow {
  private readonly accounts = new Map<number, AccountShadow>();
  private lastEventId: number | null = null;
  /** Where the journal stood when the shadow started: nothing below it is read. */
  private floorId = 0;
  private readonly takenEvents = new SeenIds(50_000);
  private timers: ReturnType<typeof setInterval>[] = [];
  private comparing = false;
  private summaryAt = 0;
  private pruneAt = 0;
  readonly startedAt: number;

  constructor(private readonly o: {
    accounts: () => ShadowAccount[];
    log: (line: string) => void;
    now?: () => number;
    reader?: RestFillReader;
    connect?: (accountId: number) => SocketLike;
    manualTimers?: boolean;
    busyPct?: () => number;
    /** Each new fill and each cancelled order, as heard, with the account it is on (`AccountShadow.tell`). */
    onEvent?: (accountId: number, e: SocketOrderEvent) => void;
  }) {
    this.startedAt = this.now();
  }

  private now(): number { return this.o.now?.() ?? Date.now(); }

  start(): void {
    this.sync();
    if (this.o.manualTimers) return;
    const every = (fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref?.(); this.timers.push(t); };
    every(() => this.sync(), SYNC_EVERY_MS);
    every(() => { void this.tick(); }, COMPARE_EVERY_MS);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const a of this.accounts.values()) a.socket.stop();
    this.accounts.clear();
  }

  /** One socket per trading account: opened for a new one, closed for one gone, opened again for a new key. */
  sync(): void {
    let wanted: ShadowAccount[];
    try { wanted = this.o.accounts(); } catch { return; }
    const ids = new Set(wanted.map((a) => a.id));
    for (const [id, a] of this.accounts) {
      if (!ids.has(id)) { a.socket.stop(); this.accounts.delete(id); this.o.log(`private socket, account ${id}: closed (the account is not trading)`); }
    }
    for (const w of wanted) {
      const have = this.accounts.get(w.id);
      if (have && have.keyHash === quotaKeyOf(w.creds)) continue;
      if (have) { have.socket.stop(); this.o.log(`private socket, account ${w.id}: the key changed; opening again`); }
      const a = new AccountShadow(w.id, w.creds, {
        now: () => this.now(), log: this.o.log, reader: this.o.reader ?? restFillsBetween,
        ...(this.o.connect ? { connect: () => this.o.connect!(w.id) } : {}),
        ...(this.o.manualTimers ? { manualTimers: true } : {}),
        ...(this.o.busyPct ? { busyPct: this.o.busyPct } : {}),
        ...(this.o.onEvent ? { onEvent: (e: SocketOrderEvent) => this.o.onEvent!(w.id, e) } : {}),
      });
      this.accounts.set(w.id, a);
      a.socket.start();
    }
  }

  /** Every account's fills heard so far written and counted: before a comparison, and before a test reads. */
  async flushed(): Promise<void> { await Promise.all([...this.accounts.values()].map((a) => a.flushed())); }

  /** For a test: the account's shadow. */
  account(id: number): AccountShadow | null { return this.accounts.get(id) ?? null; }

  /** Read the journal's new fills, judge, recover, and now and then say how it stands. */
  async tick(): Promise<void> {
    if (this.comparing) return;
    this.comparing = true;
    try {
      if (this.o.manualTimers) for (const a of this.accounts.values()) a.socket.check();
      await this.flushed();
      await this.readJournal();
      const now = this.now();
      for (const a of this.accounts.values()) {
        a.judge(now);
        await a.recover(now);
      }
      if (now - this.summaryAt >= SUMMARY_EVERY_MS) { this.summaryAt = now; this.summary(now); }
      if (now - this.pruneAt >= 3_600_000) {
        this.pruneAt = now;
        await query('DELETE FROM private_ws_fills WHERE seen_at < $1', [now - FILLS_KEEP_MS]).catch(() => {});
      }
    } catch (e) {
      this.o.log(`private socket shadow: a comparison failed (${(e as Error).message})`);
    } finally {
      this.comparing = false;
    }
  }

  /**
   * The journal's fills since the last read, by account: from where it stood when the shadow started, never older.
   *
   * An id is handed out when a row is inserted, not when its transaction commits, so a fill can appear below an id
   * already read (two trades' commits crossing). Each read therefore looks back `JOURNAL_OVERLAP` ids as well, and
   * a fill already taken is known by its id.
   */
  private async readJournal(): Promise<void> {
    if (this.lastEventId === null) {
      const r = await one<{ id: string | null }>('SELECT MAX(id)::text AS id FROM trade_events');
      this.lastEventId = r?.id ? Number(r.id) : 0;
      this.floorId = this.lastEventId;
      return;
    }
    let from = Math.max(this.floorId, this.lastEventId - JOURNAL_OVERLAP);
    for (;;) {
      const got = await rows<{ id: string; account: string | null; at: string; order_id: string | null; size: number | null }>(
        `SELECT e.id::text AS id, t.broker_account_id::text AS account, e.at::text AS at,
                e.event->>'orderId' AS order_id, (e.event->>'size')::float8 AS size
           FROM trade_events e JOIN trades t ON t.trade_id = e.trade_id
          WHERE e.id > $1 AND e.kind = 'fill'
          ORDER BY e.id LIMIT 1000`,
        [from],
      );
      for (const r of got) {
        const id = Number(r.id);
        from = Math.max(from, id);
        this.lastEventId = Math.max(this.lastEventId, id);
        if (!this.takenEvents.add(r.id)) continue;
        const a = r.account !== null ? this.accounts.get(Number(r.account)) : undefined;
        if (a && r.order_id && r.size !== null && r.size > 0) a.noteRest(r.order_id, Number(r.size), Number(r.at));
      }
      if (got.length < 1000) break;
    }
    // Past the journal's other kinds too, so the look-back stays a look-back.
    const top = await one<{ id: string | null }>('SELECT MAX(id)::text AS id FROM trade_events');
    if (top?.id) this.lastEventId = Math.max(this.lastEventId, Number(top.id));
  }

  private summary(now: number): void {
    for (const a of this.accounts.values()) {
      const m = a.metrics(now);
      if (!m.counts.fills && !m.compare.restOnly && !m.compare.restOnlyWhileDown && m.live) continue;
      const lead = m.compare.leadMs;
      this.o.log(`private socket shadow, account ${a.accountId}: ${m.live ? 'live' : m.socket.state}, ${m.counts.fills} fills, `
        + `${m.compare.matched} matched (socket first by ${lead.p50Ms ?? '-'} ms median, ${lead.p95Ms ?? '-'} ms p95), `
        + `${m.compare.restOnly} missed live, ${m.compare.restOnlyWhileDown} while down, ${m.compare.socketOnly} socket only, `
        + `${m.compare.sizeMismatch + m.compare.channelMismatch} size disagreements, ${m.counts.gaps} sequence gaps, ${m.socket.reconnects} reconnects`);
    }
  }

  metrics() {
    const now = this.now();
    return [...this.accounts.values()].map((a) => a.metrics(now));
  }
}

let shadow: PrivateShadow | null = null;
let shadowMode: 'off' | 'shadow' | 'wake' = 'off';

/**
 * Start the shadow, once (index.ts, after the desk lock). Off: nothing opens. `wake` is the same shadow with a listener
 * (`onEvent`), which only `wake` passes on: in `shadow` a listener given is not used.
 */
export function startPrivateShadow(mode: 'off' | 'shadow' | 'wake', o: ConstructorParameters<typeof PrivateShadow>[0]): PrivateShadow | null {
  shadowMode = mode;
  if (mode === 'off' || shadow) return shadow;
  const { onEvent, ...rest } = o;
  shadow = new PrivateShadow(mode === 'wake' && onEvent ? { ...rest, onEvent } : rest);
  shadow.start();
  o.log(mode === 'wake'
    ? 'private socket: wake mode -- each trading account\'s orders and fills are heard and compared with the REST path, and a fill or a cancel on a trade\'s own order wakes that trade\'s poll at once; REST is still the record'
    : 'private socket: shadow mode -- each trading account\'s orders and fills are heard and compared with the REST path; nothing is acted on');
  return shadow;
}

export function stopPrivateShadow(): void {
  shadow?.stop();
  shadow = null;
}

/** For `/api/desk/metrics`. */
export function privateShadowMetrics() {
  return { mode: shadowMode, since: shadow?.startedAt ?? null, accounts: shadow?.metrics() ?? [] };
}
