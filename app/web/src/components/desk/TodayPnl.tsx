import * as Popover from '@radix-ui/react-popover';
import type { TradeStatus } from '@/types/trade';
import { pnlTone, signedInr, usdToInr } from '@/lib/format';
import { Money } from '@/components/ui/money';
import { KV } from '@/components/ui/kv';
import { cn } from '@/lib/utils';

/**
 * Today's P&L, always in the header.
 *
 * The one number people open the desk to see. It is the net: booked trades,
 * plus what open positions are worth right now, minus Delta's charges (fee +
 * 18% GST) on every fill since 05:30 IST. Tap it for the breakdown.
 */
export function TodayPnl({ status }: { status: TradeStatus | null }) {
  if (!status) return null;
  const booked = status.realisedTodayUsd ?? 0;
  const open = status.unrealisedPnlUsd ?? 0;
  const today = status.today ?? { realisedUsd: booked, unrealisedUsd: open, chargesUsd: 0, netUsd: booked + open };
  const tone = pnlTone(today.netUsd);

  return (
    <Popover.Root>
      <Popover.Trigger className="today-pnl" aria-label="Today's P&L">
        <span className="label">Today</span>
        <span className={cn('value', tone)}>{tone ? signedInr(usdToInr(today.netUsd)) : '₹0'}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-[min(18rem,calc(100vw-24px))] rounded-lg border border-border bg-background p-3 shadow-lg"
        >
          <p className="m-0 mb-2 text-[11px] uppercase tracking-[0.6px] text-muted-foreground">Today, since 05:30 IST</p>
          <dl className="m-0 grid gap-1.5">
            <KV label="Booked" hint="Profit or loss on trades closed today.">
              <Money value={today.realisedUsd} signed />
            </KV>
            <KV label="Open positions" hint="What open positions are up or down at Delta's price right now.">
              <Money value={today.unrealisedUsd} signed />
            </KV>
            <KV label="Charges" hint="Delta's trading fee plus 18% GST, on every fill today.">
              <Money value={-today.chargesUsd} signed />
            </KV>
            <div className="my-0.5 h-px bg-border" />
            <KV label={<span className="font-semibold text-foreground">Net</span>}>
              <Money value={today.netUsd} signed strong />
            </KV>
          </dl>
          <Popover.Arrow className="fill-[var(--line)]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
