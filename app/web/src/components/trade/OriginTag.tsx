import { Bot, Hand, CalendarClock } from 'lucide-react';
import type { TradeOrigin } from '@/types/trade';
import { cn } from '@/lib/utils';

/**
 * Who asked for this order.
 *
 * Three things place orders on this desk — a person at the ticket, a saved
 * strategy at its entry time, and the best-pick card's auto-trade — and until
 * now a position card looked identical whichever it was. At 11 in the morning
 * "did I do this, or did the desk?" is the first question, and the answer was
 * only in the Telegram message, if there was one.
 *
 * The name of the strategy when there is one, because "strategy" alone does not
 * answer "which one" on a desk running four of them.
 */
export const ORIGIN_WORDS: Record<TradeOrigin, string> = {
  manual: 'Manual',
  strategy: 'Strategy',
  'best-pick': 'Best pick',
};

export function OriginTag({ origin, strategyName, className }: {
  origin?: TradeOrigin | null;
  /** The strategy's name, when it is known; the id is not worth showing. */
  strategyName?: string | null;
  className?: string;
}) {
  // Absent is what every trade placed before the field existed was: by hand.
  const kind: TradeOrigin = origin ?? 'manual';
  const Icon = kind === 'strategy' ? CalendarClock : kind === 'best-pick' ? Bot : Hand;
  const label = kind === 'strategy' && strategyName ? strategyName : ORIGIN_WORDS[kind];
  return (
    <span
      className={cn('origin-tag', kind, className)}
      aria-label={`placed by: ${ORIGIN_WORDS[kind].toLowerCase()}`}
      title={kind === 'strategy'
        ? `Placed by a saved strategy${strategyName ? ` (${strategyName})` : ''} at its entry time.`
        : kind === 'best-pick'
          ? 'Placed automatically from the best-pick card, by the rules set there.'
          : 'Placed by hand from the order ticket.'}
    >
      <Icon size={11} aria-hidden />
      {label}
    </span>
  );
}
