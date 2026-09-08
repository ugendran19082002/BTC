import { AlertTriangle } from 'lucide-react';
import type { TradeStatus } from '@/types/trade';
import { clock } from '@/lib/format';

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
          className="appearance-none border-0 bg-transparent p-0 font-[inherit] text-[11.5px] text-muted-foreground hover:text-foreground"
        >
          hide
        </button>
      )}
    </div>
  );
}
