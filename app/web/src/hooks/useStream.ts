import { useEffect, useRef, useState } from 'react';
import { usePageVisible } from '@/hooks/usePageVisible';
import type { TradeStatus } from '@/types/trade';

/**
 * The desk, pushed: one connection instead of three polls a second.
 *
 * `/api/stream` is Server-Sent Events. The browser owns the connection -- it
 * reconnects on its own, sends the session cookie like any GET -- and this
 * hook only turns frames into state. Three things it is careful about:
 *
 * - **`live` is earned, not assumed.** It is true only while frames are
 *   actually arriving. A stream that has gone quiet for `QUIET_MS`, or that
 *   the browser has given up on, is not live, and the caller falls back to
 *   the polls. That fallback is why the polls still exist.
 * - **Nothing while hidden.** A phone in a pocket holds no connection open;
 *   the stream is closed with the tab and reopened, with the current picture
 *   pushed at once, when it is back.
 * - **Each fact carries when it arrived.** A poll that ran after a button
 *   press must not be overwritten by a pushed frame from a second earlier,
 *   so the caller can pick the newer of the two.
 */
/** The server pings every 15s; missing two and a half of them is silence. */
export const QUIET_MS = 40_000;

export type StreamState = {
  status: TradeStatus | null;
  statusAt: number | null;
  spot: number | null;
  spotAt: number | null;
  /** When the server's ticker batch last changed, and where it came from. */
  board: { at: number | null; source: 'socket' | 'rest' | 'none' } | null;
  /** Frames are arriving. */
  live: boolean;
};

const IDLE: StreamState = { status: null, statusAt: null, spot: null, spotAt: null, board: null, live: false };

/** The constructor, so a test can hand in a fake EventSource. */
export type EventSourceLike = {
  addEventListener(type: string, cb: (ev: { data?: string }) => void): void;
  close(): void;
};
export type EventSourceFactory = (url: string) => EventSourceLike;
const defaultFactory: EventSourceFactory = (url) => new EventSource(url) as unknown as EventSourceLike;

export function useStream(enabled: boolean, factory: EventSourceFactory = defaultFactory): StreamState {
  const visible = usePageVisible();
  const [state, setState] = useState<StreamState>(IDLE);
  const lastFrame = useRef<number>(0);

  useEffect(() => {
    if (!enabled || !visible || (factory === defaultFactory && typeof EventSource === 'undefined')) {
      setState((s) => (s.live ? { ...s, live: false } : s));
      return;
    }
    let closed = false;
    const es = factory('/api/stream');
    const heard = () => {
      lastFrame.current = Date.now();
      setState((s) => (s.live ? s : { ...s, live: true }));
    };
    es.addEventListener('open', heard);
    es.addEventListener('ping', heard);
    es.addEventListener('status', (ev) => {
      heard();
      try {
        const status = JSON.parse(ev.data ?? 'null') as TradeStatus;
        setState((s) => ({ ...s, status, statusAt: Date.now(), live: true }));
      } catch { /* a frame that is not JSON is not a status */ }
    });
    es.addEventListener('spot', (ev) => {
      heard();
      try {
        const { spot } = JSON.parse(ev.data ?? '{}') as { spot?: number };
        if (typeof spot === 'number' && spot > 0) setState((s) => ({ ...s, spot, spotAt: Date.now(), live: true }));
      } catch { /* ignored */ }
    });
    es.addEventListener('board', (ev) => {
      heard();
      try {
        const board = JSON.parse(ev.data ?? 'null') as StreamState['board'];
        setState((s) => ({ ...s, board, live: true }));
      } catch { /* ignored */ }
    });
    // The browser is reconnecting, or has given up. Either way nothing is
    // arriving, and the polls should be running until something is.
    es.addEventListener('error', () => setState((s) => (s.live ? { ...s, live: false } : s)));
    // A connection that is open and silent is not live either.
    const watchdog = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastFrame.current > QUIET_MS) setState((s) => (s.live ? { ...s, live: false } : s));
    }, 2_000);
    return () => {
      closed = true;
      clearInterval(watchdog);
      es.close();
      setState((s) => (s.live ? { ...s, live: false } : s));
    };
  }, [enabled, visible, factory]);

  return state;
}
