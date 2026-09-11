import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Trade } from '@/types/trade';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { KV } from '@/components/ui/kv';
import { SwipeToConfirm } from '@/components/ui/swipe-confirm';
import { contractLabel, inr, pnlTone, price, signedInr, signedUsd, size as fmtSize, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * "Close now", asked once more with everything on the table.
 *
 * Closing buys the position back at the market, pays the spread, and cannot be
 * undone -- and the button for it sat one tap away on a card that scrolls under
 * a thumb. So the tap only opens this: what is held, at what price, what it is
 * worth this second, what closing leaves after charges, and what else goes with
 * it. The figures are the card's own and refresh with every poll while it is
 * open. Closing takes a swipe.
 */
export function ClosePositionSheet({ trade, open, onOpenChange, onClose }: {
  trade: Trade;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Buys it back. Resolves when the desk has answered. */
  onClose: () => Promise<unknown>;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const held = Math.abs(trade.position);
  const side = trade.position < 0 ? 'Short' : 'Long';
  const live = trade.live;
  const net = live?.netIfClosedUsd ?? null;
  const added = trade.addedSize ?? 0;
  const tone = (n: number | null | undefined) =>
    pnlTone(n) === 'up' ? 'text-[var(--up)]' : pnlTone(n) === 'down' ? 'text-[var(--down)]' : 'text-foreground';

  const close = async () => {
    setFailed(null);
    try {
      await onClose();
      onOpenChange(false);
    } catch (e) {
      setFailed((e as Error).message);
      throw e;
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { setFailed(null); onOpenChange(v); }}>
      <SheetContent
        title={`Close ${contractLabel(trade.symbol)}?`}
        description={`Buys back ${fmtSize(held)} at the market price.`}
      >
        {/* The number the decision turns on, first and large. */}
        <section aria-label="if closed now" className="rounded-lg bg-muted px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.6px] text-muted-foreground">
              If closed now
              <span className="inline-flex items-center gap-1 normal-case tracking-normal text-[var(--dim)]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--up)] motion-safe:animate-pulse" />
                live
              </span>
            </span>
            <span className="text-right">
              <span className={cn('block text-[22px] font-semibold tabular-nums leading-tight', tone(net))}>
                {signedInr(usdToInr(net))}
              </span>
              <span className="block text-[11.5px] tabular-nums text-muted-foreground">{signedUsd(net)}</span>
            </span>
          </div>
          <p className="m-0 mt-1 text-[11px] leading-snug text-[var(--dim)]">
            After Delta’s charges in and out, at the price now.
          </p>
        </section>

        <dl aria-label="position details" className="m-0 mt-3 grid gap-1.5">
          <KV label="Position">
            {side} <b>{fmtSize(held)}</b>
            {(trade.exitSize > 0 || added > 0) && (
              <span className="block text-[11px] text-muted-foreground">
                {fmtSize(trade.entrySize)} sold{added > 0 ? ` (${fmtSize(added)} added)` : ''}
                {trade.exitSize > 0 ? ` · ${fmtSize(trade.exitSize)} bought back` : ''}
              </span>
            )}
          </KV>
          <KV label={added > 0 ? 'Sold at (avg)' : 'Sold at'}>{price(trade.entryAvgPrice)}</KV>
          <KV label="Price now">{price(live?.markPrice)}</KV>
          <KV label={trade.exitSize > 0 ? 'Open P&L' : 'P&L'}>
            <span className={tone(live?.unrealisedPnl)}>{signedInr(usdToInr(live?.unrealisedPnl))}</span>
          </KV>
          {trade.realisedPnl !== 0 && (
            <KV label="Booked so far">
              <span className={tone(trade.realisedPnl)}>{signedInr(usdToInr(trade.realisedPnl))}</span>
            </KV>
          )}
          {trade.charges && (
            <KV label="Charges" hint="Delta's fee plus 18% GST.">
              {inr(usdToInr(trade.charges.paidUsd))} paid · {inr(usdToInr(trade.charges.toCloseUsd))} to close
            </KV>
          )}
          <KV label="Target on the book">
            {trade.onBook?.target != null ? <>{price(trade.onBook.target)} <Gone /></> : 'none'}
          </KV>
          <KV label="Stop on the book">
            {trade.onBook?.stop != null ? <>{price(trade.onBook.stop)} <Gone /></> : 'none'}
          </KV>
          {trade.adding && (
            <KV label="Add working">
              {fmtSize(trade.adding.size)} @ {price(trade.adding.limitPrice)} <Gone />
            </KV>
          )}
        </dl>

        <div className="mt-3 rounded-lg border border-[var(--down)]/40 bg-[var(--down-bg)] p-2.5">
          <p className="m-0 flex items-start gap-2 text-[12px] leading-snug text-[var(--down)]">
            <AlertTriangle className="mt-[1px] h-3.5 w-3.5 flex-none" />
            <span>Bought back at the market price, so you pay the spread. This cannot be undone.</span>
          </p>
        </div>
        {failed && <p role="alert" className="m-0 mt-2 text-[12px] leading-snug text-[var(--down)]">{failed}</p>}

        <SheetFooter className="items-center">
          <Button variant="outline" className="h-14 flex-none px-4" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <SwipeToConfirm
            className="min-w-0 flex-1"
            label={`Swipe to close ${fmtSize(held)}`}
            busyLabel="Closing…"
            onConfirm={close}
          />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Said beside anything the close takes off the book with it. */
function Gone() {
  return <span className="text-[11px] text-[var(--dim)]">· cancelled</span>;
}
