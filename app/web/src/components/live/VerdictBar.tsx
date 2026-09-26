import type { Ladder, Readiness } from '@/types/live';
import { ARROW, WORD, toneOf, TONE_TEXT, pct0 } from './parts';
import { cn } from '@/lib/utils';

/**
 * The screen's one answer, at the top, before anything that argues for it.
 *
 * Two facts and nothing else: which way the weighted ladder reads, and whether
 * the desk is allowed to act on it. They are separate on purpose — a strong
 * DOWN read with the 5M trigger still pointing up is a common and important
 * state, and a single green light cannot express it.
 *
 * When it is not ready, every blocker is listed here rather than summarised.
 * "Not ready (3)" makes a person hunt; the three sentences make them decide.
 */
export function VerdictBar({ ladder, readiness, hoursLeft, asOf, now }: {
  ladder: Ladder;
  readiness: Readiness;
  hoursLeft: number;
  asOf: number;
  now: number;
}) {
  const tone = toneOf(ladder.bias);
  const ageSec = Math.max(0, Math.round((now - asOf) / 1000));
  // A screen quietly showing a two-minute-old market is worse than one saying so.
  const stale = ageSec > 90;

  const h = Math.floor(hoursLeft);
  const m = Math.round((hoursLeft - h) * 60);

  return (
    <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2">
          <span className={cn('text-[26px] leading-none', TONE_TEXT[tone])} aria-hidden>{ARROW[ladder.bias]}</span>
          <span className={cn('text-[20px] font-semibold leading-none', TONE_TEXT[tone])}>{WORD[ladder.bias]}</span>
        </div>

        <span
          className={cn(
            'rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
            readiness.ready ? 'bg-[var(--up)]/15 text-[var(--up)]' : 'bg-[var(--warn)]/15 text-[var(--warn)]',
          )}
        >
          {readiness.ready ? `Entry ready · ${readiness.side}` : 'Not ready'}
        </span>

        <span className="text-[12px] text-muted-foreground">
          {pct0(ladder.alignment)} of the weight agrees
        </span>

        <span className="ml-auto flex items-baseline gap-3 text-[12px] text-muted-foreground">
          <span className="font-mono">{h}h {String(m).padStart(2, '0')}m to settlement</span>
          <span className={cn('font-mono', stale && TONE_TEXT.warn)} title={new Date(asOf).toLocaleTimeString()}>
            {stale ? `${ageSec}s old` : 'live'}
          </span>
        </span>
      </div>

      {!readiness.ready && readiness.blockers.length > 0 && (
        <ul className="mt-2.5 space-y-1" aria-label="What is blocking entry">
          {readiness.blockers.map((b) => (
            <li key={b} className="flex gap-1.5 text-[12.5px] leading-snug text-muted-foreground">
              <span aria-hidden className="flex-none text-[var(--warn)]">·</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
