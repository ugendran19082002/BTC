import { cn } from '@/lib/utils';
import { inr, pnlTone, signedInr, signedUsd, usd, usdToInr } from '@/lib/format';

/**
 * An amount of money: rupees first, dollars small beside them.
 *
 * The account is Indian, so rupees are the number that means something; Delta
 * quotes in dollars, so they stay. One component, so every card writes money
 * the same way.
 */
export function Money({ value, signed = false, strong = false, className }: {
  /** In USD. Null shows a dash: no number yet is not the same as zero. */
  value: number | null | undefined;
  /** Show + or − and colour it green or red. */
  signed?: boolean;
  strong?: boolean;
  className?: string;
}) {
  const tone = signed ? pnlTone(value) : undefined;
  const rupees = usdToInr(value);
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 tabular-nums', className)}>
      <span
        className={cn(
          'font-semibold',
          strong ? 'text-[15px]' : 'text-[13.5px]',
          tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : 'text-foreground',
        )}
      >
        {signed ? signedInr(rupees) : inr(rupees)}
      </span>
      <span className="text-[11px] text-muted-foreground">{signed ? signedUsd(value) : usd(value)}</span>
    </span>
  );
}
