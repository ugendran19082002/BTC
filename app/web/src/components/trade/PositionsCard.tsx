import { useState } from 'react';
import { Clock, Loader2, Pencil, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { cancelTrade, closeTrade } from '@/api/trade';
import type { Trade } from '@/types/trade';
import { Card, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CloseAllButton } from '@/components/trade/CloseAllButton';
import { EditExitsSheet } from '@/components/trade/EditExitsSheet';
import {
  ago, contractLabel, inr, pct, pnlTone, price, signedInr, signedUsd, size as fmtSize, usdToInr,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { Figure } from '@/components/ui/figure';

/**
 * What is on right now.
 *
 * Two lists, because they are two different things: an order waiting on the
 * book is not a position. A position's first question is not "how much am I
 * up" but "is there a stop behind it" -- one without is drawn in red with the
 * words spelled out, because it is the only thing here that needs acting on now.
 */

const STATUS: Record<Trade['phase'], string> = {
  precheck: 'checking',
  entry_pending: 'waiting',
  entry_unknown: 'checking',
  position_open: 'no stop yet',
  unprotected: 'NO STOP',
  protected: 'protected',
  exit_pending: 'closing',
  flat: 'closed',
  aborted: 'not filled',
};

const isWorking = (t: Trade) => t.position === 0 && !['flat', 'aborted'].includes(t.phase);

export function PositionsCard({ trades, onChanged }: { trades: Trade[]; onChanged?: () => void }) {
  const working = trades.filter(isWorking);
  const held = trades.filter((t) => t.position !== 0);

  if (working.length === 0 && held.length === 0) {
    return (
      <Card>
        <CardTitle>Open positions</CardTitle>
        <p className="m-0 py-3 text-center text-[13px] text-muted-foreground">No open positions.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <CloseAllButton trades={trades} onChanged={onChanged} />
      </div>

      {working.length > 0 && (
        <Card>
          <CardTitle right={<span className="text-[11px] text-muted-foreground">{working.length}</span>}>
            Orders waiting
          </CardTitle>
          <div className="flex flex-col gap-2">
            {working.map((t) => <WorkingRow key={t.tradeId} trade={t} onChanged={onChanged} />)}
          </div>
        </Card>
      )}

      {held.length > 0 && (
        <Card>
          <CardTitle right={<span className="text-[11px] text-muted-foreground">{held.length}</span>}>
            Open positions
          </CardTitle>
          <div className="flex flex-col gap-2">
            {held.map((t) => <PositionRow key={t.tradeId} trade={t} onChanged={onChanged} />)}
          </div>
        </Card>
      )}
    </div>
  );
}

function ContractName({ trade }: { trade: Trade }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[14px] font-semibold text-foreground">{contractLabel(trade.symbol)}</span>
      <Badge tone={trade.optionSide === 'CE' ? 'ok' : 'warn'}>{trade.optionSide}</Badge>
    </div>
  );
}

/** An order that has not filled. Nothing is at risk yet, and it can be pulled. */
function WorkingRow({ trade, onChanged }: { trade: Trade; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const lots = trade.plan?.lots ?? trade.requestedSize;
  const at = trade.plan?.entry.limitPrice ?? null;

  return (
    <div className="rounded-lg border border-border bg-muted p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <ContractName trade={trade} />
          <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
            {at !== null
              ? <>Selling {fmtSize(lots)} lots @ {price(at)} · not filled yet</>
              : <>Selling {fmtSize(lots)} lots · not filled yet</>}
          </p>
        </div>
        <span className="flex flex-none items-center gap-1 text-[var(--warn)]">
          <Clock className="h-3.5 w-3.5" />
          <span className="text-[11px] font-medium uppercase tracking-[0.4px]">{STATUS[trade.phase]}</span>
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-[var(--dim)]">Placed {ago(trade.updatedAt)}</span>
        <Button
          size="sm"
          variant="outline"
          className="h-9 px-3"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void cancelTrade(trade.tradeId).finally(() => { setBusy(false); onChanged?.(); });
          }}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          Cancel order
        </Button>
      </div>
    </div>
  );
}

function PositionRow({ trade, onChanged }: { trade: Trade; onChanged?: () => void }) {
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const held = Math.abs(trade.position);

  /*
   * A stop was asked for and is not there. Not the same as "no stop": a trade
   * that chose to run without one is a decision, and painting it red every time
   * turns the colour into noise -- which is how a real alarm gets ignored.
   */
  const wantedStop = trade.plan?.stopPrice != null;
  const naked = Boolean(trade.alarm) || (wantedStop && !trade.protection.stopLoss);
  const status = naked ? STATUS.unprotected : trade.protection.stopLoss ? STATUS[trade.phase] === 'NO STOP' ? 'protected' : STATUS[trade.phase] : 'open';
  const net = trade.live?.netIfClosedUsd;
  const charges = trade.charges;

  return (
    <div className={cn('rounded-lg border border-border bg-muted p-3', naked && 'border-[var(--down)] bg-[var(--down-bg)]')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <ContractName trade={trade} />
          <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
            {/*
              What was sold, not what is left: "Sold 222" on a trade that sold
              425 and bought 203 back at the target reads as a smaller trade.
            */}
            Sold {fmtSize(trade.exitSize > 0 ? trade.entrySize : held)} @ {price(trade.entryAvgPrice)}
            {trade.exitSize > 0 && (
              <> · {fmtSize(trade.exitSize)} bought back @ {price(trade.exitAvgPrice)} · <span className="text-foreground">{fmtSize(held)} left</span></>
            )}
            {' · '}{ago(trade.updatedAt)}
          </p>
        </div>
        <span className="flex flex-none items-center gap-1">
          {naked
            ? <ShieldAlert className="h-4 w-4 text-[var(--down)]" />
            : <ShieldCheck className="h-4 w-4 text-[var(--up)]" />}
          <span
            className={cn(
              'text-[11px] font-medium uppercase tracking-[0.4px]',
              naked ? 'text-[var(--down)]' : 'text-muted-foreground',
            )}
          >
            {status}
          </span>
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 rounded-md bg-background px-2.5 py-2">
        <Figure label="Price now" value={price(trade.live?.markPrice)} />
        <Figure
          // Once part is bought back this is the open part only; "Booked" below
          // is the rest, and If closed now is the two together after charges.
          label={trade.exitSize > 0 ? 'Open P&L' : 'P&L'}
          value={signedInr(usdToInr(trade.live?.unrealisedPnl))}
          second={signedUsd(trade.live?.unrealisedPnl)}
          tone={pnlTone(trade.live?.unrealisedPnl)}
        />
        <Figure
          label="If closed now"
          value={signedInr(usdToInr(net))}
          second={signedUsd(net)}
          tone={pnlTone(net)}
          hint="What you keep if you close now, after Delta's charges (fee + 18% GST) in and out."
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        <span>
          Target{' '}
          <span className="tabular-nums text-foreground">
            {trade.onBook?.target != null ? price(trade.onBook.target) : 'none'}
          </span>
        </span>
        <span>
          Stop{' '}
          <span
            className={cn(
              'tabular-nums',
              naked ? 'text-[var(--down)]' : trade.protection.stopLoss ? 'text-foreground' : 'text-[var(--dim)]',
            )}
          >
            {trade.onBook?.stop != null ? price(trade.onBook.stop) : 'none'}
          </span>
        </span>
        {trade.live?.liquidationPrice != null && (
          <span title="Delta closes the position at this price, stop or no stop.">
            Liquidation <span className="tabular-nums text-[var(--warn)]">{price(trade.live.liquidationPrice)}</span>
          </span>
        )}
        {trade.live?.decayed != null && (
          <span title="How much of the premium you sold has already melted away. At 100% you keep it all.">
            Premium earned{' '}
            <span className={cn('tabular-nums', pnlTone(trade.live.decayed) === 'down' ? 'text-[var(--down)]' : 'text-[var(--up)]')}>
              {pct(trade.live.decayed, 0)}
            </span>
          </span>
        )}
        {trade.plan?.leverage && <span className="text-[var(--dim)]">{trade.plan.leverage}x</span>}
        {trade.realisedPnl !== 0 && (
          <span className={cn('tabular-nums', trade.realisedPnl > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
            Booked {signedInr(usdToInr(trade.realisedPnl))}
          </span>
        )}
        {charges && charges.paidUsd > 0 && (
          <span className="tabular-nums" title="Delta's fee plus 18% GST.">
            Charges {inr(usdToInr(charges.paidUsd))} paid · {inr(usdToInr(charges.toCloseUsd))} to close
          </span>
        )}
      </div>

      {trade.alarm && <p className="m-0 mt-2 text-[12px] font-medium text-[var(--down)]">{trade.alarm}</p>}

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <Button variant="outline" className="h-9" onClick={() => setEditing(true)}>
          <Pencil className="h-3.5 w-3.5" />
          Edit exits
        </Button>
        <Button
          variant="outline"
          className="h-9"
          disabled={closing}
          onClick={() => {
            setClosing(true);
            void closeTrade(trade.tradeId).finally(() => { setClosing(false); onChanged?.(); });
          }}
        >
          {closing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Close now
        </Button>
      </div>

      <EditExitsSheet trade={trade} open={editing} onOpenChange={setEditing} onSaved={onChanged} />
    </div>
  );
}
