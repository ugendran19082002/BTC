import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { closeAllTrades } from '@/api/trade';
import type { Trade } from '@/types/trade';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { contractLabel, price, size as fmtSize } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Square off everything.
 *
 * The button you reach for when something has gone wrong, which is exactly why
 * it does not act on the first tap. The confirmation lists every position and
 * every working order by name, because "close all" is only safe if you can see
 * what "all" is before you agree to it.
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

              <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
                {held.map((t) => (
                  <Row
                    key={t.tradeId}
                    name={contractLabel(t.symbol)}
                    what={`Sold ${fmtSize(t.position)} @ ${price(t.entryAvgPrice)}`}
                    action="buy back"
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

              <SheetFooter>
                <Button variant="outline" className="h-11 flex-none px-4" onClick={() => setOpen(false)}>
                  Keep them
                </Button>
                <button
                  onClick={() => void run()}
                  disabled={busy}
                  className={cn(
                    'flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg',
                    'appearance-none border-0 font-[inherit] text-[14px] font-semibold',
                    'bg-[var(--down)] text-white transition-opacity hover:opacity-90',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                  )}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Yes, close all
                </button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function Row({ name, what, action }: { name: string; what: string; action: string }) {
  return (
    <li className="flex items-baseline justify-between gap-3 rounded-md bg-muted px-2.5 py-1.5">
      <span className="min-w-0">
        <span className="text-[13px] font-medium text-foreground">{name}</span>
        <span className="ml-1.5 text-[11.5px] text-muted-foreground">{what}</span>
      </span>
      <span className="flex-none text-[11px] uppercase tracking-[0.5px] text-[var(--down)]">{action}</span>
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
