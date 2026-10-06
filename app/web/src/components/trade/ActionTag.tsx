import { cn } from '@/lib/utils';

/**
 * Whether the option was sold or bought to open (owner, 5 Oct 2026): a label on each position and each order,
 * so a row says what was done as well as on which contract.
 *
 * Read from the trade's own record (`plan.action`, stamped when it is placed). A trade from before the label
 * has none and reads as SELL, which is what every trade on this desk was.
 */
export function ActionTag({ action, className }: { action?: 'sell' | 'buy' | null; className?: string }) {
  const bought = action === 'buy';
  return (
    <span
      aria-label={bought ? 'bought to open' : 'sold to open'}
      className={cn(
        'inline-block rounded-full border border-solid px-2 py-[1px] text-[10px] font-semibold tracking-[0.3px]',
        // Blue for a BUY, as on the phone view (6 Oct 2026): green and red are for money, and a side is not a gain.
        bought ? 'border-[color-mix(in_srgb,var(--buy)_40%,transparent)] bg-[color-mix(in_srgb,var(--buy)_10%,transparent)] text-[var(--buy)]' : 'border-[#f8514955] bg-[#f8514915] text-[var(--down)]',
        className,
      )}
    >
      {bought ? 'BUY' : 'SELL'}
    </span>
  );
}
