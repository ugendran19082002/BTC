import * as Popover from '@radix-ui/react-popover';
import type { TradeStatus } from '@/types/trade';
import { pnlTone, signedInr, usdToInr } from '@/lib/format';
import { Money } from '@/components/ui/money';
import { KV } from '@/components/ui/kv';
import { cn } from '@/lib/utils';
import { accountDayIfClosedUsd, dayIfClosedUsd } from '@/lib/close-cost';

/**
 * Today's P&L, always in the header.
 *
 * The one number people open the desk to see. It is the net if everything
 * closed now: booked trades, plus open positions bought back at the ask, minus
 * Delta's charges (fee + 18% GST) on every fill and on the fills to close
 * (5 Nov 2026, as Positions totals). Tap it for the breakdown.
 */
export function TodayPnl({ status }: { status: TradeStatus | null }) {
  if (!status) return null;
  const booked = status.realisedTodayUsd ?? 0;
  const open = status.unrealisedPnlUsd ?? 0;
  const today = status.today ?? { realisedUsd: booked, unrealisedUsd: open, chargesUsd: 0, netUsd: booked + open };
  const net = dayIfClosedUsd(today.netUsd, status.open);
  const tone = pnlTone(net);

  return (
    <Popover.Root>
      <Popover.Trigger className="today-pnl" aria-label="Today's P&L">
        <span className="label">Today</span>
        <span className={cn('value', tone)}>{tone ? signedInr(usdToInr(net)) : '₹0'}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-[min(18rem,calc(100vw-24px))] rounded-lg border border-border bg-background p-3 shadow-lg"
        >
          <p className="m-0 mb-2 text-[11px] uppercase tracking-[0.6px] text-muted-foreground">
            Today, since 05:30 IST{status.combined ? ` · all ${status.combined.accounts.length} accounts` : ''}
          </p>
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
            <KV label="At mark" hint="Booked, open and charges added: the day as Delta shows it.">
              <Money value={today.netUsd} signed />
            </KV>
            <KV label="Exit cost" hint="Buying every open position back at the ask instead of the mark, and the charges to close.">
              <Money value={net - today.netUsd} signed />
            </KV>
            <div className="my-0.5 h-px bg-border" />
            <KV label={<span className="font-semibold text-foreground">Net, if all closed now</span>}>
              <Money value={net} signed strong />
            </KV>
            {/* Each account's own net, when the figure above is several accounts' added. */}
            {status.combined && (
              <>
                <div className="my-0.5 h-px bg-border" />
                {status.combined.accounts.map((a) => (
                  <KV key={a.id} label={a.name}>
                    <Money value={accountDayIfClosedUsd(a.netTodayUsd, status.open, a.id)} signed />
                  </KV>
                ))}
              </>
            )}
          </dl>
          <Popover.Arrow className="fill-[var(--line)]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
