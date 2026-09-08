import { useEffect, useState } from 'react';
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

  // Where the levels are now, turned back into the percentages the bars speak.
  useEffect(() => {
    if (!open || !trade || entry === null || entry <= 0) return;
    const tp = trade.plan?.takeProfitPrice ?? null;
    const sl = trade.plan?.stopPrice ?? null;
    setTargetOn(tp !== null);
    setStopOn(sl !== null && trade.protection.stopLoss !== null);
    if (tp !== null) setTargetPct(Math.min(0.99, Math.max(0, 1 - tp / entry)));
    if (sl !== null) setStopPct(Math.max(0, sl / entry - 1));
    setFailed(null);
  }, [open, trade?.tradeId, entry]);

  if (!trade) return null;

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

        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
          The levels on the book are replaced: the old ones come off first, so there is never a
          moment with two live.
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
