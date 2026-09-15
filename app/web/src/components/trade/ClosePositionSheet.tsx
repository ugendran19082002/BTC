import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ClosePreview, Trade } from '@/types/trade';
import { previewClose } from '@/api/trade';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KV } from '@/components/ui/kv';
import { SwipeToConfirm } from '@/components/ui/swipe-confirm';
import { contractLabel, inr, pnlTone, price, signedInr, signedUsd, size as fmtSize, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * "Close now", asked once more with everything on the table -- and with a size.
 *
 * Closing buys the position back at the market, pays the spread, and cannot be
 * undone -- and the button for it sat one tap away on a card that scrolls under
 * a thumb. So the tap only opens this: what is held, at what price, what it is
 * worth this second, what closing leaves after charges, and what else goes with
 * it. The figures are the card's own and refresh with every poll while it is
 * open. Closing takes a swipe.
 *
 * ## Why it asks how many
 *
 * Because "all of it" is one answer to a question that has others: taking half
 * off a position that has run, leaving a runner on, cutting size before an
 * event. Doing that on Delta's own screen meant the desk's record and the
 * exchange disagreed until the next reconcile -- the same gap that lost a fill
 * on 14 September.
 *
 * **The box opens on the whole position**, so the old behaviour is the default
 * and costs nothing: open, swipe, done. Type a smaller number, or tap Half, and
 * the swipe closes that many; the rest stays short and gets its target and stop
 * put back over it on the next poll.
 *
 * The money moves with the number, from the server's own arithmetic -- what
 * this close books, what leaving costs, and the two netted. A screen that kept
 * showing the whole position's P&L over a partial close would be wrong about
 * money, which is worse than saying nothing.
 */
export function ClosePositionSheet({ trade, open, onOpenChange, onClose }: {
  trade: Trade;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Buys it back. `lots` undefined means the whole position. Resolves when the desk has answered. */
  onClose: (lots?: number) => Promise<unknown>;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const held = Math.abs(trade.position);
  const side = trade.position < 0 ? 'Short' : 'Long';
  const live = trade.live;
  const net = live?.netIfClosedUsd ?? null;
  const added = trade.addedSize ?? 0;
  const tone = (n: number | null | undefined) =>
    pnlTone(n) === 'up' ? 'text-[var(--up)]' : pnlTone(n) === 'down' ? 'text-[var(--down)]' : 'text-foreground';

  /*
   * The size, as typed. Empty means the whole position -- not zero.
   *
   * Held as text rather than a number because a box you cannot clear is a box
   * you cannot retype, and "" has to mean something sensible while it is being
   * cleared. Here it means what the sheet opened on.
   */
  const [lotsText, setLotsText] = useState('');
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [checking, setChecking] = useState(false);

  // A fresh sheet each time: yesterday's size is not today's, and a stale
  // preview under a new number is the screen disagreeing with the book.
  useEffect(() => {
    if (!open) return;
    setLotsText(String(held));
    setPreview(null);
    setFailed(null);
    // `held` deliberately out of the deps: a fill landing while the sheet is
    // open must not overwrite a size being typed into it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const typed = lotsText.trim();
  const lots = useMemo(() => {
    if (typed === '') return held;
    const n = Number(typed);
    return Number.isFinite(n) ? n : NaN;
  }, [typed, held]);
  const valid = Number.isInteger(lots) && lots >= 1 && lots <= held;
  const closesAll = valid && lots >= held;

  // Debounced, as on the add sheet: typing a size is not a request per keystroke.
  useEffect(() => {
    if (!open || !valid) { setPreview(null); return; }
    let alive = true;
    setChecking(true);
    const id = setTimeout(() => {
      previewClose(trade.tradeId, lots)
        .then((p) => { if (alive) setPreview(p); })
        .catch(() => { if (alive) setPreview(null); })
        .finally(() => { if (alive) setChecking(false); });
    }, 200);
    return () => { alive = false; clearTimeout(id); };
  }, [open, valid, lots, trade.tradeId]);

  const problem = typed === '' || valid
    ? null
    : !Number.isFinite(lots) || !Number.isInteger(lots) || lots < 1
      ? 'A whole number of lots, at least 1.'
      : `Only ${fmtSize(held)} held.`;

  const close = async () => {
    setFailed(null);
    try {
      // Undefined for the whole position: the desk closes what is actually
      // there, which may be less than this screen last saw.
      await onClose(closesAll ? undefined : lots);
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
        description={
          closesAll
            ? `Buys back ${fmtSize(held)} at the market price.`
            : valid
              ? `Buys back ${fmtSize(lots)} of ${fmtSize(held)} at the market price. ${fmtSize(held - lots)} stays short.`
              : `Buys back up to ${fmtSize(held)} at the market price.`
        }
      >
        {/* How much of it. Everything below moves with this number. */}
        <section aria-label="how much to close" className="rounded-lg bg-muted px-3 py-2.5">
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-[11px] uppercase tracking-[0.6px] text-muted-foreground">
              Lots to close
              <Input
                aria-label="lots to close"
                inputMode="numeric"
                value={lotsText}
                placeholder={String(held)}
                onChange={(e) => setLotsText(e.target.value)}
              />
            </label>
            <div className="flex gap-1.5 pb-0.5">
              {([['Half', Math.max(1, Math.floor(held / 2))], ['All', held]] as const).map(([label, n]) => (
                <Button
                  key={label}
                  type="button"
                  variant="outline"
                  aria-pressed={valid && lots === n}
                  className={cn('h-10 px-3 text-[12px]', valid && lots === n && 'border-foreground text-foreground')}
                  onClick={() => setLotsText(String(n))}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <p className="m-0 mt-1.5 text-[11px] leading-snug text-[var(--dim)]">
            {problem
              ? <span className="text-[var(--down)]">{problem}</span>
              : closesAll
                ? 'The whole position. The target and the stop go with it.'
                : `${fmtSize(held - lots)} stays short, and its target and stop are put back over it.`}
          </p>
        </section>

        {/* The number the decision turns on, first and large. */}
        <section aria-label="if closed now" className="mt-3 rounded-lg bg-muted px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.6px] text-muted-foreground">
              {closesAll ? 'If closed now' : `Closing ${fmtSize(lots)} books`}
              <span className="inline-flex items-center gap-1 normal-case tracking-normal text-[var(--dim)]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--up)] motion-safe:animate-pulse" />
                live
              </span>
            </span>
            <span className="text-right">
              <span className={cn('block text-[22px] font-semibold tabular-nums leading-tight', tone(closesAll ? net : preview?.netUsd))}>
                {signedInr(usdToInr(closesAll ? net : preview?.netUsd ?? null))}
              </span>
              <span className="block text-[11.5px] tabular-nums text-muted-foreground">
                {signedUsd(closesAll ? net : preview?.netUsd ?? null)}
              </span>
            </span>
          </div>
          <p className="m-0 mt-1 text-[11px] leading-snug text-[var(--dim)]">
            {closesAll
              ? 'After Delta’s charges in and out, at the price now.'
              : checking
                ? 'Working it out…'
                : preview?.chargesUsd != null
                  ? `What these ${fmtSize(lots)} book after the ${inr(usdToInr(preview.chargesUsd))} it costs to buy them back`
                    + `${preview.atMark ? ', priced at the mark — no offer on the book' : ''}.`
                  : 'What these lots book, after the charges to buy them back.'}
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
          {!closesAll && valid && (
            <KV label="Left after this" hint="Still short afterwards, with the target and stop resized to cover it.">
              <b>{fmtSize(held - lots)}</b>
            </KV>
          )}
          <KV label={added > 0 ? 'Sold at (avg)' : 'Sold at'}>{price(trade.entryAvgPrice)}</KV>
          <KV label="Price now">{price(live?.markPrice)}</KV>
          {/*
            The price this actually pays.
            Closing a short is a buy, so it crosses to the ask — the mark is
            the one price nobody transacts at, and this sheet exists to put
            everything on the table before the swipe.
          */}
          {live?.ask != null && (
            <KV
              label="Buys back at"
              hint="Closing a short is a buy, so it crosses to the ask. The mark is not what this pays."
            >
              <span className="text-[var(--down)]">{price(live.ask)}</span>
              {live.bid != null && (
                <span className="text-muted-foreground"> · bid {price(live.bid)}</span>
              )}
            </KV>
          )}
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
            {trade.onBook?.target != null ? <>{price(trade.onBook.target)} <Gone all={closesAll} /></> : 'none'}
          </KV>
          <KV label="Stop on the book">
            {trade.onBook?.stop != null ? <>{price(trade.onBook.stop)} <Gone all={closesAll} /></> : 'none'}
          </KV>
          {trade.adding && (
            <KV label="Add working">
              {fmtSize(trade.adding.size)} @ {price(trade.adding.limitPrice)} <Gone all />
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
            label={`Swipe to close ${valid ? fmtSize(lots) : ''}`.trim()}
            busyLabel="Closing…"
            disabledLabel={problem ? 'Check the lots' : 'Enter lots'}
            disabled={!valid}
            onConfirm={close}
          />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Said beside anything the close takes off the book with it.
 *
 * A close of part of the position cancels them too -- a stop for the whole
 * position and a reduce-only buy for part of it are two orders closing one
 * position -- but they come straight back over what is left, and "cancelled"
 * on its own would read as "you are about to be left naked".
 */
function Gone({ all }: { all: boolean }) {
  return (
    <span className="text-[11px] text-[var(--dim)]">
      {all ? '· cancelled' : '· replaced'}
    </span>
  );
}
