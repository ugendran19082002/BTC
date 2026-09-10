import { useState } from 'react';
import { AlertTriangle, FlaskConical, Loader2, Lock, Radio } from 'lucide-react';
import { setTradeMode } from '@/api/trade';
import type { TradeStatus } from '@/types/trade';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { KV } from '@/components/ui/kv';
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
          'flex appearance-none items-center gap-1.5 rounded-md border-0 px-2.5 py-1',
          'font-[inherit] text-[11px] font-semibold uppercase tracking-[0.7px] transition-opacity',
          'hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60',
          live ? 'mode-live' : 'mode-paper',
        )}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" />
          : live ? <Radio className="dot h-3 w-3" />
          : status.canGoLive ? <FlaskConical className="h-3 w-3" />
          : <Lock className="h-3 w-3" />}
        {live ? 'Live' : 'Paper'}
      </button>

      <Sheet open={confirming} onOpenChange={(v) => { setConfirming(v); if (!v) setRefused(null); }}>
        <SheetContent
          title="Switch to live trading?"
          description="Orders will go to Delta Exchange and use real money."
        >
          <div className="rounded-lg border border-[var(--down)]/40 bg-[var(--down)]/10 p-3">
            <p className="m-0 flex items-start gap-2 text-[13px] leading-snug text-[var(--down)]">
              <AlertTriangle className="mt-[2px] h-4 w-4 flex-none" />
              <span>
                After you confirm, every order is real. A sold option can lose more than its margin.
              </span>
            </p>
          </div>

          <dl className="m-0 mt-3 grid gap-1.5">
            <KV label="Balance">{status.balanceUsd === null ? '—' : `$${status.balanceUsd.toFixed(2)}`}</KV>
            <KV label="Open positions">{String(status.open.length)}</KV>
            <KV label="Daily loss limit">{`$${status.limits.maxDailyLossUsd.toLocaleString()}`}</KV>
            <KV label="Max leverage">{`${status.limits.maxLeverage}x`}</KV>
          </dl>

          {blocked && (
            <p className="m-0 mt-3 text-[12px] text-[var(--warn)]">{blocked}</p>
          )}
          {refused && <p className="m-0 mt-3 text-[12px] text-[var(--down)]">{refused}</p>}

          <SheetFooter>
            <Button variant="outline" className="h-11 flex-none px-4" onClick={() => setConfirming(false)}>
              Stay on paper
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
              Go live
            </button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
