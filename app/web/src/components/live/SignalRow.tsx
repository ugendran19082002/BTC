import type { StateHistoryRow } from '@/api/desk';
import { cn } from '@/lib/utils';

/**
 * One journalled call, and how it turned out.
 *
 * The bar is the point of this row. A call is two prices and a question — did it
 * reach its target before its stop — and a table of numbers makes the reader do
 * that arithmetic in their head for every row. The bar spans **trigger →
 * target**, fills toward the target, and marks where price actually got to; a
 * call that stopped out fills the other way, in the losing colour.
 *
 * Three states, and they are never dressed alike:
 *
 *   waiting      the trigger has not been reached; there is no result yet, only
 *                a distance to it
 *   resolved     it finished, and the fill shows how far it got
 *   ungraded     its window has not closed, so nothing is claimed
 *
 * `docs/New.md` §26 lists the states this desk distinguishes, and the one it
 * refuses: **WRONG is not a live state.** A setup whose trigger was never
 * reached did not happen, and calling it wrong would count it in a hit rate it
 * was never part of.
 */

const ARROW: Record<string, string> = { UP: '↗', DOWN: '↘' };

/** Words for the outcome, as the desk says them. Never "wrong". */
export const OUTCOME_WORDS: Record<string, { text: string; tone: 'up' | 'down' | 'dim' }> = {
  TARGET_HIT: { text: 'Target hit', tone: 'up' },
  INVALIDATED: { text: 'Invalidated', tone: 'down' },
  NOT_TRIGGERED: { text: 'Not triggered', tone: 'dim' },
  EXPIRED: { text: 'Expired', tone: 'dim' },
  NOT_GRADED: { text: 'Not graded', tone: 'dim' },
};

const n0 = (v: number) => Math.round(v).toLocaleString('en-IN');
const signed = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}`;

/** Where `price` sits between `from` and `to`, 0..1, whichever way round they are. */
export function progressOf(from: number, to: number, price: number): number {
  const span = to - from;
  if (!Number.isFinite(span) || span === 0) return 0;
  return Math.min(1, Math.max(0, (price - from) / span));
}

export function SignalRow({ row, spot }: {
  row: StateHistoryRow;
  /** The live price, for a call still waiting on its trigger. */
  spot?: number | null;
}) {
  const p = row.plan;
  const side = row.side;
  const title = row.event.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const outcome = row.outcome ? OUTCOME_WORDS[row.outcome] ?? null : null;

  // Waiting: the window is open and the trigger has not been taken out.
  const waiting = row.outcome === null || row.outcome === 'NOT_GRADED';
  const triggered = row.triggeredAt != null;

  // Where price ended up — the graded close, else the live price.
  const now = row.resolvedClose ?? spot ?? null;
  const reached = row.firstHitPrice ?? row.mfePrice ?? now;

  const bar = p && p.trigger > 0 && p.target1 > 0
    ? { from: p.trigger, to: p.target1, at: reached }
    : null;
  const pct = bar && bar.at != null ? progressOf(bar.from, bar.to, bar.at) : 0;
  const lost = row.outcome === 'INVALIDATED';

  // How far the trigger still is, for a call that has not started.
  const toTrigger = !triggered && p && now != null ? Math.abs(p.trigger - now) : null;

  return (
    <li className="sig-row">
      <div className="sig-when">
        <b>{new Date(row.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true })}</b>
        <span>{new Date(row.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
      </div>

      <span className={cn('sig-arrow', side === 'UP' ? 'up' : side === 'DOWN' ? 'down' : 'flat')} aria-hidden>
        {side ? ARROW[side] : '→'}
      </span>

      <div className="sig-body">
        <div className="sig-head">
          <b>{title}</b>
          {row.confidence != null && <span className="sig-score">({row.confidence})</span>}
          <span className="sig-tf">{row.tf}</span>
        </div>

        {p && side && (
          <div className="sig-plan-line">
            {side === 'UP' ? 'Over' : 'Under'} {n0(p.trigger)} → target {n0(p.target1)}
          </div>
        )}
        <div className="sig-move">
          BTC {n0(row.close)}{now != null && now !== row.close ? ` → ${n0(now)}` : ''}
        </div>
        {row.firstHit && row.firstHit !== 'NONE' && row.firstHitPrice != null && (
          <div className="sig-hit">Hit: {row.firstHit} at {n0(row.firstHitPrice)}</div>
        )}

        {p && (
          <div className="sig-levels">
            <span>Trigger <b>{n0(p.trigger)}</b></span>
            <span>Target <b>{n0(p.target1)}</b></span>
            <span>Stop <b>{n0(p.invalidation)}</b></span>
          </div>
        )}
      </div>

      <div className="sig-bar-cell">
        {bar ? (
          <>
            <div className="sig-bar" role="img"
              aria-label={`from ${n0(bar.from)} toward ${n0(bar.to)}${bar.at != null ? `, reached ${n0(bar.at)}` : ''}`}>
              <span className={cn('sig-bar-fill', lost && 'lost')} style={{ width: `${pct * 100}%` }} />
              {bar.at != null && <span className={cn('sig-bar-dot', lost && 'lost')} style={{ left: `${pct * 100}%` }} />}
            </div>
            <div className="sig-bar-ends">
              <span>{n0(bar.from)}</span>
              <span>{n0(bar.to)}</span>
            </div>
          </>
        ) : <div className="sig-bar-none">—</div>}
      </div>

      <div className="sig-verdict">
        {waiting
          ? <span className="sig-badge waiting">WAITING</span>
          : outcome
            ? <span className={cn('sig-badge', outcome.tone)}>{outcome.text.toUpperCase()}</span>
            : null}
        {toTrigger != null && waiting && (
          <span className="sig-to-trigger">{n0(toTrigger)} pts to trigger</span>
        )}
      </div>

      <div className="sig-result">
        <span className="sig-result-label">{waiting ? 'Current' : 'Result'}</span>
        {row.movePts != null
          ? <b className={cn(row.movePts > 0 ? 'up' : row.movePts < 0 ? 'down' : 'flat')}>{signed(row.movePts)} pts</b>
          : <b className="flat">—</b>}
      </div>
    </li>
  );
}
