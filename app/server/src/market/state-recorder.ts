import { readState, STATE_TFS, type StateTf } from './state-read.js';
import { gradeStates, noteState } from './state-history.js';

/**
 * The signal journal's own recorder: every timeframe, on the server's clock.
 *
 * ## The bug this exists to fix
 *
 * Until 27 September 2026 `noteState` was called from **one place only** --
 * `GET /api/market-state`, the request the Live screen's chart makes. So the
 * journal recorded a call if, and only if, somebody had the page open, *and*
 * had that particular timeframe selected.
 *
 * What that looked like in the table on the morning of 27 Sep:
 *
 * ```
 *  tf  |  n  |       newest
 * -----+-----+---------------------
 *  1h  |   4 | 2026-09-27 00:41:06
 *  30m |  18 | 2026-09-27 00:10:10
 *  4h  |   1 | 2026-09-27 00:01:19
 *  5m  | 215 | 2026-09-26 19:37:21   <- thirteen hours earlier
 *  15m |  45 | 2026-09-26 15:06:10
 * ```
 *
 * Those timestamps are not a record of the market. They are a record of which
 * chart somebody was looking at. The 5-minute row count is high because that
 * is the tab that gets left open; the 4-hour count is 1 because almost nobody
 * selects it. Overnight, with no browser open, BTC moved and the journal
 * recorded nothing at all -- and the hit rate on the card was computed from
 * that.
 *
 * A journal whose coverage depends on a viewer cannot answer "is this signal
 * any good?", because the calls it missed are not missing at random: they are
 * missing from exactly the hours nobody was watching.
 *
 * ## The rule, which this repo already had
 *
 * `index.ts` already says it, about the option board:
 *
 * > The board's own record, every five minutes, **viewer or no viewer**: the
 * > hour-ago reads must have no gaps.
 *
 * The same rule was applied to `option_snapshots`, `index_1m`, `perp_snapshots`
 * and `trade_flow_1m`, and simply never applied to `market_states`. This file
 * applies it: all six timeframes, on a timer, off the request path.
 *
 * ## Why the cadence is per-timeframe
 *
 * A 4-hour state cannot change more than once every four hours, so reading it
 * every minute is four hours of wasted candle fetches for one possible write.
 * Each timeframe is read at its own bar interval, floored at a minute and
 * capped so even the 4-hour frame is checked a few times a bar -- a state can
 * change mid-bar (a level breaks, volume confirms), and the journal should
 * catch it near when it happened rather than at the next boundary.
 *
 * `noteState` already dedupes on `(event, stage)`, so reading more often than
 * the state changes costs a query and writes nothing.
 */

/** How often each timeframe is re-read, ms. Roughly a third of its own bar, floored at a minute. */
export const CHECK_MS: Record<StateTf, number> = {
  '5m': 60_000,
  '15m': 60_000,
  '30m': 2 * 60_000,
  '1h': 5 * 60_000,
  '2h': 10 * 60_000,
  '4h': 15 * 60_000,
};

/** Stagger the first read of each timeframe so six candle fetches do not land together on boot. */
const STAGGER_MS = 7_000;

export type Recorded = { tf: StateTf; id: number | null; error?: string };

/**
 * Read one timeframe and journal it if it changed.
 *
 * Never throws: a journal that cannot be written is a warning, not a reason to
 * take anything else down with it. The caller gets the reason in `error`.
 */
export async function recordState(tf: StateTf, nowMs = Date.now()): Promise<Recorded> {
  try {
    const read = await readState(tf, nowMs);
    const id = await noteState(read);
    return { tf, id };
  } catch (e) {
    return { tf, id: null, error: (e as Error).message };
  }
}

/** Every timeframe, once. Sequential on purpose -- six parallel candle fetches is a burst Delta rate-limits. */
export async function recordAllStates(nowMs = Date.now()): Promise<Recorded[]> {
  const out: Recorded[] = [];
  for (const tf of STATE_TFS) out.push(await recordState(tf, nowMs));
  return out;
}

/**
 * Start the recorder. Returns a stop function, so a test can start it and put
 * it back rather than leaving a timer behind.
 *
 * `onWarn` receives a message per failed timeframe; `index.ts` sends it to the
 * error log. Timers are unrefed so they never hold the process open.
 */
export function startStateRecorder(opts: {
  onWarn?: (message: string) => void;
  now?: () => number;
} = {}): () => void {
  const { onWarn, now = Date.now } = opts;
  const timers: NodeJS.Timeout[] = [];

  STATE_TFS.forEach((tf, i) => {
    const tick = () => {
      void recordState(tf, now()).then((r) => {
        if (r.error) onWarn?.(`market-state ${tf} not written: ${r.error}`);
      });
    };
    // Grading runs alongside the fastest frame only; it is one query over rows
    // whose window has closed, and running it six times over is six times the
    // same work.
    const first = setTimeout(() => {
      tick();
      const every = setInterval(tick, CHECK_MS[tf]);
      every.unref();
      timers.push(every);
    }, STAGGER_MS * (i + 1));
    first.unref();
    timers.push(first);
  });

  /*
   * Grading, on its own timer rather than on a request.
   *
   * It was called from `/api/market-state` and `/api/market-state/history`, so
   * a call whose evaluation window closed overnight stayed ungraded until
   * somebody opened the page -- and `hitRate` counts only graded rows, so the
   * number on the card was computed from whichever calls happened to have been
   * looked at since.
   */
  const grade = setInterval(() => {
    void gradeStates().catch((e: Error) => onWarn?.(`market-state grading failed: ${e.message}`));
  }, 60_000);
  grade.unref();
  timers.push(grade);

  return () => { for (const t of timers) clearTimeout(t as NodeJS.Timeout); };
}
