import type { Measured } from '@/types/live';
import { cn } from '@/lib/utils';

/**
 * What a signal shape has actually paid — one component, used by both screens.
 *
 * The Live screen's signal history and the Signals tab's momentum card were
 * answering the same question in two different vocabularies: the journal said
 * "8 of 11 reached target", the replay said "−0.149R net after fees over
 * 1,317". Two screens quoting two numbers about one shape is how a desk ends
 * up believing whichever it read last.
 *
 * So the measured record is drawn by this file and nothing else. If the wording
 * changes, it changes in both places; if the verdict rule changes, neither
 * screen can drift from it.
 *
 * The rule, unchanged from `domain/momentum-signal.ts`:
 *
 *   net R after fees > 0  →  worth trading
 *   anything else         →  information only
 *
 * A hit rate is never shown without the net R beside it. That is the entire
 * point — `docs/FULL-STUDY.md` §7.5 — and it is why `measured` is a required
 * prop rather than an optional one: a caller with nothing to show must say so
 * explicitly by passing `null`.
 */

export const signedR = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`;
const pct0 = (v: number) => `${Math.round(v * 100)}%`;
const n0 = (v: number) => v.toLocaleString('en-IN');

/** Whether the replay says this shape paid for itself. The single rule both screens obey. */
export const isTradeable = (m: Measured | null): boolean => m !== null && m.netR > 0;

/**
 * The compact form, for a heading.
 *
 * Deliberately not a badge with a tooltip: the cost has to be readable without
 * hovering, because a phone has no hover and the number that gets acted on is
 * the one that is visible.
 */
export function MeasuredInline({ measured, tf }: { measured: Measured | null; tf?: string }) {
  if (!measured) {
    return (
      <span className="text-[var(--warn)]" title={`The replay has never graded ${tf ?? 'this timeframe'}, so nothing is claimed about it.`}>
        never graded
      </span>
    );
  }
  const good = isTradeable(measured);
  return (
    <span title={`${n0(measured.n)} of these, ${measured.from} → ${measured.to}, after 0.05% taker fees each side.`}>
      replay {pct0(measured.hitRate)} hit ·{' '}
      <b className={good ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{signedR(measured.netR)}</b>{' '}
      net over {n0(measured.n)}
    </span>
  );
}

/**
 * The full form, for a card.
 *
 * `live` is the desk's own journal count, when there is one. It is shown
 * *under* the replay rather than above it, because a few dozen calls taken
 * from whatever hours the screen happened to be open is the weaker evidence of
 * the two, and the order on the page should say so.
 */
export function MeasuredRecord({ measured, live, tf, className, showVerdict = true }: {
  measured: Measured | null;
  live?: { correct: number; graded: number } | null;
  tf?: string;
  className?: string;
  /**
   * Draw the worth-trading / information-only badge.
   *
   * False where the caller already shows the verdict more prominently -- the
   * momentum card puts it beside the state, which is where somebody reading two
   * words of that card will look. Saying it twice in one card trains the eye to
   * skip both.
   */
  showVerdict?: boolean;
}) {
  const good = isTradeable(measured);
  return (
    <div className={cn('rounded border border-border bg-background/40 p-2', className)}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">
          What this shape has paid
        </span>
        {showVerdict && (
          <span
            className={cn(
              'rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide',
              good ? 'bg-[var(--up)]/15 text-[var(--up)]' : 'bg-[var(--warn)]/15 text-[var(--warn)]',
            )}
          >
            {good ? 'Worth trading' : 'Information only'}
          </span>
        )}
      </div>

      {measured ? (
        <>
          <Row label={`Replay · ${measured.tf} · ${measured.policy}`} value={`${n0(measured.n)} calls`} />
          <Row label="Hit rate" value={pct0(measured.hitRate)} />
          <Row
            label="Net after fees"
            value={signedR(measured.netR)}
            tone={measured.netR > 0 ? 'up' : 'down'}
            hint="Profit per unit risked, after 0.05% taker fee both sides. This decides the verdict."
          />
          <Row label="Before fees" value={signedR(measured.avgR)} />
          {measured.outOfSample && (
            <Row
              label={`${measured.outOfSample.year}, held out`}
              value={`${signedR(measured.outOfSample.netR)} · n=${n0(measured.outOfSample.n)}`}
              tone={measured.outOfSample.netR > 0 ? 'up' : 'down'}
              hint="The year nothing was chosen on — the only one that says whether the shape was real."
            />
          )}
        </>
      ) : (
        <p className="py-1 text-[12px] leading-snug text-[var(--warn)]">
          The replay has never graded {tf ?? 'this timeframe'}. Nothing is claimed about it — watch the level, but do not
          size a trade off this.
        </p>
      )}

      {/*
        The desk's own calls, second. Small sample, and not a random one: it
        covers the hours somebody had the screen open.
      */}
      {live && live.graded > 0 && (
        <div className="mt-1.5 border-t border-border pt-1.5">
          <Row
            label="This desk's own calls"
            value={`${live.correct} of ${live.graded} reached target`}
            hint="From the journal. Only calls that triggered and finished are counted. A small sample, and it covers the hours the desk was watched — see the replay above for the shape's real record."
          />
        </div>
      )}
    </div>
  );
}

function Row({ label, value, tone, hint }: {
  label: string;
  value: string;
  tone?: 'up' | 'down';
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[2px]" title={hint}>
      <span className="min-w-0 text-[12px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'flex-none font-mono text-[12px]',
          tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : '',
        )}
      >
        {value}
      </span>
    </div>
  );
}
