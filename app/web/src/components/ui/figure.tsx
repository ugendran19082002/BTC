import { cn } from '@/lib/utils';

/**
 * A label, a number, and optionally the same number in the other currency.
 *
 * Lifted out of PositionsCard so the exits sheet can show the same three
 * figures in the same shape. They are the same facts about the same position,
 * and a mark that reads one way on the card and another in the sheet is a
 * reason to distrust both.
 *
 * Rupees lead and dollars go underneath wherever this holds money: the account
 * is Indian and that is the number that means something, but the exchange
 * quotes in dollars so they do not go away.
 */
export function Figure({ label, value, second, tone, hint }: {
  label: string;
  value: string;
  second?: string;
  tone?: 'up' | 'down';
  hint?: string;
}) {
  return (
    <div className="min-w-0" title={hint}>
      <div className={cn('text-[10px] uppercase tracking-[0.6px] text-muted-foreground', hint && 'cursor-help')}>
        {label}
      </div>
      <div
        className={cn(
          'truncate text-[14px] font-semibold tabular-nums',
          tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : 'text-foreground',
        )}
      >
        {value}
      </div>
      {second && second !== '—' && (
        <div className="truncate text-[11px] tabular-nums text-muted-foreground">{second}</div>
      )}
    </div>
  );
}
