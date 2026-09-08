import { useState } from 'react';
import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { closeTrade } from '@/api/trade';
import type { Trade } from '@/types/trade';
import { Card, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { contractLabel, price, signedUsd, size as fmtSize, ago } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * What is on right now.
 *
 * The first thing each row answers is not "how much am I up" but "is there a
 * stop behind this". A position without one is drawn in red with the word
 * spelled out, because it is the only state on this screen that needs a person
 * to do something in the next minute.
 */

const PHASE_LABEL: Record<Trade['phase'], string> = {
  precheck: 'checking',
  entry_pending: 'working',
  entry_unknown: 'checking with the exchange',
  position_open: 'on, no stop yet',
  unprotected: 'NO STOP',
  protected: 'on',
  exit_pending: 'closing',
  flat: 'closed',
  aborted: 'not taken',
};

export function PositionsCard({ trades, onChanged }: { trades: Trade[]; onChanged?: () => void }) {
  if (trades.length === 0) {
    return (
      <Card>
        <CardTitle>Open positions</CardTitle>
        <p className="m-0 py-3 text-center text-[13px] text-muted-foreground">Nothing on.</p>
      </Card>
    );
  }
  return (
    <Card>
      <CardTitle right={<span className="text-[11px] text-muted-foreground">{trades.length}</span>}>
        Open positions
      </CardTitle>
      <div className="flex flex-col gap-2">
        {trades.map((t) => (
          <PositionRow key={t.tradeId} trade={t} onChanged={onChanged} />
        ))}
      </div>
    </Card>
  );
}

function PositionRow({ trade, onChanged }: { trade: Trade; onChanged?: () => void }) {
  const [closing, setClosing] = useState(false);
  const naked = trade.phase === 'unprotected' || (trade.position !== 0 && !trade.protection.stopLoss);
  const held = Math.abs(trade.position);

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-muted p-2.5',
        naked && 'border-[var(--down)] bg-[var(--down)]/10',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[14px] font-semibold text-foreground">{contractLabel(trade.symbol)}</span>
            <Badge tone={trade.optionSide === 'CE' ? 'ok' : 'warn'}>{trade.optionSide}</Badge>
          </div>
          <p className="m-0 mt-0.5 text-[11.5px] text-muted-foreground">
            short {fmtSize(held)} at {price(trade.entryAvgPrice)} · {ago(trade.updatedAt)}
          </p>
        </div>
        <div className="flex flex-none items-center gap-1">
          {naked ? (
            <ShieldAlert className="h-4 w-4 text-[var(--down)]" />
          ) : (
            <ShieldCheck className="h-4 w-4 text-[var(--up)]" />
          )}
          <span
            className={cn(
              'text-[11px] font-medium uppercase tracking-[0.4px]',
              naked ? 'text-[var(--down)]' : 'text-muted-foreground',
            )}
          >
            {PHASE_LABEL[trade.phase]}
          </span>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex gap-3 text-[11.5px] text-muted-foreground">
          <span>
            target <span className="tabular-nums text-foreground">{price(trade.plan?.takeProfitPrice)}</span>
          </span>
          <span>
            stop <span className={cn('tabular-nums', naked ? 'text-[var(--down)]' : 'text-foreground')}>
              {trade.protection.stopLoss ? price(trade.plan?.stopPrice) : 'none'}
            </span>
          </span>
          {trade.realisedPnl !== 0 && (
            <span className={cn('tabular-nums', trade.realisedPnl > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
              {signedUsd(trade.realisedPnl)}
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={closing || held === 0}
          onClick={() => {
            setClosing(true);
            void closeTrade(trade.tradeId).finally(() => { setClosing(false); onChanged?.(); });
          }}
        >
          {closing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          close now
        </Button>
      </div>

      {trade.alarm && (
        <p className="m-0 mt-2 text-[12px] font-medium text-[var(--down)]">{trade.alarm}</p>
      )}
    </div>
  );
}
