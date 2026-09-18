import { useState } from 'react';
import { Clock, Loader2, Pencil, Plus, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { cancelAdd, cancelTrade, closeTrade, reconcileTrade } from '@/api/trade';
import type { Trade } from '@/types/trade';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CloseAllButton } from '@/components/trade/CloseAllButton';
import { OriginTag } from '@/components/trade/OriginTag';
import { EditExitsSheet } from '@/components/trade/EditExitsSheet';
import { AddLotsSheet } from '@/components/trade/AddLotsSheet';
import { ClosePositionSheet } from '@/components/trade/ClosePositionSheet';
import {
  ago, contractLabel, countdown, inr, pct, pnlTone, price, signedInr, signedUsd, size as fmtSize, usdToInr,
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
      <CollapsibleCard id="open-positions" title="Open positions">
        <p className="m-0 py-3 text-center text-[13px] text-muted-foreground">No open positions.</p>
      </CollapsibleCard>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <CloseAllButton trades={trades} onChanged={onChanged} />
      </div>

      {working.length > 0 && (
        <CollapsibleCard
          id="orders-waiting"
          title="Orders waiting"
          right={<span className="text-[11px] text-muted-foreground">{working.length}</span>}
        >
          <div className="flex flex-col gap-2">
            {working.map((t) => <WorkingRow key={t.tradeId} trade={t} onChanged={onChanged} />)}
          </div>
        </CollapsibleCard>
      )}

      {held.length > 0 && (
        <CollapsibleCard
          id="open-positions"
          title="Open positions"
          right={<span className="text-[11px] text-muted-foreground">{held.length}</span>}
        >
          <div className="flex flex-col gap-2">
            {held.map((t) => <PositionRow key={t.tradeId} trade={t} onChanged={onChanged} />)}
          </div>
        </CollapsibleCard>
      )}
    </div>
  );
}

function ContractName({ trade }: { trade: Trade }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[14px] font-semibold text-foreground">{contractLabel(trade.symbol)}</span>
      <Badge tone={trade.optionSide === 'CE' ? 'ok' : 'warn'}>{trade.optionSide}</Badge>
      {/* Three things place orders here; which one did is the first question. */}
      <OriginTag origin={trade.plan?.origin} strategyName={trade.plan?.strategyId ?? null} />
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
  const [adding, setAdding] = useState(false);
  /** A stop in flight, so the button cannot be pressed twice into the same add. */
  const [stopping, setStopping] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const held = Math.abs(trade.position);
  // An add can only go on a short that is open and not already adding. The
  // sheet would refuse too; the button simply does not offer what the engine
  // will not take.
  const canAdd = trade.position < 0 && !trade.adding
    && (trade.phase === 'protected' || trade.phase === 'position_open' || trade.phase === 'unprotected');

  /*
   * A stop was asked for and is not there. Not the same as "no stop": a trade
   * that chose to run without one is a decision, and painting it red every time
   * turns the colour into noise -- which is how a real alarm gets ignored.
   */
  const wantedStop = trade.plan?.stopPrice != null;
  /*
   * Whether there is a stop is a question about the exchange, so it is answered
   * from the exchange.
   *
   * Reading the desk's own record instead put a green shield over 850 short
   * contracts on 12 September: Delta had cancelled the stop, the id stayed in
   * the record, and the same card said "PROTECTED" and "Stop none" an inch
   * apart. `onBook` is null only when the book could not be read -- unknown is
   * not the same as absent, and a dropped poll must not raise an alarm -- so
   * that case falls back to the record.
   */
  const stopOnBook = trade.onBook ? trade.onBook.stop != null : trade.protection.stopLoss != null;
  const naked = Boolean(trade.alarm) || (wantedStop && !stopOnBook);
  const status = naked ? STATUS.unprotected : stopOnBook ? STATUS[trade.phase] === 'NO STOP' ? 'protected' : STATUS[trade.phase] : 'open';
  const net = trade.live?.netIfClosedUsd;

  /*
   * The book under the mark, and how wide it is.
   *
   * Only when both sides are quoted: one side alone is not a spread, and
   * printing "bid 10.50 · ask —" reads as a book that is half missing rather
   * than as a quote the desk could not take.
   */
  const bid = trade.live?.bid ?? null;
  const ask = trade.live?.ask ?? null;
  const spreadPct = bid !== null && ask !== null && bid + ask > 0
    ? ((ask - bid) / ((ask + bid) / 2)) * 100
    : null;
  const book = bid !== null && ask !== null
    ? `bid ${price(bid)} · ask ${price(ask)}`
    : undefined;
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
            Sold {fmtSize(trade.exitSize > 0 || (trade.addedSize ?? 0) > 0 ? trade.entrySize : held)} @ {price(trade.entryAvgPrice)}
            {(trade.entrySize > 0 && (trade.addedSize ?? 0) > 0) && (
              // The average already includes the add; say how much of it was added.
              <> avg · <span className="text-foreground">{fmtSize(trade.addedSize!)} added</span></>
            )}
            {trade.exitSize > 0 && (
              <> · {fmtSize(trade.exitSize)} bought back @ {price(trade.exitAvgPrice)} · <span className="text-foreground">{fmtSize(held)} left</span></>
            )}
            {' · '}{ago(trade.updatedAt)}
          </p>
          {trade.adding && (
            /*
             * A working add is a sell that has not happened yet, and the two
             * things anybody wants to know about one are how long it has left
             * and how to stop it. The window is up to four hours now, so "an
             * add is working" without a clock beside it is a line that stops
             * meaning anything about ten minutes in.
             */
            <p className="m-0 mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-[var(--warn)]">
              <span>
                Adding {fmtSize(trade.adding.size)} @ {price(trade.adding.limitPrice)} (never below {price(trade.adding.floorPrice)})
                {' — '}
                {'manual' in trade.adding.source
                  ? 'added by hand'
                  : `the ${trade.adding.source.optionSide} target bought back ${fmtSize(trade.adding.source.boughtBack)}`}
                {' · '}{countdown(trade.adding.deadline)}
              </span>
              <button
                type="button"
                className="m-0 h-6 cursor-pointer appearance-none rounded-md border border-solid border-[var(--warn)]/50 bg-transparent px-2 font-[inherit] text-[11px] text-[var(--warn)] disabled:opacity-50"
                disabled={stopping}
                onClick={() => {
                  setStopping(true);
                  void cancelAdd(trade.tradeId)
                    .catch(() => {})
                    .finally(() => { setStopping(false); onChanged?.(); });
                }}
              >
                {stopping ? 'Stopping…' : 'Stop add'}
              </button>
            </p>
          )}
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
        {/*
          The mark, with the book under it.
          "Price now" on its own was the mark, which is the one price nobody
          transacts at. Closing a short is a buy, so the ask is what leaving
          actually costs — the same reason the board shows a seller the bid —
          and the gap between the two is the cost of leaving, which on a thin
          far strike is most of the decision.
        */}
        <Figure
          label="Price now"
          value={price(trade.live?.markPrice)}
          second={book}
          hint={
            book
              ? 'The mark, with the book under it. Closing a short buys at the ask.'
              : 'The exchange’s mark. No two-sided quote to read right now.'
          }
        />
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
        {spreadPct !== null && (
          <span title="What it costs to cross the book. A wide spread is paid on the way out, whatever the mark says.">
            Spread{' '}
            <span className={cn('tabular-nums', spreadPct > 10 ? 'text-[var(--warn)]' : 'text-foreground')}>
              {spreadPct.toFixed(1)}%
            </span>
          </span>
        )}
        {/*
          The exits, and what each of them is worth.
          "Target 0.80" left the arithmetic to the reader: 0.80 against an
          average of 13.00 over 1,400 contracts, less what Delta takes. The
          ticket shows this number while the bar is being dragged and stopped
          showing it the moment the order was resting, which is when it is
          worth most. Priced like "If closed now", with the target in place of
          the mark.
        */}
        <span title="The resting target, and what the trade keeps if it fills — after every charge.">
          Target{' '}
          <span className="tabular-nums text-foreground">
            {trade.onBook?.target != null ? price(trade.onBook.target) : 'none'}
          </span>
          {trade.onBook?.target != null && trade.ifExits?.target != null && (
            <> → <span className={cn('tabular-nums', trade.ifExits.target >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
              {trade.ifExits.target >= 0 ? 'keep ' : 'lose '}{inr(Math.abs(usdToInr(trade.ifExits.target) ?? 0))}
            </span></>
          )}
        </span>
        <span title="The resting stop, and what the trade is left with if it fires — after every charge.">
          Stop{' '}
          <span
            className={cn(
              'tabular-nums',
              naked ? 'text-[var(--down)]' : trade.protection.stopLoss ? 'text-foreground' : 'text-[var(--dim)]',
            )}
          >
            {trade.onBook?.stop != null ? price(trade.onBook.stop) : 'none'}
          </span>
          {trade.onBook?.stop != null && trade.ifExits?.stop != null && (
            <> → <span className={cn('tabular-nums', trade.ifExits.stop >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
              {trade.ifExits.stop >= 0 ? 'keep ' : 'lose '}{inr(Math.abs(usdToInr(trade.ifExits.stop) ?? 0))}
            </span></>
          )}
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
          /*
           * The charges, and what is left after them.
           *
           * The line used to end on a cost with no consequence: "₹63.89 paid ·
           * ₹29.77 to close" is two numbers going out and nothing coming back,
           * and the answer to the question it raises -- so what do I actually
           * keep? -- sat in a panel above it with a different label. It is the
           * same figure as "If closed now", deliberately: this is where the
           * charges are, so this is where the number that has already had them
           * taken off belongs.
           */
          <span className="tabular-nums" title="Delta's fee plus 18% GST, on the fills so far and on closing the rest at the mark.">
            Charges {inr(usdToInr(charges.paidUsd))} paid · {inr(usdToInr(charges.toCloseUsd))} to close
            {net !== null && net !== undefined && (
              <>
                {' · close now → '}
                <span className={cn(pnlTone(net) === 'down' ? 'text-[var(--down)]' : 'text-[var(--up)]')}>
                  {pnlTone(net) === 'down' ? 'lose ' : 'keep '}{inr(Math.abs(usdToInr(net) ?? 0))}
                </span>
              </>
            )}
          </span>
        )}
      </div>

      {/*
        The exchange holds more than this record sold. A reconcile read the
        position back from Delta -- an add the desk lost sight of, say -- and
        the position, the P&L and the exits all follow the exchange's number;
        the "Sold" line above can only say what the record saw. Said in words,
        because a card that quietly disagrees with the book is the bug this
        desk keeps finding.
      */}
      {held > trade.entrySize - trade.exitSize && (
        <p className="m-0 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--warn)]">
          <span>
            Delta holds {fmtSize(held)} — {fmtSize(held - (trade.entrySize - trade.exitSize))} more than
            this record sold. The position was read back from the exchange; exits cover all of it.
          </span>
          <button
            type="button"
            className="chain-chip"
            disabled={syncing}
            onClick={() => {
              setSyncing(true);
              void reconcileTrade(trade.tradeId).finally(() => { setSyncing(false); onChanged?.(); });
            }}
          >
            {syncing ? 'Reading…' : 'Re-read from Delta'}
          </button>
        </p>
      )}

      {trade.alarm && <p className="m-0 mt-2 text-[12px] font-medium text-[var(--down)]">{trade.alarm}</p>}

      {/*
        Three actions, each opening a sheet: nothing is sent from the card
        itself. Adding and editing sit together because both change the
        position; closing sits apart and in red because it ends it.
      */}
      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Button
          variant="outline"
          className="h-9"
          disabled={!canAdd}
          title={canAdd ? undefined : trade.adding ? 'An add is already working' : 'Nothing open to add to'}
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          Add lots
        </Button>
        <Button variant="outline" className="h-9" onClick={() => setEditing(true)}>
          <Pencil className="h-3.5 w-3.5" />
          Edit exits
        </Button>
        <Button
          variant="outline"
          className="col-span-2 h-9 text-[var(--down)] sm:col-span-1"
          onClick={() => setClosing(true)}
        >
          Close now
        </Button>
      </div>

      <AddLotsSheet trade={trade} open={adding} onOpenChange={setAdding} onAdded={onChanged} />
      <EditExitsSheet trade={trade} open={editing} onOpenChange={setEditing} onSaved={onChanged} />
      <ClosePositionSheet
        trade={trade}
        open={closing}
        onOpenChange={setClosing}
        onClose={(lots) => closeTrade(trade.tradeId, lots).finally(() => onChanged?.())}
      />
    </div>
  );
}
