import { useMemo, useState, type ReactNode } from 'react';
import type { StateHistoryRow } from '@/api/desk';
import type { Measured } from '@/types/live';
import { Liveness, type Checked } from './Liveness';
import { SignalRow } from './SignalRow';
import { signedR, isTradeable } from './MeasuredRecord';
import { cn } from '@/lib/utils';

/**
 * The signal desk: what the journal has said, and whether any of it was worth
 * listening to.
 *
 * One screen, because they are one question. The journal list used to sit inside
 * the market-state card while the measured record sat in a second section and the
 * settlement band in a third — so "what did it call", "how did those turn out"
 * and "does this shape pay" were three places, and a reader could hold any one
 * of them without the other two.
 *
 * The order is the order the questions get asked:
 *
 *   1. **the header** — which timeframe, which range, is the journal even awake
 *   2. **the measured strip** — what this shape has paid, before any row is read
 *   3. **the list** — the calls themselves, each with its own outcome
 *   4. **the right column** — where price can get to, and what is happening now
 *
 * The strip sits *above* the list on purpose. The list is the seductive part —
 * it is full of green "+165 pts" — and the net-after-fees figure is the thing
 * that says what a page of those is actually worth. Putting it second means it
 * is read second.
 */

/** The ranges the tabs offer. `null` is every day the journal still holds. */
export const RANGES: readonly { label: string; days: number | null }[] = [
  { label: 'Today', days: 0 },
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '7 days', days: 7 },
  { label: 'All days', days: null },
];

const PAGE = 8;
const n0 = (v: number) => Math.round(v).toLocaleString('en-IN');

function Stat({ label, value, sub, tone }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'up' | 'down';
}) {
  return (
    <div className="sd-stat">
      <span className="sd-stat-label">{label}</span>
      <b className={cn('sd-stat-value', tone)}>{value}</b>
      {sub ? <span className="sd-stat-sub">{sub}</span> : null}
    </div>
  );
}

export function SignalDesk({
  rows, rate, measured, checked, total, tf, spot, range, onRange, tfControl,
  bigMove, timeframes,
}: {
  rows: readonly StateHistoryRow[];
  rate?: { correct: number; graded: number };
  /** What the replay says this shape has paid. `null` = never graded. */
  measured?: Measured | null;
  /** When the journal last looked — quiet and dead must not read alike. */
  checked?: Checked;
  /** Every call the journal holds, across all days. */
  total?: number;
  tf?: string;
  spot?: number | null;
  range: number | null;
  onRange: (days: number | null) => void;
  /** The timeframe picker, owned by the caller. */
  tfControl?: ReactNode;
  /**
   * The right-hand column: what is happening now, over the ladder it came from.
   *
   * Two things, stacked, beside the list rather than under it — the list is
   * tall and scrolls, and a reader checking "what does it say now" against
   * "what did it say before" should not have to scroll past twenty rows to do
   * it. `Big move` sits above `Timeframes` because it is the conclusion and the
   * ladder is the working.
   */
  bigMove?: ReactNode;
  timeframes?: ReactNode;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = useMemo(() => rows.slice(at * PAGE, at * PAGE + PAGE), [rows, at]);

  const graded = rate?.graded ?? 0;
  const hit = graded > 0 ? (rate!.correct / graded) : null;

  return (
    <section className="sd" aria-label="Signal history">
      {/* 1 — what am I looking at, and is it live? */}
      <header className="sd-head">
        <h2 className="sd-title">Signal History</h2>
        {tfControl}
        <div className="sd-ranges" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              className={cn('sd-range', range === r.days && 'on')}
              aria-pressed={range === r.days}
              onClick={() => { onRange(r.days); setPage(0); }}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="sd-live">{checked !== undefined && <Liveness checked={checked} />}</span>
        <div className="sd-hitrate">
          <span>
            {graded > 0 ? `${rate!.correct} of ${graded} reached target` : 'none finished yet'}
          </span>
          {hit !== null && (
            <>
              <span className="sd-hitbar" aria-hidden>
                <span style={{ width: `${hit * 100}%` }} />
              </span>
              <b>{Math.round(hit * 100)}%</b>
            </>
          )}
        </div>
      </header>

      {/*
        2 — what this shape has actually paid, before a single row is read.
        `docs/FULL-STUDY.md` §7.5: a hit rate with no cost beside it is the
        number that gets traded.
      */}
      <div className="sd-strip">
        <Stat label="Total signals" value={n0(total ?? rows.length)} sub="across all days" />
        <Stat
          label="Replay hit rate"
          value={measured ? `${Math.round(measured.hitRate * 100)}%` : '—'}
          sub={measured ? '(measured)' : 'never graded'}
        />
        <Stat
          label="Net after fees"
          value={measured ? signedR(measured.netR) : '—'}
          tone={measured ? (isTradeable(measured) ? 'up' : 'down') : undefined}
          sub={measured ? `over ${n0(measured.n)}` : undefined}
        />
        <Stat label="Before fees" value={measured ? signedR(measured.avgR) : '—'} />
        <Stat
          label={measured?.outOfSample ? `${measured.outOfSample.year} (held out)` : 'Held out'}
          value={measured?.outOfSample ? signedR(measured.outOfSample.netR) : '—'}
          tone={measured?.outOfSample ? (measured.outOfSample.netR > 0 ? 'up' : 'down') : undefined}
          sub={measured?.outOfSample ? `n = ${n0(measured.outOfSample.n)}` : undefined}
        />
        <div className="sd-note">
          <b>What this shape has paid</b>
          {measured ? (
            <>
              <span>Replay · {measured.tf} · {measured.policy}</span>
              <span className="sd-note-dim">
                {graded > 0 ? `This desk's own calls: ${rate!.correct} of ${graded}. ` : ''}
                {isTradeable(measured) ? 'Worth trading.' : 'Information only.'}
              </span>
            </>
          ) : (
            <span className="sd-note-warn">
              The replay has never graded {tf ?? 'this timeframe'}. Nothing is claimed about these calls.
            </span>
          )}
        </div>
      </div>

      {/* 3 — the calls, beside the read they are the record of */}
      <div className="sd-main">
        <div className="sd-list-wrap">
          <div className="sd-list-head">
            <h3>Signal List</h3>
            <span className="sd-count">{rows.length} signal{rows.length === 1 ? '' : 's'}</span>
          </div>
          {rows.length === 0 ? (
            <p className="sd-empty">
              No calls in this range. The journal records a change of state, so a quiet market writes nothing —
              the header says when it last looked.
            </p>
          ) : (
            <>
              <ul className="sd-list">
                {shown.map((r) => <SignalRow key={r.id} row={r} spot={spot} />)}
              </ul>
              {pages > 1 && (
                <nav className="sd-pager" aria-label="Pages">
                  <button type="button" disabled={at === 0} onClick={() => setPage(at - 1)} aria-label="Newer">‹</button>
                  <span>{at + 1} / {pages}</span>
                  <button type="button" disabled={at >= pages - 1} onClick={() => setPage(at + 1)} aria-label="Older">›</button>
                </nav>
              )}
            </>
          )}
        </div>

        <div className="sd-side">
          {bigMove}
          {timeframes}
        </div>
      </div>
    </section>
  );
}
