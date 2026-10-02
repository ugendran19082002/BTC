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
const ORIGIN_WORDS: Record<TradeOrigin, string> = {
  manual: 'Manual',
  strategy: 'Strategy',
  'best-pick': 'Best pick',
};

export function OriginTag({ origin, strategyName, strategyId, className }: {
  origin?: TradeOrigin | null;
  /**
   * The strategy's name: its current one (the server looks it up by id, so a
   * rename shows here), or the one stamped when it was placed once deleted.
   *
   * Absent on orders placed before 27 Sep 2026, when the plan carried only the
   * id — `strategyId` is the fallback for those, and it is a poor label: the ids
   * are historical (`5-01-copy` is the strategy named "3.55", entering at 15:55),
   * so an old row reads as the wrong time. New orders carry the name.
   */
  strategyName?: string | null;
  /** Only used as a last resort for orders placed before the name was stamped. */
  strategyId?: string | null;
  className?: string;
}) {
  // Absent is what every trade placed before the field existed was: by hand.
  const kind: TradeOrigin = origin ?? 'manual';
  const Icon = kind === 'strategy' ? CalendarClock : kind === 'best-pick' ? Bot : Hand;
  const named = strategyName ?? strategyId ?? null;
  const label = kind === 'strategy' && named ? named : ORIGIN_WORDS[kind];
  return (
    <span
      className={cn('origin-tag', kind, className)}
      aria-label={`placed by: ${ORIGIN_WORDS[kind].toLowerCase()}`}
      title={kind === 'strategy'
        ? `Placed by a saved strategy${named ? ` (${named})` : ''} at its entry time.`
          + (!strategyName && strategyId ? ' Placed before the name was recorded, so this is its id.' : '')
        : kind === 'best-pick'
          ? 'Placed automatically from the best-pick card, by the rules set there.'
          : 'Placed by hand from the order ticket.'}
    >
      <Icon size={11} aria-hidden />
      {label}
    </span>
  );
}
