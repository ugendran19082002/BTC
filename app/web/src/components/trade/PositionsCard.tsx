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
  ago, contractLabel, pct, price, signedInr, signedUsd, size as fmtSize, usdToInr,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { Figure } from '@/components/ui/figure';

/**
 * What is on right now.
 *
 * Two lists, because they are two different things and reading them as one was
 * a bug: an order resting on the book is not a position. It was drawn in the
 * position list as "short 0 at —", which is not a sentence about anything.
 *
 * A working order has one question — is it still there, and can I pull it. A
 * position has a different one, and it is not "how much am I up": it is
 * whether there is a stop behind it. A position without one is drawn in red
 * with the words spelled out, because it is the only state on this screen that
 * needs somebody to act in the next minute.
 */

const PHASE_LABEL: Record<Trade['phase'], string> = {
  precheck: 'checking',
  entry_pending: 'on the book',
  entry_unknown: 'checking with the exchange',
  position_open: 'on, no stop yet',
  unprotected: 'NO STOP',
  protected: 'on',
  exit_pending: 'closing',
  flat: 'closed',
  aborted: 'not taken',
};

const isWorking = (t: Trade) => t.position === 0 && !['flat', 'aborted'].includes(t.phase);

export function PositionsCard({ trades, onChanged }: { trades: Trade[]; onChanged?: () => void }) {
  const working = trades.filter(isWorking);
  const held = trades.filter((t) => t.position !== 0);

  if (working.length === 0 && held.length === 0) {
    return (
      <Card>
        <CardTitle>Open positions</CardTitle>
        <p className="m-0 py-3 text-center text-[13px] text-muted-foreground">Nothing on.</p>
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
            Waiting on the book
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

/** An order that has not traded. Nothing is at risk yet, and it can be pulled. */
function WorkingRow({ trade, onChanged }: { trade: Trade; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const lots = trade.plan?.lots ?? trade.requestedSize;
  const at = trade.plan?.entry.limitPrice ?? null;

  return (
    <div className="rounded-lg border border-border bg-muted p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[14px] font-semibold text-foreground">{contractLabel(trade.symbol)}</span>
            <Badge tone={trade.optionSide === 'CE' ? 'ok' : 'warn'}>{trade.optionSide}</Badge>
          </div>
          <p className="m-0 mt-0.5 text-[11.5px] text-muted-foreground">
            {at !== null
              ? <>offering {fmtSize(lots)} at {price(at)} — nothing traded yet</>
              : <>{fmtSize(lots)} working — nothing traded yet</>}
          </p>
        </div>
        <div className="flex flex-none items-center gap-1 text-[var(--warn)]">
          <Clock className="h-3.5 w-3.5" />
          <span className="text-[11px] font-medium uppercase tracking-[0.4px]">
            {PHASE_LABEL[trade.phase]}
          </span>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-[var(--dim)]">placed {ago(trade.updatedAt)}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void cancelTrade(trade.tradeId).finally(() => { setBusy(false); onChanged?.(); });
          }}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          cancel order
        </Button>
      </div>
    </div>
  );
}

/** Green up, red down, neutral at nothing. Null is not zero. */
const pnlTone = (n: number | null | undefined): 'up' | 'down' | undefined =>
  n === null || n === undefined || n === 0 ? undefined : n > 0 ? 'up' : 'down';


function PositionRow({ trade, onChanged }: { trade: Trade; onChanged?: () => void }) {
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const held = Math.abs(trade.position);

  /**
   * A stop was asked for and is not there.
   *
   * Not the same as "there is no stop". A trade that deliberately runs without
   * one is a decision, and painting it red every time turns the colour into
   * noise -- which is exactly what makes a real alarm get ignored.
   */
  const wantedStop = trade.plan?.stopPrice != null;
  const naked = Boolean(trade.alarm) || (wantedStop && !trade.protection.stopLoss);

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-muted p-2.5',
        naked && 'border-[var(--down)] bg-[var(--down-bg)]',
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
            {naked ? PHASE_LABEL.unprotected : trade.phase === 'unprotected' ? 'on' : PHASE_LABEL[trade.phase]}
          </span>
        </div>
      </div>

      {/*
        What it is worth right now, which is the first thing anybody wants and
        was not on this card at all. The exchange's own mark and P&L, so the
        number here and the number on the Delta screen cannot disagree.
      */}
      <div className="mt-2 grid grid-cols-3 gap-2 rounded-md bg-background px-2.5 py-2">
        <Figure label="now" value={price(trade.live?.markPrice)} />
        <Figure
          label="profit"
          // Rupees lead: the account is Indian and that is the number that means
          // something. The exchange quotes in dollars, so they stay underneath
          // rather than going away.
          value={signedInr(usdToInr(trade.live?.unrealisedPnl))}
          second={signedUsd(trade.live?.unrealisedPnl)}
          tone={pnlTone(trade.live?.unrealisedPnl)}
        />
        <Figure
          label="decayed"
          value={trade.live?.decayed != null ? pct(trade.live.decayed, 0) : '—'}
          tone={pnlTone(trade.live?.decayed)}
          hint="How much of the credit you took in has melted away. At 100% the option is worthless and the whole premium is yours."
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
          <span>
            target{' '}
            <span className="tabular-nums text-foreground">
              {trade.onBook?.target != null ? price(trade.onBook.target) : 'none'}
            </span>
          </span>
          <span>
            stop{' '}
            <span
              className={cn(
                'tabular-nums',
                naked ? 'text-[var(--down)]' : trade.protection.stopLoss ? 'text-foreground' : 'text-[var(--dim)]',
              )}
            >
              {trade.onBook?.stop != null ? price(trade.onBook.stop) : 'none'}
            </span>
          </span>
          {/* With no stop this is the real exit, so it is named rather than implied. */}
          {trade.live?.liquidationPrice != null && (
            <span title="Where the exchange buys the position back whether you want it to or not.">
              closed out at{' '}
              <span className="tabular-nums text-[var(--warn)]">{price(trade.live.liquidationPrice)}</span>
            </span>
          )}
          {trade.plan?.leverage && <span className="text-[var(--dim)]">{trade.plan.leverage}x</span>}
          {trade.realisedPnl !== 0 && (
            <span className={cn('tabular-nums', trade.realisedPnl > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
              booked {signedUsd(trade.realisedPnl)}
            </span>
          )}
        </div>
        <div className="flex flex-none gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil className="h-3 w-3" />
            exits
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={closing}
            onClick={() => {
              setClosing(true);
              void closeTrade(trade.tradeId).finally(() => { setClosing(false); onChanged?.(); });
            }}
          >
            {closing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            close now
          </Button>
        </div>
      </div>

      {trade.alarm && (
        <p className="m-0 mt-2 text-[12px] font-medium text-[var(--down)]">{trade.alarm}</p>
      )}

      <EditExitsSheet
        trade={trade}
        open={editing}
        onOpenChange={setEditing}
        onSaved={onChanged}
      />
    </div>
  );
}
