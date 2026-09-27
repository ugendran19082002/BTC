import type { Ladder, Readiness, LiveResponse } from '@/types/live';
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
/**
 * Words for the stability verdict, and how alarmed to be about each.
 *
 * "Holding" is muted, not green: on this screen colour means *direction*, never
 * quality (see `parts.tsx`), and a stable read is a fact about the read rather
 * than a recommendation. Only the two that should slow somebody down are
 * coloured, and `warn` is the one tone that legitimately means "look at this".
 */
const STABILITY: Record<string, { text: string; tone: 'dim' | 'warn' }> = {
  STABLE: { text: 'Holding', tone: 'dim' },
  CHOPPY: { text: 'Mixed', tone: 'warn' },
  UNSTABLE: { text: 'Low stability', tone: 'warn' },
  TOO_FEW: { text: 'Too few calls', tone: 'dim' },
};

export function VerdictBar({ ladder, readiness, hoursLeft, asOf, now, stability, penalties = [] }: {
  ladder: Ladder;
  readiness: Readiness;
  hoursLeft: number;
  asOf: number;
  now: number;
  /**
   * Whether the read has been holding its direction — `docs/New.md` §32.
   *
   * It sits beside the arrow because a direction that changed side four times in
   * the last hour is not a direction, and the arrow alone cannot say so.
   */
  stability?: LiveResponse['stability'];
  /**
   * Reasons the confidence is worth less than it looks — `docs/New.md` §33.
   * Shown under the verdict, separately from the blockers: a blocker stops you,
   * a penalty discounts you.
   */
  penalties?: LiveResponse['penalties'];
}) {
  const tone = toneOf(ladder.bias);
  const ageSec = Math.max(0, Math.round((now - asOf) / 1000));
  // A screen quietly showing a two-minute-old market is worse than one saying so.
  const stale = ageSec > 90;

  const h = Math.floor(hoursLeft);
  const m = Math.round((hoursLeft - h) * 60);

  return (
    /*
     * No frame of its own: this sits *inside* the Big move card (27 Sep 2026),
     * and a bordered box inside a bordered box reads as two things when it is
     * the heading of one.
     */
    <div className="border-b border-border pb-2">
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

        {stability && STABILITY[stability.verdict] && (
          <span
            className={cn('text-[12px]', TONE_TEXT[STABILITY[stability.verdict]!.tone])}
            title={stability.text}
          >
            {STABILITY[stability.verdict]!.text}
            {stability.flips > 0 && ` · ${stability.flips} side change${stability.flips === 1 ? '' : 's'}/h`}
          </span>
        )}

        <span className="ml-auto flex items-baseline gap-3 text-[12px] text-muted-foreground">
          <span className="font-mono">{h}h {String(m).padStart(2, '0')}m to settlement</span>
          <span className={cn('font-mono', stale && TONE_TEXT.warn)} title={new Date(asOf).toLocaleTimeString()}>
            {stale ? `${ageSec}s old` : 'live'}
          </span>
        </span>
      </div>

      {/*
        Penalties before blockers: a blocker is about *this* trade, a penalty is
        about how much the whole screen is worth right now, and the second is the
        thing somebody skimming needs to see.
      */}
      {penalties.length > 0 && (
        <ul className="mt-2.5 space-y-1" aria-label="Why this read is worth less than it looks">
          {penalties.map((p) => (
            <li key={p.reason} className="flex flex-wrap gap-x-1.5 text-[12.5px] leading-snug">
              <span className="flex-none font-semibold text-[var(--warn)]">{p.reason}:</span>
              <span className="text-muted-foreground">{p.detail}</span>
            </li>
          ))}
        </ul>
      )}

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
