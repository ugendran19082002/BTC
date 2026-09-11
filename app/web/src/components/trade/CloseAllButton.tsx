import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { closeAllTrades } from '@/api/trade';
import type { Trade } from '@/types/trade';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { SwipeToConfirm } from '@/components/ui/swipe-confirm';
import { contractLabel, pnlTone, price, signedInr, signedUsd, size as fmtSize, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Square off everything.
 *
 * The button you reach for when something has gone wrong, which is exactly why
 * it does not act on the first tap. The confirmation lists every position and
 * every working order by name, because "close all" is only safe if you can see
 * what "all" is before you agree to it.
 *
 * Each position shows what it is worth right now and what closing it leaves,
 * with the total at the top, all refreshed by the same poll that draws the
 * cards -- so the decision is made on the numbers of this second. Agreeing
 * takes a swipe across the whole track, never a tap.
 *
 * It reports per trade rather than pass/fail. A partial result is the common
 * one -- a venue refuses one buy-back and takes the rest -- and hiding that
 * behind a single tick would leave a position on with nobody watching.
 */
export function CloseAllButton({ trades, onChanged }: { trades: Trade[]; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof closeAllTrades>> | null>(null);

  const held = trades.filter((t) => t.position !== 0);
  const working = trades.filter((t) => t.position === 0 && !['flat', 'aborted'].includes(t.phase));
  // Only a total of every position, or none: a sum missing one is a wrong number.
  const nets = held.map((t) => t.live?.netIfClosedUsd);
  const total = nets.length > 0 && nets.every((n) => n !== null && n !== undefined)
    ? (nets as number[]).reduce((a, b) => a + b, 0)
    : null;
  if (held.length + working.length === 0) return null;

  const run = async () => {
    setBusy(true);
    try {
      setResult(await closeAllTrades());
      onChanged?.();
    } catch (e) {
      setResult({ ok: false, cancelled: [], closed: [], failed: [{ tradeId: '—', reason: (e as Error).message }] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-9 border-[var(--down)]/50 px-3 text-[var(--down)] hover:bg-[var(--down-bg)]"
        onClick={() => { setResult(null); setOpen(true); }}
      >
        Close all
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          title="Close all positions and orders?"
          description={
            [
              held.length && `${held.length} position${held.length === 1 ? '' : 's'}`,
              working.length && `${working.length} order${working.length === 1 ? '' : 's'}`,
            ].filter(Boolean).join(' and ') || undefined
          }
        >
          {result ? (
            <Report result={result} onDone={() => setOpen(false)} />
          ) : (
            <>
              <div className="rounded-lg border border-[var(--down)]/40 bg-[var(--down-bg)] p-3">
                <p className="m-0 flex items-start gap-2 text-[13px] leading-snug text-[var(--down)]">
                  <AlertTriangle className="mt-[2px] h-4 w-4 flex-none" />
                  <span>
                    Positions are bought back at market price, so you pay the spread on each.
                    This cannot be undone.
                  </span>
                </p>
              </div>

              {held.length > 0 && (
                <section aria-label="if everything closes now" className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2.5">
                  <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.6px] text-muted-foreground">
                    If all closed now
                    <span className="inline-flex items-center gap-1 normal-case tracking-normal text-[var(--dim)]">
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--up)] motion-safe:animate-pulse" />
                      live
                    </span>
                  </span>
                  <span className="text-right">
                    <span className={cn('block text-[20px] font-semibold tabular-nums leading-tight', toneClass(total))}>
                      {signedInr(usdToInr(total))}
                    </span>
                    <span className="block text-[11px] tabular-nums text-muted-foreground">
                      {total === null ? 'waiting for every price' : `${signedUsd(total)} after charges`}
                    </span>
                  </span>
                </section>
              )}

              <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
                {held.map((t) => (
                  <Row
                    key={t.tradeId}
                    name={contractLabel(t.symbol)}
                    what={`${t.position < 0 ? 'Short' : 'Long'} ${fmtSize(t.position)} @ ${price(t.entryAvgPrice)} · now ${price(t.live?.markPrice)}`}
                    action="buy back"
                    pnl={t.live?.unrealisedPnl}
                    ifClosed={t.live?.netIfClosedUsd}
                  />
                ))}
                {working.map((t) => (
                  <Row
                    key={t.tradeId}
                    name={contractLabel(t.symbol)}
                    what={
                      t.plan?.entry.limitPrice != null
                        ? `Selling ${fmtSize(t.plan.lots)} lots @ ${price(t.plan.entry.limitPrice)}`
                        : 'Not filled yet'
                    }
                    action="cancel"
                  />
                ))}
              </ul>

              <SheetFooter className="items-center">
                <Button variant="outline" className="h-14 flex-none px-4" onClick={() => setOpen(false)}>
                  Keep them
                </Button>
                <SwipeToConfirm
                  className="min-w-0 flex-1"
                  label={`Swipe to close all ${held.length + working.length}`}
                  busyLabel="Closing…"
                  disabled={busy}
                  onConfirm={run}
                />
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

const toneClass = (n: number | null | undefined) =>
  pnlTone(n) === 'up' ? 'text-[var(--up)]' : pnlTone(n) === 'down' ? 'text-[var(--down)]' : 'text-foreground';

function Row({ name, what, action, pnl, ifClosed }: {
  name: string; what: string; action: string;
  /** Present for a position: its P&L now, and what closing it leaves after charges. */
  pnl?: number | null; ifClosed?: number | null;
}) {
  const position = pnl !== undefined || ifClosed !== undefined;
  return (
    <li className="rounded-md bg-muted px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-foreground">{name}</span>
        <span className="flex-none text-[11px] uppercase tracking-[0.5px] text-[var(--down)]">{action}</span>
      </div>
      <div className="mt-0.5 text-[11.5px] text-muted-foreground">{what}</div>
      {position && (
        <div className="mt-1 flex justify-between gap-3 text-[12px] tabular-nums">
          <span>P&amp;L <span className={toneClass(pnl)}>{signedInr(usdToInr(pnl))}</span></span>
          <span>If closed <span className={cn('font-semibold', toneClass(ifClosed))}>{signedInr(usdToInr(ifClosed))}</span></span>
        </div>
      )}
    </li>
  );
}

function Report({ result, onDone }: {
  result: Awaited<ReturnType<typeof closeAllTrades>>;
  onDone: () => void;
}) {
  const done = result.closed.length + result.cancelled.length;
  return (
    <div className="py-1">
      <div
        className={cn(
          'rounded-lg border p-3',
          result.ok ? 'border-[var(--up)]/40 bg-[var(--up)]/10' : 'border-[var(--warn)]/40 bg-[var(--warn)]/10',
        )}
      >
        <p className={cn('m-0 text-[15px] font-semibold', result.ok ? 'text-[var(--up)]' : 'text-[var(--warn)]')}>
          {result.ok ? 'All closed' : 'Some are still open'}
        </p>
        <p className="m-0 mt-1 text-[12.5px] text-muted-foreground">
          {result.closed.length > 0 && <>{result.closed.length} bought back. </>}
          {result.cancelled.length > 0 && <>{result.cancelled.length} cancelled. </>}
          {done === 0 && <>Nothing went through. </>}
        </p>
      </div>

      {result.failed.length > 0 && (
        <ul className="m-0 mt-2.5 flex list-none flex-col gap-1 p-0">
          {result.failed.map((f) => (
            <li key={f.tradeId} className="text-[12.5px] leading-snug text-[var(--down)]">
              {f.tradeId} — {f.reason}
            </li>
          ))}
        </ul>
      )}
      {!result.ok && (
        <p className="m-0 mt-2 text-[12px] text-muted-foreground">
          Close the rest manually, here or on Delta.
        </p>
      )}

      <SheetFooter>
        <Button variant="outline" className="h-11 flex-1" onClick={onDone}>Done</Button>
      </SheetFooter>
    </div>
  );
}
