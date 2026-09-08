import { AlertTriangle, FlaskConical, Radio } from 'lucide-react';
import type { TradeStatus } from '@/types/trade';
import { cn } from '@/lib/utils';
import { clock } from '@/lib/format';

/**
 * Whether this screen can spend money, said once, at the top, always.
 *
 * There is no state where the answer is implied. Paper is amber and says the
 * exchange is not being touched; live is red and says it is. A desk where you
 * have to remember which mode you are in is a desk that eventually places a
 * real order it did not mean to.
 */
export function ModeBanner({ status }: { status: TradeStatus | null }) {
  if (!status) return null;
  const live = status.mode === 'live';
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.6px]',
        live
          ? 'bg-[var(--down)]/15 text-[var(--down)]'
          : 'bg-[var(--warn)]/15 text-[var(--warn)]',
      )}
      title={
        live
          ? 'Orders placed here reach the real exchange and spend real money.'
          : 'Orders are simulated. Nothing reaches the exchange. Set DELTA_LIVE_TRADING=1 to go live.'
      }
    >
      {live ? <Radio className="h-3 w-3" /> : <FlaskConical className="h-3 w-3" />}
      {live ? 'live · real money' : 'paper'}
    </div>
  );
}

/** A position with nothing behind it is the one thing that interrupts the page. */
export function AlarmBanner({ status, onDismiss }: { status: TradeStatus | null; onDismiss?: () => void }) {
  const naked = status?.open.filter((t) => t.alarm) ?? [];
  if (naked.length === 0) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--down)] bg-[var(--down)]/12 p-2.5">
      <AlertTriangle className="mt-[2px] h-4 w-4 flex-none text-[var(--down)]" />
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[13px] font-semibold text-[var(--down)]">
          {naked.length === 1 ? 'A position has no stop behind it' : `${naked.length} positions have no stop behind them`}
        </p>
        {naked.map((t) => (
          <p key={t.tradeId} className="m-0 mt-0.5 text-[11.5px] text-muted-foreground">
            {t.symbol} — {t.alarm} <span className="text-[var(--dim)]">({clock(t.updatedAt)})</span>
          </p>
        ))}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="cursor-pointer appearance-none border-0 bg-transparent p-0 font-[inherit] text-[11.5px] text-muted-foreground hover:text-foreground"
        >
          hide
        </button>
      )}
    </div>
  );
}
