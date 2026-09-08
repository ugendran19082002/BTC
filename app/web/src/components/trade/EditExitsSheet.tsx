import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { updateExits } from '@/api/trade';
import type { Trade } from '@/types/trade';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ExitBars } from '@/components/trade/ExitBars';
import { contractLabel, price } from '@/lib/format';

/**
 * Change the stop and the target on a position that is already on.
 *
 * The same bars as the ticket, on purpose: the control that set these levels
 * and the control that moves them should not be two different things to learn.
 *
 * The percentages are read back off the position rather than starting from a
 * default, so opening this shows where the levels actually are instead of
 * where a fresh ticket would have put them.
 */
/** Keeps a reverse-computed percentage inside what the bar can show. */
const clampPct = (n: number, max: number) => Math.min(max, Math.max(0, n));

export function EditExitsSheet({ trade, open, onOpenChange, onSaved }: {
  trade: Trade | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved?: () => void;
}) {
  const entry = trade?.entryAvgPrice ?? null;
  const [targetOn, setTargetOn] = useState(false);
  const [stopOn, setStopOn] = useState(false);
  const [targetPct, setTargetPct] = useState(0.8);
  const [stopPct, setStopPct] = useState(1.5);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /**
   * Seed the bars from the levels that are live, exactly once per opening.
   *
   * The trade object is replaced every second by the poll, so an effect that
   * depends on anything inside it re-runs while you are dragging and puts the
   * slider back where it started. Seeding is keyed on the opening itself, and a
   * ref makes that literal rather than a hope about dependency arrays: once the
   * form is seeded for this open, nothing reseeds it until it closes.
   */
  const seededFor = useRef<string | null>(null);

  // Closing clears the mark. As a cleanup rather than a branch, so React runs
  // it on unmount too and there is no path where the ref is left set.
  useEffect(() => {
    if (!open) return;
    return () => { seededFor.current = null; };
  }, [open]);

  useEffect(() => {
    if (!open || !trade || entry === null || entry <= 0) return;
    if (seededFor.current === trade.tradeId) return;
    seededFor.current = trade.tradeId;

    // The book first, the plan only as a fallback. The bar is a picture of the
    // levels that are live, so it has to start from the ones that are live --
    // seeding it from the plan showed −94% beside a book holding 25.10.
    const tp = trade.onBook?.target ?? trade.plan?.takeProfitPrice ?? null;
    const sl = trade.onBook?.stop ?? trade.plan?.stopPrice ?? null;
    setTargetOn(tp !== null);
    setStopOn(sl !== null);
    if (tp !== null) setTargetPct(clampPct(1 - tp / entry, 0.99));
    if (sl !== null) setStopPct(clampPct(sl / entry - 1, 3));
    setFailed(null);
  }, [open, trade, entry]);

  if (!trade) return null;

  // Read off the exchange, not off the plan. A panel headed "on the book now"
  // that reads the plan is simply wrong in the one case worth showing: when the
  // two disagree.
  const liveTarget = trade.onBook?.target ?? null;
  const liveStop = trade.onBook?.stop ?? null;
  const asked = trade.plan?.takeProfitPrice ?? null;
  const drifted = asked !== null && liveTarget !== null && Math.abs(asked - liveTarget) > 0.05;

  const save = async () => {
    setBusy(true);
    try {
      await updateExits(trade.tradeId, {
        takeProfitPct: targetOn ? targetPct : 0,
        stopLossPct: stopOn ? stopPct : 0,
      });
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={`Exits for ${contractLabel(trade.symbol)}`}
        description={`short ${Math.abs(trade.position)} at ${price(entry)}`}
      >
        <ExitBars
          entry={entry}
          size={Math.abs(trade.position)}
          contractValue={0.001}
          targetOn={targetOn}
          stopOn={stopOn}
          onTargetOn={setTargetOn}
          onStopOn={setStopOn}
          targetPct={targetPct}
          stopPct={stopPct}
          onTargetPct={setTargetPct}
          onStopPct={setStopPct}
          liquidationPrice={trade.live?.liquidationPrice ?? null}
        />

        {/*
          What is on the book right now, in the exchange's own prices. Without
          it there is no way to tell whether a change landed -- the bars show
          what you have asked for, which is not the same question.
        */}
        <dl className="m-0 mt-3 grid gap-1 rounded-lg bg-muted px-2.5 py-2 text-[12px]">
          <div className="flex justify-between gap-3">
            <dt className="m-0 text-muted-foreground">on the book now · target</dt>
            <dd className="m-0 tabular-nums text-foreground">
              {liveTarget !== null ? price(liveTarget) : 'none'}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="m-0 text-muted-foreground">on the book now · stop</dt>
            <dd className="m-0 tabular-nums text-foreground">
              {liveStop !== null ? price(liveStop) : 'none'}
            </dd>
          </div>
        </dl>

        {drifted && (
          <p className="m-0 mt-2 text-[11.5px] leading-snug text-[var(--warn)]">
            The desk asked for {price(asked)} and the book holds {price(liveTarget)}. The book is
            what will fill; moving them again will bring the two together.
          </p>
        )}
        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
          The order is moved in place rather than cancelled and replaced, so it never leaves the
          book.
        </p>
        {failed && <p className="m-0 mt-2 text-[12px] text-[var(--down)]">{failed}</p>}

        <SheetFooter>
          <Button variant="outline" className="h-11 flex-none px-4" onClick={() => onOpenChange(false)}>
            cancel
          </Button>
          <Button className="h-11 flex-1" disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            move them
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
