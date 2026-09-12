import type { Bias } from '@/types/desk';
import { StatDivider } from '@/components/ui/stat';
import { SectionTitle } from '@/components/ui/section';
import { cn } from '@/lib/utils';

/**
 * Which way the option board is leaning right now, drawn rather than listed.
 *
 * A section under the contract, not a card. It is describing the same market
 * the contract card is describing, and given a card of its own it read as an
 * input to the decision. It is not one: every figure here was tried as a
 * trading rule and none held up across all three years.
 *
 * It used to be three rows of "name · 40%" against "downside, by 0.1 points",
 * which is a table of evidence with the reader left to do the arithmetic. The
 * question anybody actually has is "which way, and how strongly" -- so each
 * input is a needle on the same Down-to-Up scale as the headline, with the word
 * beside it. The exact figure stays, one size down: it is the thing to check
 * once the direction has been read, not the thing to read first.
 */

/** A lean of -1..+1 as a position across a track whose middle is no lean. */
const posOf = (v: number) => ((Math.max(-1, Math.min(1, v)) + 1) / 2) * 100;

/** The word for a lean, so nobody has to read a direction out of a number. */
function leanWord(v: number): string {
  if (v > 0.4) return 'up';
  if (v > 0.15) return 'slightly up';
  if (v < -0.4) return 'down';
  if (v < -0.15) return 'slightly down';
  return 'flat';
}

const toneOf = (v: number) =>
  v > 0.15 ? 'var(--up)' : v < -0.15 ? 'var(--down)' : 'var(--muted-foreground)';

/**
 * One needle on a centred scale.
 *
 * Centred rather than filled from the left, because zero here means "neither
 * way" and a bar that reads half full at zero says something else entirely.
 */
function Needle({ value, label, tall = false }: { value: number; label: string; tall?: boolean }) {
  const pos = posOf(value);
  return (
    <span
      role="img"
      aria-label={label}
      className={cn('relative block w-full overflow-hidden rounded-full bg-muted', tall ? 'h-2' : 'h-1.5')}
    >
      {/* the middle of the scale, so "no lean" is a place on it rather than an absence */}
      <i aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--line)]" />
      <i
        aria-hidden
        className="absolute inset-y-0 rounded-full"
        style={{
          left: `${Math.min(pos, 50)}%`,
          // always wide enough to see: a lean of nearly nothing is still a mark
          // at the middle rather than a bar that vanished.
          width: `${Math.max(Math.abs(pos - 50), 1.5)}%`,
          background: toneOf(value),
        }}
      />
    </span>
  );
}

export function BiasSection({ bias }: { bias: Bias }) {
  return (
    <>
      <StatDivider />
      <SectionTitle hint="Over 12 hours this barely predicts anything. For information only, never a reason to trade.">
        Market lean · for info only
      </SectionTitle>

      <p
        className="m-0 mb-1.5 text-[15px] font-semibold"
        style={{ color: toneOf(bias.score) }}
      >
        {bias.label}
      </p>

      <div className="flex items-center gap-2">
        <span className="w-8 flex-none text-[10px] uppercase tracking-[0.5px] text-[var(--dim)]">Down</span>
        <Needle value={bias.score} label={`market lean: ${leanWord(bias.score)}`} tall />
        <span className="w-8 flex-none text-right text-[10px] uppercase tracking-[0.5px] text-[var(--dim)]">Up</span>
      </div>

      <div className="mt-3 grid gap-2.5">
        {bias.components.map((c) => (
          /*
           * The hint carries what the row is counted as and why -- "IV skew
           * (25d): put IV 1.1pt over call" is exact and tells a reader who does
           * not already know it precisely nothing.
           */
          <div key={c.name} title={`${c.means} Counted as ${Math.round(c.weight * 100)}% of the lean.`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{c.name}</span>
              <span className="flex-none text-[11px] tabular-nums text-[var(--dim)]">{c.note}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Needle value={c.value} label={`${c.name}: ${leanWord(c.value)}`} />
              <span
                className="w-[68px] flex-none text-right text-[11px]"
                style={{ color: toneOf(c.value) }}
              >
                {leanWord(c.value)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
