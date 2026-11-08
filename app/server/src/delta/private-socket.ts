import { createHmac } from 'node:crypto';
import type { Creds } from './signed.js';

/**
 * One broker account's private socket on Delta (8 Nov 2026): its orders and its fills as they happen.
 *
 * It listens, and that is all it can do. The only messages it ever sends are `enable_heartbeat`, `key-auth` and
 * `subscribe` (`SENT_TYPES`; a test holds it to that) -- Delta's socket takes no orders anyway, and
 * nothing here reaches the REST path that does. What it hears goes to `onMessage`, raw; reading it is
 * `private-events.ts`, and what is done with it is `private-shadow.ts`.
 *
 * The protocol, from Delta's docs (docs/delta/document.md, "Websocket Feed") and checked against the live endpoint
 * on 8 Nov 2026 with a key that does not exist:
 *
 *  - `wss://socket.india.delta.exchange`, the same endpoint as the ticker socket.
 *  - `key-auth` with the key, the timestamp in seconds (a number) and HMAC-SHA256 of `'GET' + timestamp + '/live'`
 *    under the secret. The reply is `{type:'key-auth', success, status_code, status, message}`.
 *  - A subscribe before the auth has answered is refused per channel ("subscription forbidden on this channel.
 *    Unauthorized user", seen live) -- so the channels are asked for only after `success: true`.
 *  - Heartbeats every 5 s on the live endpoint (the docs say 30): silence for `WATCHDOG_MS` is a dead socket.
 *  - 150 connections per 5 minutes per IP, shared with every other socket on this host: this one opens at most
 *    `MAX_OPENS_PER_WINDOW` in that window, and after handshakes that keep failing (a 429 looks like that from
 *    here) it waits `HANDSHAKE_PAUSE_MS`, as the docs ask ("wait for 5 to 10 minutes").
 *  - A key Delta does not accept (unknown, wrong signature, IP not whitelisted) is not retried every second: it waits
 *    `AUTH_REFUSED_MS`, and says why once.
 */

export const PRIVATE_SOCKET_URL = 'wss://socket.india.delta.exchange';
/** Fills on Delta's faster channel, and every change to an order. `all`: every contract on the account. */
export const PRIVATE_CHANNELS = [
  { name: 'orders', symbols: ['all'] },
  { name: 'v2/user_trades', symbols: ['all'] },
] as const;
/** Everything this socket may ever send. */
export const SENT_TYPES = ['enable_heartbeat', 'key-auth', 'subscribe'] as const;

/** No message for this long: the socket is dead, whatever it says. Delta's 30 s heartbeat plus its own 5 s margin. */
export const WATCHDOG_MS = 35_000;
/** Opened but not authenticated in this long: start again. */
export const AUTH_TIMEOUT_MS = 15_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** Live this long before the backoff starts again from the bottom: a socket that flaps does not reconnect every second. */
export const STABLE_MS = 60_000;
/** A key Delta refused: try again after this, not before. */
export const AUTH_REFUSED_MS = 10 * 60_000;
/** Handshakes that failed in a row before the long pause, and the pause. */
export const HANDSHAKE_FAILS_BEFORE_PAUSE = 5;
export const HANDSHAKE_PAUSE_MS = 5 * 60_000;
/** At most this many opens per account in Delta's 5-minute window (its limit is 150 for the whole IP). */
export const MAX_OPENS_PER_WINDOW = 20;
const OPEN_WINDOW_MS = 5 * 60_000;
const TICK_MS = 5_000;

export type SocketLike = {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type PrivateState = 'idle' | 'connecting' | 'authenticating' | 'live' | 'waiting' | 'refused' | 'stopped';

export type PrivateSocketHealth = {
  state: PrivateState;
  /** Since when it has been in this state. */
  since: number;
  lastMessageAt: number | null;
  /** When it last became live, and when the connection before that was lost (null: never lost). */
  liveSince: number | null;
  opens: number;
  reconnects: number;
  authFailures: number;
  /** Delta's own words for the last refusal, e.g. `ip_not_whitelisted`. Never the key. */
  lastAuthError: string | null;
  /** A channel Delta would not subscribe, and why. */
  subscribeErrors: string[];
  handshakeFailures: number;
  nextTryAt: number | null;
};

/** The signature Delta wants for `key-auth`: HMAC-SHA256 of 'GET' + timestamp + '/live', hex. */
export const authSignature = (secret: string, tsSec: number): string =>
  createHmac('sha256', secret).update(`GET${tsSec}/live`).digest('hex');

/** Refusals a retry will not fix by itself: the key, its signature, or where it may be used from. */
const HARD_REFUSALS = new Set(['api_key_not_found', 'invalid_signature', 'ip_not_whitelisted', 'invalid_api_key', 'unauthorized']);

export class PrivateSocket {
  private socket: SocketLike | null = null;
  private state: PrivateState = 'idle';
  private since: number;
  private openedAt = 0;
  private lastMessageAt: number | null = null;
  private liveSince: number | null = null;
  /** When the last live connection was lost: what a recovery looks back from. */
  private downSince: number | null = null;
  private everLive = false;
  private gotMessageThisOpen = false;
  private backoffMs = BACKOFF_MIN_MS;
  private nextTryAt: number | null = null;
  private opensAt: number[] = [];
  private opens = 0;
  private reconnects = 0;
  private authFailures = 0;
  private lastAuthError: string | null = null;
  private subscribeErrors: string[] = [];
  private handshakeFailures = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: {
    accountId: number;
    creds: Creds;
    /** Every message after the auth, raw, with when it arrived. */
    onMessage: (raw: string, at: number) => void;
    /**
     * Authenticated and subscribed. `downSince`: when the connection before this one was lost -- what was said
     * between then and now was not heard, and is for the REST path to tell (null on the first connection).
     */
    onLive?: (downSince: number | null) => void;
    /** Lost after being live. */
    onDown?: (at: number) => void;
    log?: (line: string) => void;
    connect?: () => SocketLike;
    now?: () => number;
    url?: string;
    /** For a test: no timers of its own; `check()` is called by hand. */
    manualTimers?: boolean;
  }) {
    this.since = this.now();
  }

  private now(): number { return this.o.now?.() ?? Date.now(); }
  private log(line: string): void { this.o.log?.(`private socket, account ${this.o.accountId}: ${line}`); }
  private to(state: PrivateState): void {
    if (this.state === state) return;
    this.state = state;
    this.since = this.now();
  }

  start(): void {
    if (this.state !== 'idle' && this.state !== 'stopped') return;
    this.to('connecting');
    if (!this.o.manualTimers) {
      this.tick = setInterval(() => this.check(), TICK_MS);
      this.tick.unref?.();
    }
    this.open();
  }

  stop(): void {
    this.to('stopped');
    if (this.tick) clearInterval(this.tick);
    if (this.retry) clearTimeout(this.retry);
    this.tick = null;
    this.retry = null;
    this.nextTryAt = null;
    this.drop();
  }

  health(): PrivateSocketHealth {
    return {
      state: this.state, since: this.since, lastMessageAt: this.lastMessageAt, liveSince: this.liveSince,
      opens: this.opens, reconnects: this.reconnects, authFailures: this.authFailures, lastAuthError: this.lastAuthError,
      subscribeErrors: [...this.subscribeErrors], handshakeFailures: this.handshakeFailures, nextTryAt: this.nextTryAt,
    };
  }

  /** Live: authenticated, subscribed, and heard from inside the watchdog. */
  isLive(now = this.now()): boolean {
    return this.state === 'live' && this.lastMessageAt !== null && now - this.lastMessageAt < WATCHDOG_MS;
  }

  /** The watchdog and the auth timeout; and, in a test, the retry that is due. */
  check(): void {
    const now = this.now();
    if (this.o.manualTimers && this.nextTryAt !== null && now >= this.nextTryAt && this.socket === null) {
      this.nextTryAt = null;
      this.open();
      return;
    }
    if (!this.socket) return;
    if (this.state === 'authenticating' && now - this.openedAt >= AUTH_TIMEOUT_MS) {
      this.log('no answer to the sign-in; starting again');
      this.lost();
      return;
    }
    const heardAt = Math.max(this.lastMessageAt ?? 0, this.openedAt);
    if (now - heardAt >= WATCHDOG_MS) {
      this.log(`silent ${Math.round((now - heardAt) / 1000)} s; starting again`);
      this.lost();
    }
  }

  private send(type: (typeof SENT_TYPES)[number], payload?: unknown): void {
    const ws = this.socket;
    if (!ws) return;
    try { ws.send(JSON.stringify(payload === undefined ? { type } : { type, payload })); } catch { /* the close that follows starts again */ }
  }

  private open(): void {
    if (this.state === 'stopped') return;
    const now = this.now();
    this.opensAt = this.opensAt.filter((t) => now - t < OPEN_WINDOW_MS);
    if (this.opensAt.length >= MAX_OPENS_PER_WINDOW) {
      // Within Delta's per-IP limit with room for every other socket on this host.
      this.later(OPEN_WINDOW_MS - (now - this.opensAt[0]!), `${MAX_OPENS_PER_WINDOW} opens in 5 minutes`);
      return;
    }
    let ws: SocketLike;
    try {
      ws = this.o.connect ? this.o.connect() : (new WebSocket(this.o.url ?? PRIVATE_SOCKET_URL) as unknown as SocketLike);
    } catch (e) {
      this.log(`could not open: ${(e as Error).message}`);
      this.handshakeFailed();
      return;
    }
    this.opensAt.push(now);
    this.opens++;
    this.socket = ws;
    this.openedAt = now;
    this.gotMessageThisOpen = false;
    this.subscribeErrors = [];
    this.to('authenticating');
    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.send('enable_heartbeat');
      const ts = Math.floor(this.now() / 1000);
      // The timestamp is a number, the same one that was signed (Delta's docs).
      this.send('key-auth', { 'api-key': this.o.creds.key, signature: authSignature(this.o.creds.secret, ts), timestamp: ts });
    };
    ws.onmessage = (ev) => { if (this.socket === ws) this.receive(ev.data); };
    ws.onerror = () => { /* the close that follows carries the reconnect */ };
    ws.onclose = (ev) => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.log(`closed (${ev.code ?? '?'}${ev.reason ? ` ${ev.reason}` : ''})`);
      if (!this.gotMessageThisOpen) this.handshakeFailed();
      else this.lost(false);
    };
  }

  /** One message from the wire. Public so a test can speak for Delta. */
  receive(raw: unknown): void {
    const at = this.now();
    this.lastMessageAt = at;
    this.gotMessageThisOpen = true;
    if (typeof raw !== 'string') return;
    // The control messages are short; the rest go on unparsed, for the reader to parse once.
    if (raw.length < 600 && (raw.includes('"key-auth"') || raw.includes('"subscriptions"'))) {
      let m: Record<string, unknown>;
      try { m = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
      if (m.type === 'key-auth') { this.authAnswered(m); return; }
      if (m.type === 'subscriptions') { this.subscribed(m); return; }
    }
    if (this.state !== 'live') return;
    if (raw.includes('"heartbeat"') && raw.length < 200) return;
    try { this.o.onMessage(raw, at); } catch (e) { this.log(`a message was not read: ${(e as Error).message}`); }
  }

  private authAnswered(m: Record<string, unknown>): void {
    if (m.success === true) {
      this.handshakeFailures = 0;
      this.send('subscribe', { channels: PRIVATE_CHANNELS.map((c) => ({ name: c.name, symbols: [...c.symbols] })) });
      const downSince = this.everLive ? this.downSince : null;
      if (this.everLive) this.reconnects++;
      this.everLive = true;
      this.liveSince = this.now();
      this.lastAuthError = null;
      this.to('live');
      this.log(downSince !== null ? `live again after ${Math.round((this.now() - downSince) / 1000)} s` : 'live');
      try { this.o.onLive?.(downSince); } catch { /* the reader's, not the socket's */ }
      return;
    }
    this.authFailures++;
    const status = typeof m.status === 'string' ? m.status : `status ${String(m.status_code ?? '?')}`;
    const said = this.lastAuthError !== status;
    this.lastAuthError = status;
    this.drop();
    if (HARD_REFUSALS.has(status) || m.status_code === 401 || m.status_code === 404) {
      if (said) this.log(`Delta refused the key (${status}); trying again in ${AUTH_REFUSED_MS / 60_000} minutes`);
      this.to('refused');
      this.later(AUTH_REFUSED_MS, null);
      return;
    }
    // A clock a few seconds out (`request_expired`), or Delta's own trouble: the usual backoff.
    if (said) this.log(`sign-in not accepted (${status}); trying again`);
    this.later(this.nextBackoff(), null);
  }

  private subscribed(m: Record<string, unknown>): void {
    const channels = Array.isArray(m.channels) ? (m.channels as Record<string, unknown>[]) : [];
    const errors = channels.filter((c) => typeof c.error === 'string').map((c) => `${String(c.name)}: ${String(c.error)}`);
    if (errors.length && errors.join('|') !== this.subscribeErrors.join('|')) this.log(`Delta would not subscribe ${errors.join('; ')}`);
    this.subscribeErrors = errors;
  }

  /** Lost after being open: drop it, note when, and come back after the backoff. */
  private lost(drop = true): void {
    if (drop) this.drop();
    const now = this.now();
    if (this.state === 'live') {
      this.downSince = now;
      try { this.o.onDown?.(now); } catch { /* the reader's */ }
    }
    // A socket that stayed up a while starts its backoff again from the bottom.
    if (this.liveSince !== null && now - this.liveSince >= STABLE_MS) this.backoffMs = BACKOFF_MIN_MS;
    this.later(this.nextBackoff(), null);
  }

  private handshakeFailed(): void {
    this.handshakeFailures++;
    if (this.handshakeFailures >= HANDSHAKE_FAILS_BEFORE_PAUSE) {
      this.log(`${this.handshakeFailures} handshakes failed in a row; waiting ${HANDSHAKE_PAUSE_MS / 60_000} minutes (Delta's connection limit)`);
      this.handshakeFailures = 0;
      this.later(HANDSHAKE_PAUSE_MS, null);
      return;
    }
    this.later(this.nextBackoff(), null);
  }

  private nextBackoff(): number {
    const wait = this.backoffMs;
    this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    // A little jitter, so several accounts do not knock on the same second.
    return Math.round(wait * (0.8 + Math.random() * 0.4));
  }

  private later(ms: number, why: string | null): void {
    if (this.state === 'stopped') return;
    if (why) this.log(`waiting ${Math.round(ms / 1000)} s: ${why}`);
    if (this.state !== 'refused') this.to('waiting');
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.nextTryAt = this.now() + ms;
    if (this.o.manualTimers) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.nextTryAt = null;
      this.open();
    }, ms);
    this.retry.unref?.();
  }

  private drop(): void {
    const ws = this.socket;
    this.socket = null;
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    try { ws.close(); } catch { /* already gone */ }
  }
}
