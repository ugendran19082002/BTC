import type { Trade } from '@/types/trade';
import { closeAll } from '@/lib/close-cost';
import { signedInr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Why Home's "Today's P&L" and Positions' "Total P&L" are two numbers (owner, 4 Nov 2026: "morning start aakum pothu home
 * pnl amount and position pnl match aakutha ilaya doubt iruku"; then "user friendly, mobile friendly"): one at the mark,
 * one closed now -- and the cost of leaving between them, the spread to the ask and the charges to close
 * (`lib/close-cost.ts`). A soft tile of two short rows -- the figure, bold and coloured, and the exit cost, muted --
 * in whole rupees, that fit a 320px phone. Nothing when nothing is open, or
 * no open trade has both figures yet.
 *
 * `home`: under the day's figure, the day if every position closed now -- Positions' number.
 * `positions`: under the total if closed now, the same trades at the mark -- Home's way.
 */
export function CloseAllNote({ open, dayNetUsd, on }: { open: readonly Trade[]; dayNetUsd?: number | null; on: 'home' | 'positions' }) {
  const all = closeAll(open);
  if (all.priced === 0) return null;
  if (on === 'home' && (dayNetUsd === null || dayNetUsd === undefined)) return null;
  // Whole rupees, so "+₹94" reads beside "−₹129" rather than "+₹94.00".
  const rupees = (usd: number) => signedInr(Math.round(usdToInr(usd)!));
  const [label, usd] = on === 'home' ? ['If you close all now', dayNetUsd! - all.costUsd] : ['At mark (Home\'s P&L)', all.atMarkUsd];
  // A soft tile, no rules: `border-solid` alone draws all four sides here (no preflight), the boxed look of 4 Nov.
  return (
    <dl aria-label={on === 'home' ? 'If every position closed now' : 'At the mark'}
        className="m-0 mt-2 grid gap-1 rounded-md bg-muted px-2.5 py-2 text-[12.5px] leading-tight">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <dt className="min-w-0 truncate text-foreground">{label}</dt>
        <dd className={cn('m-0 shrink-0 text-[14px] font-semibold tabular-nums', usd > 0 ? 'text-[var(--up)]' : usd < 0 ? 'text-[var(--down)]' : '')}>{rupees(usd)}</dd>
      </div>
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-muted-foreground">
        <dt className="min-w-0 truncate">Exit cost (spread + charges)</dt>
        <dd className="m-0 shrink-0 tabular-nums">{rupees(-all.costUsd)}</dd>
      </div>
    </dl>
  );
}
