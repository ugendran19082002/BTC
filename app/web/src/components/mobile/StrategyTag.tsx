import { Bot, CalendarClock, Hand } from 'lucide-react';
import type { Trade } from '@/types/trade';
import { cn } from '@/lib/utils';
import { GroupTag } from '@/components/strategy/GroupTag';

/**
 * Which strategy placed a trade, as a tag (owner, 8 Oct 2026: "strategy name tag -- orders history, trade history
 * and positions, on the phone"): the strategy's name in a small coloured pill, the same on Positions, Orders and
 * Trade history, so the eye finds it in the same shape on each. Until now the name was the last of a grey line --
 * after the signal's own name, where a long one pushed it off a 360px screen -- and on Orders a signal trade did
 * not say its strategy at all.
 *
 * A trade nobody scheduled reads "By hand", in grey; the best-pick auto-trade "Best pick". A long name is cut with
 * an ellipsis inside the tag, which never grows past the room it is given; the whole of it is read out.
 */

type Plan = NonNullable<Trade['plan']>;

/** Who placed it, in the words the tag shows: the strategy's name (its id for a trade from before names were kept), "By hand", "Best pick". */
export function placedBy(plan: Pick<Plan, 'origin' | 'strategyId' | 'strategyName'> | null | undefined): { kind: 'strategy' | 'manual' | 'best-pick'; label: string } {
  const named = plan?.strategyName ?? plan?.strategyId ?? null;
  // A record from before the origin was written: a strategy if it carries one, by hand if not.
  const kind = plan?.origin ?? (named ? 'strategy' : 'manual');
  if (kind === 'best-pick') return { kind, label: 'Best pick' };
  if (kind === 'strategy') return { kind, label: named ?? 'Strategy' };
  return { kind: 'manual', label: 'By hand' };
}

export function StrategyTag({ plan, className }: { plan: Pick<Plan, 'origin' | 'strategyId' | 'strategyName'> | null | undefined; className?: string }) {
  const { kind, label } = placedBy(plan);
  const Icon = kind === 'strategy' ? CalendarClock : kind === 'best-pick' ? Bot : Hand;
  return (
    <span
      aria-label={kind === 'strategy' ? `Strategy: ${label}` : kind === 'best-pick' ? 'Placed by best pick' : 'Placed by hand'}
      title={label}
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] font-semibold leading-tight',
        kind === 'manual' ? 'bg-muted text-muted-foreground' : 'bg-[var(--accent-soft)] text-[var(--accent)]',
        className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

/**
 * The tag, then what else there is to say on the same line -- the signal, the account -- in grey, cut where the
 * line ends. The tag keeps up to three fifths of the line, so a long strategy name and a long signal name each
 * show their start.
 */
export function PlacedLine({ plan, rest, className }: { plan: Parameters<typeof StrategyTag>[0]['plan']; rest?: (string | null | undefined | false)[]; className?: string }) {
  const more = (rest ?? []).filter(Boolean).join(' · ');
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <StrategyTag plan={plan} className="max-w-[60%] shrink-0" />
      {/* Its group, beside it: dropped first when the line is short -- the strategy's name is the one that must show. */}
      <GroupTag strategyId={plan?.strategyId} className="max-w-[35%] flex-shrink" />
      {more && <span className="min-w-0 truncate text-[12px] text-muted-foreground">{more}</span>}
    </span>
  );
}
