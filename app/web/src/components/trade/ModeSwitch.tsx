import { useState } from 'react';
import { AlertTriangle, FlaskConical, Loader2, Lock, Radio } from 'lucide-react';
import { setTradeMode } from '@/api/trade';
import type { TradeStatus } from '@/types/trade';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Which book the desk is trading on, and the switch between them.
 *
 * Live is the default once credentials exist, so the job of this control is not
 * to make live reachable -- it already is -- but to make it impossible to be in
 * live mode without knowing. It is always visible, it is red when it is real,
 * and going into live costs one deliberate confirmation.
 *
 * The server decides. This asks, and shows whatever comes back.
 */
export function ModeSwitch({ status, onChanged }: { status: TradeStatus | null; onChanged?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  if (!status) return null;
  const live = status.mode === 'live';
  const blocked = status.switchBlockedBy;

  const apply = async (mode: 'live' | 'paper') => {
    setBusy(true);
    setRefused(null);
    try {
      const res = await setTradeMode(mode);
      if (!res.ok) setRefused(res.reason);
      else {
        setConfirming(false);
        onChanged?.();
      }
    } catch (e) {
      setRefused((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setRefused(null);
          // Leaving live is never gated. Entering it always is.
          if (live) void apply('paper');
          else setConfirming(true);
        }}
        disabled={busy || (!live && !status.canGoLive)}
        title={
          live
            ? 'Orders placed here reach the real exchange. Tap to go back to paper.'
            : status.canGoLive
              ? 'Simulated. Tap to trade for real.'
              : 'Live trading is not available on this server.'
        }
        className={cn(
          'flex cursor-pointer appearance-none items-center gap-1.5 rounded-md border-0 px-2.5 py-1',
          'font-[inherit] text-[11px] font-semibold uppercase tracking-[0.7px] transition-opacity',
          'hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60',
          live ? 'mode-live' : 'mode-paper',
        )}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" />
          : live ? <Radio className="dot h-3 w-3" />
          : status.canGoLive ? <FlaskConical className="h-3 w-3" />
          : <Lock className="h-3 w-3" />}
        {live ? 'live · real money' : 'paper'}
      </button>

      <Sheet open={confirming} onOpenChange={(v) => { setConfirming(v); if (!v) setRefused(null); }}>
        <SheetContent
          title="Trade for real?"
          description="Orders will reach Delta Exchange and spend real margin."
        >
          <div className="rounded-lg border border-[var(--down)]/40 bg-[var(--down)]/10 p-3">
            <p className="m-0 flex items-start gap-2 text-[13px] leading-snug text-[var(--down)]">
              <AlertTriangle className="mt-[2px] h-4 w-4 flex-none" />
              <span>
                From the moment you confirm, every order this desk sends is a real one. A sold
                option can lose more than the margin behind it.
              </span>
            </p>
          </div>

          <dl className="m-0 mt-3 grid gap-1.5">
            <Row label="account balance" value={status.balanceUsd === null ? '—' : `$${status.balanceUsd.toFixed(2)}`} />
            <Row label="open positions" value={String(status.open.length)} />
            <Row label="most this desk will lose today" value={`$${status.limits.maxDailyLossUsd.toLocaleString()}`} />
            <Row label="most leverage it will use" value={`${status.limits.maxLeverage}x`} />
          </dl>

          {blocked && (
            <p className="m-0 mt-3 text-[12px] text-[var(--warn)]">{blocked}</p>
          )}
          {refused && <p className="m-0 mt-3 text-[12px] text-[var(--down)]">{refused}</p>}

          <SheetFooter>
            <Button variant="outline" className="h-11 flex-none px-4" onClick={() => setConfirming(false)}>
              stay on paper
            </Button>
            <button
              onClick={() => void apply('live')}
              disabled={busy || !!blocked}
              className={cn(
                'flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg',
                'appearance-none border-0 font-[inherit] text-[14px] font-semibold',
                'bg-[var(--down)] text-white transition-opacity hover:opacity-90',
                'disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              go live
            </button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="m-0 text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="m-0 tabular-nums text-[13px] text-foreground">{value}</dd>
    </div>
  );
}
