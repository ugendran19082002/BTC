import { useEffect, useState, type ReactNode } from 'react';
import { usePoll } from '@/hooks/usePoll';
import { getLive, strikeKey } from '@/api/live';
import type { LiveResponse } from '@/types/live';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { VerdictBar } from './VerdictBar';
import { MomentumCard } from './MomentumCard';
import { Ladder } from './Ladder';
import { StrikeSafety } from './StrikeSafety';
import { Card, Nothing } from './parts';
import { SignalDesk } from './SignalDesk';
import type { StateHistoryRow } from '@/api/desk';
import type { Measured } from '@/types/live';
import type { Checked } from './Liveness';

/**
 * The Live screen, rebuilt top to bottom (27 Sep 2026).
 *
 * The order is `docs/New.md`'s decision path, read downward, and it is the
 * order a person actually asks the questions in:
 *
 *   1. **Verdict** — which way, and may I act? One answer, above everything
 *      that argues for it.
 *   2. **Big move** — is something breaking now, with a stop and a target, and
 *      what has that shape actually paid?
 *   3. **Settlement band** — how far can it get before 17:30?
 *   4. **Timeframes** — the weighted 12H→1M ladder the verdict came from.
 *   5. **Strike safety** — the strikes on the board, against that same band.
 *
 * Two design rules hold the screen together, and both come from measurement
 * rather than taste:
 *
 * - **One read, one timestamp.** Everything here comes from a single
 *   `/api/live` call. The screen this replaced polled eight endpoints on four
 *   intervals, so its 12-hour row could be a minute older than its 5-minute
 *   row and the page could contradict itself while every part was correct.
 *
 * - **No figure without its provenance.** Measured, modelled or observed, and
 *   measured numbers carry their sample size. The finding in
 *   `docs/FULL-STUDY.md` §7.5 was a hit rate shown without its net R; the fix
 *   is not a caveat in a tooltip, it is that the card cannot be rendered
 *   without the cost beside it.
 *
 * There is no "100% accuracy" mode, and there is no setting that hides a
 * verdict. `docs/New.md` says it plainly — *100% accuracy இல்லை* — and the
 * measured tables behind this screen agree: direction is a coin flip at every
 * horizon, and the edge, where there is one, is in knowing how far price can
 * travel rather than which way it goes.
 */

/**
 * Five seconds, not twenty (27 Sep 2026).
 *
 * The marks on this screen -- the band's centre, every strike distance -- are
 * measured from the last traded price, so polling every twenty seconds meant
 * they could sit twenty seconds behind the price in the header. A screen that
 * says it is LTP-based has to keep up with the tick.
 *
 * Cheap, because the server splits its cache: the expensive half (the candle
 * fetch, the timeframe ladder, the momentum call) is decided at bar closes and
 * reused for twenty seconds, while the price and the arithmetic over it are
 * recomputed per request. So a faster poll costs one cached ticker read and some
 * floating-point, not six candle fetches.
 */
const POLL_MS = 5_000;

export function LiveScreen({
  expiry,
  strikes = [],
  chart,
  journal,
  chain,
  controls,
}: {
  /** The contract the band is drawn to. Absent means the nearest live one. */
  expiry?: string;
  /** Strikes to judge, as `{cp, strike}`. The board below decides what is here. */
  strikes?: readonly { cp: 'C' | 'P'; strike: number }[];
  /**
   * The candles.
   *
   * Passed in rather than fetched here: the caller already owns the candle
   * poll and the chart's own timeframe control, and a chart that re-fetched
   * on this screen's twenty-second cycle would fight it. It sits directly
   * under the verdict because the first thing anyone does after reading a
   * call is look at the picture.
   */
  chart?: ReactNode;
  /**
   * The journal's rows for the chosen range, and everything the header needs.
   *
   * Required: there is one layout now. The stacked fallback that rendered the
   * four cards and a separate history list underneath was removed on 27 Sep
   * 2026 — two layouts for one screen meant the cards could be read without the
   * measured record that qualifies them, which is the whole reason the desk
   * exists.
   */
  journal: {
    rows: readonly StateHistoryRow[];
    rate?: { correct: number; graded: number };
    measured?: Measured | null;
    checked?: Checked;
    total?: number;
    tf?: string;
    range: number | null;
    onRange: (days: number | null) => void;
    tfControl?: ReactNode;
  };
  /** The option chain, rendered under the screen by the caller. */
  chain?: ReactNode;
  /** Mode and refresh controls, drawn in the header. */
  controls?: ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const keys = strikes.map((s) => strikeKey(s.cp, s.strike));
  const { data, error, loading } = usePoll<LiveResponse>(
    () => getLive({ expiry, strikes: keys }),
    POLL_MS,
    { deps: [expiry, keys.join(',')] },
  );

  if (error && !data) {
    return (
      <Card title="Live">
        <Nothing>Could not read the market: {error.message}</Nothing>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card title="Live">
        <Nothing>{loading ? 'Reading the market…' : 'No data.'}</Nothing>
      </Card>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}

      {chart && <ErrorBoundary where="Price chart">{chart}</ErrorBoundary>}

      {/*
        The journal and the market read as one screen (27 Sep 2026).
        `SignalDesk` owns the layout; the cards are passed into it so each one
        stays the single place its own figure is drawn.
      */}
      <ErrorBoundary where="Signal desk">
        <SignalDesk
          rows={journal.rows}
          rate={journal.rate}
          measured={journal.measured}
          checked={journal.checked}
          total={journal.total}
          tf={journal.tf}
          spot={data.spot}
          range={journal.range}
          onRange={journal.onRange}
          tfControl={journal.tfControl}
          verdict={(
            <VerdictBar
              ladder={data.ladder}
              readiness={data.readiness}
              hoursLeft={data.hoursToExpiry}
              asOf={data.asOf}
              now={now}
              stability={data.stability}
              penalties={data.penalties}
            />
          )}
          bigMove={<MomentumCard signal={data.momentum} id="live-momentum" />}
          timeframes={<Ladder ladder={data.ladder} id="live-ladder" />}
          strikes={<StrikeSafety strikes={data.strikes} id="live-strikes" />}
        />
      </ErrorBoundary>

      {/*
        What the screen could not read. Absent data is stated, never drawn as
        a zero or a dash a reader has to interpret.
      */}
      {data.missing.length > 0 && (
        <Card title="Not read" hint="Rows the screen wanted and did not get.">
          <ul className="space-y-1">
            {data.missing.map((m) => (
              <li key={m} className="text-[12px] leading-snug text-muted-foreground">{m}</li>
            ))}
          </ul>
        </Card>
      )}

      {chain}
    </div>
  );
}
