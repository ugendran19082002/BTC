import type { Trade } from '@/types/trade';
import { closeAll } from '@/lib/close-cost';
import { signedInr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Why Home's "Today's P&L" and Positions' "Total P&L" are two numbers (owner, 4 Nov 2026: "morning start aakum pothu home
 * pnl amount and position pnl match aakutha ilaya doubt iruku"; then "user friendly, mobile friendly"): one at the mark,
 * one closed now -- and the cost of leaving between them, the spread to the ask and the charges to close
 * (`lib/close-cost.ts`). Two short rows, a label and its amount, that fit a 320px phone. Nothing when nothing is open, or
 * no open trade has both figures yet.
 *
 * `home`: under the day's figure, the day if every position closed now -- Positions' number.
 * `positions`: under the total if closed now, the same trades at the mark -- Home's way.
 */
export function CloseAllNote({ open, dayNetUsd, on }: { open: readonly Trade[]; dayNetUsd?: number | null; on: 'home' | 'positions' }) {
  const all = closeAll(open);
  if (all.priced === 0) return null;
  if (on === 'home' && (dayNetUsd === null || dayNetUsd === undefined)) return null;
  const rows: [string, number][] = on === 'home'
    ? [['If all closed now', dayNetUsd! - all.costUsd], ['Spread + charges to close', -all.costUsd]]
    : [['At the mark, as Home counts', all.atMarkUsd], ['Spread + charges to close', -all.costUsd]];
  return (
    <dl aria-label={on === 'home' ? 'If every position closed now' : 'At the mark'}
        className="m-0 mt-2 grid gap-0.5 border-t border-solid border-[var(--line-soft)] pt-2 text-[12.5px]">
      {rows.map(([label, usd], i) => (
        <div key={label} className="flex min-w-0 items-baseline justify-between gap-2">
          <dt className="min-w-0 truncate text-muted-foreground">{label}</dt>
          <dd className={cn('m-0 shrink-0 tabular-nums', i === 0 && 'font-semibold', usd > 0 ? 'text-[var(--up)]' : usd < 0 ? 'text-[var(--down)]' : '')}>
            {signedInr(usdToInr(usd))}
          </dd>
        </div>
      ))}
    </dl>
  );
}
