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
  useEffect(() => {
    if (!open) { seededFor.current = null; return; }
    if (!trade || entry === null || entry <= 0) return;
    if (seededFor.current === trade.tradeId) return;
    seededFor.current = trade.tradeId;

    const tp = trade.plan?.takeProfitPrice ?? null;
    const sl = trade.plan?.stopPrice ?? null;
    setTargetOn(tp !== null);
    setStopOn(sl !== null);
    if (tp !== null) setTargetPct(clampPct(1 - tp / entry, 0.99));
    if (sl !== null) setStopPct(clampPct(sl / entry - 1, 3));
    setFailed(null);
  }, [open, trade, entry]);

  if (!trade) return null;

  const liveTarget = trade.plan?.takeProfitPrice ?? null;
  const liveStop = trade.protection.stopLoss ? trade.plan?.stopPrice ?? null : null;

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

        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
          The old levels come off the book before the new ones go on, so there is never a moment
          with two live.
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
