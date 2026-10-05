import { useMemo, useState } from 'react';
import { Clock, Loader2, Pencil, Plus, Search, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { cancelAdd, cancelTrade, closeTrade, reconcileTrade } from '@/api/trade';
import type { Trade } from '@/types/trade';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CloseAllButton } from '@/components/trade/CloseAllButton';
import { OriginTag } from '@/components/trade/OriginTag';
import { ActionTag } from '@/components/trade/ActionTag';
import { SignalTag } from '@/components/trade/SignalTag';
import { EditExitsSheet } from '@/components/trade/EditExitsSheet';
import { AddLotsSheet } from '@/components/trade/AddLotsSheet';
import { ClosePositionSheet } from '@/components/trade/ClosePositionSheet';
import {
  ago, contractLabel, countdown, inr, pct, pnlTone, price, signedInr, signedUsd, size as fmtSize, usdToInr,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { longLevels } from '@/lib/long-exits';
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

const tradeNetUsd = (t: Trade): number | null => {
  return t.live?.netIfClosedUsd ?? t.live?.unrealisedPnl ?? null;
};

export type PositionFilterTab = 'all' | 'win' | 'loss' | 'wait';

interface PositionTabDef {
  key: PositionFilterTab;
  label: string;
  tone?: 'up' | 'down' | 'warn';
  hint: string;
}

const POSITION_TABS: PositionTabDef[] = [
  { key: 'all', label: 'All', hint: 'All open positions and working orders' },
  { key: 'win', label: 'Win', tone: 'up', hint: 'Positions in profit after charges' },
  { key: 'loss', label: 'Loss', tone: 'down', hint: 'Positions in drawdown' },
  { key: 'wait', label: 'Wait', tone: 'warn', hint: 'Orders waiting on book or break-even' },
];

export function PositionsCard({ trades, onChanged }: { trades: Trade[]; onChanged?: () => void }) {
  const [activeTab, setActiveTab] = useState<PositionFilterTab>('all');
  const [search, setSearch] = useState('');

  const working = trades.filter(isWorking);
  const held = trades.filter((t) => t.position !== 0);

  // Tab counts for running positions
  const counts = useMemo(() => {
    let winCount = 0;
    let lossCount = 0;
    let waitCount = 0;

    for (const t of held) {
      const net = tradeNetUsd(t);
      if (net === null || net === 0) {
        waitCount++;
      } else if (net > 0) {
        winCount++;
      } else {
        lossCount++;
      }
    }

    waitCount += working.length;

    return {
      all: held.length + working.length,
      win: winCount,
      loss: lossCount,
      wait: waitCount,
    };
  }, [held, working]);

  // Filter working orders
  const filteredWorking = useMemo(() => {
    if (activeTab === 'win' || activeTab === 'loss') return [];
    if (!search.trim()) return working;
    const q = search.toLowerCase().trim();
    return working.filter((t) =>
      t.symbol.toLowerCase().includes(q) ||
      contractLabel(t.symbol).toLowerCase().includes(q) ||
      t.optionSide.toLowerCase().includes(q) ||
      (t.plan?.strategyName && t.plan.strategyName.toLowerCase().includes(q))
    );
  }, [working, activeTab, search]);

  // Filter held running open positions
  const filteredHeld = useMemo(() => {
    let list = held;
    if (activeTab === 'win') {
      list = held.filter((t) => {
        const net = tradeNetUsd(t);
        return net !== null && net > 0;
      });
    } else if (activeTab === 'loss') {
      list = held.filter((t) => {
        const net = tradeNetUsd(t);
        return net !== null && net < 0;
      });
    } else if (activeTab === 'wait') {
      list = held.filter((t) => {
        const net = tradeNetUsd(t);
        return net === null || net === 0;
      });
    }

    if (!search.trim()) return list;
    const q = search.toLowerCase().trim();
    return list.filter((t) =>
      t.symbol.toLowerCase().includes(q) ||
      contractLabel(t.symbol).toLowerCase().includes(q) ||
      t.optionSide.toLowerCase().includes(q) ||
      (t.plan?.strategyName && t.plan.strategyName.toLowerCase().includes(q)) ||
      (t.plan?.origin && t.plan.origin.toLowerCase().includes(q)) ||
      t.tradeId.toLowerCase().includes(q)
    );
  }, [held, activeTab, search]);

  // Active tab net P&L summary
  const activeTabPnl = useMemo(() => {
    if (activeTab === 'wait') return null;
    const list = activeTab === 'all'
      ? held
      : activeTab === 'win'
        ? held.filter((t) => (tradeNetUsd(t) ?? 0) > 0)
        : held.filter((t) => (tradeNetUsd(t) ?? 0) < 0);

    const totalUsd = list.reduce((acc, t) => acc + (tradeNetUsd(t) ?? 0), 0);
    return {
      usd: totalUsd,
      inr: usdToInr(totalUsd),
    };
  }, [activeTab, held]);

  if (working.length === 0 && held.length === 0) {
    return (
      <CollapsibleCard id="open-positions" title="Open positions">
        <p className="m-0 py-3 text-center text-[13px] text-muted-foreground">No open positions.</p>
      </CollapsibleCard>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Close all sits beside the count in the open-positions header; on its own only when nothing is held yet. */}
      {held.length === 0 && (
        <div className="flex justify-end">
          <CloseAllButton trades={trades} onChanged={onChanged} />
        </div>
      )}

      {filteredWorking.length > 0 && (
        <CollapsibleCard
          id="orders-waiting"
          title="Orders waiting"
          right={<span className="text-[11px] text-muted-foreground">{filteredWorking.length}</span>}
        >
          <div className="flex flex-col gap-2">
            {filteredWorking.map((t) => <WorkingRow key={t.tradeId} trade={t} onChanged={onChanged} />)}
          </div>
        </CollapsibleCard>
      )}

      {held.length > 0 && (
        <CollapsibleCard
          id="open-positions"
          title="Open positions"
          rightInline
          right={
            <span className="flex items-center gap-2.5">
              <span className="text-[11px] tabular-nums text-muted-foreground" aria-label="open positions count">{held.length}</span>
              <CloseAllButton trades={trades} onChanged={onChanged} className="h-8 px-2.5 text-[12px]" />
            </span>
          }
        >
          {/* Running open position filter tabs: ALL, WIN, LOSS, WAIT with counts and subtotal */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2.5">
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <ToggleGroup
                type="single"
                value={activeTab}
                onValueChange={(val) => {
                  if (val) setActiveTab(val as PositionFilterTab);
                }}
                className="grid w-full grid-cols-4 gap-1 sm:flex sm:w-auto sm:flex-wrap"
              >
                {POSITION_TABS.map((t) => {
                  const tabCount = counts[t.key] ?? 0;
                  const fullLabel = `${t.label} · ${tabCount}`;
                  return (
                    <ToggleGroupItem
                      key={t.key}
                      value={t.key}
                      title={t.hint}
                      aria-label={fullLabel}
                      className={cn(
                        'flex min-w-0 items-center justify-center gap-1 px-1.5 py-1 text-[12px] font-medium transition-colors sm:gap-1.5 sm:px-3',
                        t.tone === 'up' && 'hover:text-[var(--up)] data-[state=on]:bg-[var(--up)]/15 data-[state=on]:text-[var(--up)] data-[state=on]:border-[var(--up)]/30',
                        t.tone === 'down' && 'hover:text-[var(--down)] data-[state=on]:bg-[var(--down)]/15 data-[state=on]:text-[var(--down)] data-[state=on]:border-[var(--down)]/30',
                        t.tone === 'warn' && 'hover:text-[var(--warn)] data-[state=on]:bg-[var(--warn)]/15 data-[state=on]:text-[var(--warn)] data-[state=on]:border-[var(--warn)]/30',
                      )}
                    >
                      {t.tone === 'up' && <span className="h-1.5 w-1.5 flex-none rounded-full bg-[var(--up)]" />}
                      {t.tone === 'down' && <span className="h-1.5 w-1.5 flex-none rounded-full bg-[var(--down)]" />}
                      {t.tone === 'warn' && <span className="h-1.5 w-1.5 flex-none rounded-full bg-[var(--warn)]" />}
                      <span>{t.label}</span>
                      <span
                        className={cn(
                          'rounded-full px-1.5 py-0.2 text-[10.5px] font-semibold tabular-nums',
                          t.tone === 'up' ? 'bg-[var(--up)]/20 text-[var(--up)]' :
                          t.tone === 'down' ? 'bg-[var(--down)]/20 text-[var(--down)]' :
                          t.tone === 'warn' ? 'bg-[var(--warn)]/20 text-[var(--warn)]' :
                          'bg-muted-foreground/15 text-foreground/80'
                        )}
                      >
                        {tabCount}
                      </span>
                    </ToggleGroupItem>
                  );
                })}
              </ToggleGroup>

              {activeTabPnl && held.length > 1 && (
                <div
                  className={cn(
                    'text-[12px] font-medium tabular-nums ml-1',
                    activeTabPnl.usd > 0 ? 'text-[var(--up)]' : activeTabPnl.usd < 0 ? 'text-[var(--down)]' : 'text-foreground'
                  )}
                >
                  <span>
                    {activeTab === 'win' ? 'Win total: ' : activeTab === 'loss' ? 'Loss total: ' : 'Total: '}
                    {signedInr(activeTabPnl.inr)}
                  </span>
                  <span className="ml-1 opacity-75 text-[11px]">({signedUsd(activeTabPnl.usd)})</span>
                </div>
              )}

              {activeTab === 'wait' && counts.wait > 0 && held.length > 1 && (
                <div className="text-[12px] font-medium tabular-nums text-[var(--warn)] ml-1">
                  {counts.wait} waiting
                </div>
              )}
            </div>

            {held.length >= 4 && (
              <div className="relative w-full sm:w-44">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter strike, rule..."
                  className="h-9 pl-7 pr-6 text-[12px] sm:h-8 sm:text-[11.5px]"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    aria-label="Clear filter"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}
          </div>

          {filteredHeld.length > 0 ? (
            <div className="flex flex-col gap-2">
              {filteredHeld.map((t) => <PositionRow key={t.tradeId} trade={t} onChanged={onChanged} />)}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border py-5 text-center text-[12.5px] text-muted-foreground">
              {activeTab === 'loss' && 'No positions in drawdown 🎉 — all open positions are in profit or break-even.'}
              {activeTab === 'win' && 'No positions in profit yet.'}
              {activeTab === 'wait' && 'No waiting positions.'}
              {activeTab === 'all' && (search ? 'No positions match your filter.' : 'No open positions.')}
            </div>
          )}
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
      {/* What was done with the option: sold or bought. */}
      <ActionTag action={trade.plan?.action} />
      {/* Three things place orders here; which one did is the first question. */}
      <OriginTag origin={trade.plan?.origin} strategyName={trade.plan?.strategyName ?? null} strategyId={trade.plan?.strategyId ?? null} />
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
        </div>
        <span className="flex flex-none items-center gap-1 text-[var(--warn)]">
          <Clock className="h-3.5 w-3.5" />
          <span className="text-[11px] font-medium uppercase tracking-[0.4px]">{STATUS[trade.phase]}</span>
        </span>
      </div>
      <SignalTag plan={trade.plan} className="mt-1" />
      <div>
        <div>
          <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
            {at !== null
              ? <>{trade.plan?.action === 'buy' ? 'Buying' : 'Selling'} {fmtSize(lots)} lots @ {price(at)} · not filled yet</>
              : <>{trade.plan?.action === 'buy' ? 'Buying' : 'Selling'} {fmtSize(lots)} lots · not filled yet</>}
          </p>
        </div>
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
  // A bought option: no margin, so no liquidation and no leverage; its stop is judged by the desk, not resting.
  const long = trade.position > 0;
  const deskStop = long ? longLevels(trade.plan, trade.entryAvgPrice).stop : null;

  return (
    <div className={cn('rounded-lg border border-border bg-muted p-3', naked && 'border-[var(--down)] bg-[var(--down-bg)]')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <ContractName trade={trade} />
        </div>
        <ShieldStatus naked={naked} status={status} />
      </div>
      <SignalTag plan={trade.plan} className="mt-1" />
      <div>
        <div>
          <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
            {/*
              What was sold, not what is left: "Sold 222" on a trade that sold
              425 and bought 203 back at the target reads as a smaller trade.
            */}
            {trade.position > 0 ? 'Bought' : 'Sold'} {fmtSize(trade.exitSize > 0 || (trade.addedSize ?? 0) > 0 ? trade.entrySize : held)} @ {price(trade.entryAvgPrice)}
            {(trade.entrySize > 0 && (trade.addedSize ?? 0) > 0) && (
              // The average already includes the add; say how much of it was added.
              <> avg · <span className="text-foreground">{fmtSize(trade.addedSize!)} added</span></>
            )}
            {trade.exitSize > 0 && (
              <> · {fmtSize(trade.exitSize)} {trade.position > 0 ? 'sold' : 'bought back'} @ {price(trade.exitAvgPrice)} · <span className="text-foreground">{fmtSize(held)} left</span></>
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
                {/*
                  The floor at the price it starts at: the walk has nowhere to
                  go, so this rests until the window closes however many seconds
                  were set. Said here because the card is where somebody looks
                  when "it has not filled yet" is the question.
                */}
                {trade.adding.floorPrice >= trade.adding.limitPrice && (
                  <span className="block text-[11.5px] text-[var(--dim)]">
                    Resting at {price(trade.adding.limitPrice)} — it cannot walk toward the bid, because that price is also its floor.
                  </span>
                )}
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
              ? long ? 'The mark, with the book under it. Closing a bought option sells at the bid.' : 'The mark, with the book under it. Closing a short buys at the ask.'
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
            {trade.onBook?.stop != null ? price(trade.onBook.stop) : deskStop !== null ? price(deskStop) : 'none'}
          </span>
          {trade.onBook?.stop == null && deskStop !== null && <span className="text-[var(--dim)]"> · the desk watches it</span>}
          {trade.onBook?.stop != null && trade.ifExits?.stop != null && (
            <> → <span className={cn('tabular-nums', trade.ifExits.stop >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
              {trade.ifExits.stop >= 0 ? 'keep ' : 'lose '}{inr(Math.abs(usdToInr(trade.ifExits.stop) ?? 0))}
            </span></>
          )}
        </span>
        {/*
          A target or stop asked for and not resting at Delta, said with Delta's reason. It showed only "none",
          and a trade that asked for a 1.90 target looked the same as one that asked for nothing (2 Oct 2026).
        */}
        {trade.onBook && ((trade.plan?.takeProfitPrice != null && trade.onBook.target == null)
          || (trade.plan?.stopPrice != null && trade.onBook.stop == null)) && (
          <span className="basis-full text-[var(--warn)]" role="note" aria-label="exits not on the book">
            {[
              trade.plan?.takeProfitPrice != null && trade.onBook.target == null ? `Target ${price(trade.plan.takeProfitPrice)}` : null,
              trade.plan?.stopPrice != null && trade.onBook.stop == null ? `Stop ${price(trade.plan.stopPrice)}` : null,
            ].filter(Boolean).join(' and ')} asked for — not resting at Delta
            {trade.protectionProblem ? `: ${trade.protectionProblem}` : '; the desk places it again on its next check.'}
          </span>
        )}
        {!long && trade.live?.liquidationPrice != null && (
          <span title="Delta closes the position at this price, stop or no stop.">
            Liquidation <span className="tabular-nums text-[var(--warn)]">{price(trade.live.liquidationPrice)}</span>
          </span>
        )}
        {!long && trade.live?.decayed != null && (
          <span title="How much of the premium you sold has already melted away. At 100% you keep it all.">
            Premium earned{' '}
            <span className={cn('tabular-nums', pnlTone(trade.live.decayed) === 'down' ? 'text-[var(--down)]' : 'text-[var(--up)]')}>
              {pct(trade.live.decayed, 0)}
            </span>
          </span>
        )}
        {!long && trade.plan?.leverage && <span className="text-[var(--dim)]">{trade.plan.leverage}x</span>}
        {long && <span className="text-[var(--dim)]" title="Paid for in full: no margin, no liquidation.">most it can lose: what was paid</span>}
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
      <div className="mt-2.5 grid grid-cols-3 gap-1.5 sm:gap-2">
        <Button
          variant="outline"
          className="h-9 gap-1 px-1.5 text-[12.5px] sm:gap-1.5 sm:px-3 sm:text-[13px]"
          disabled={!canAdd}
          title={canAdd ? undefined : trade.adding ? 'An add is already working' : 'Nothing open to add to'}
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          Add lots
        </Button>
        <Button variant="outline" className="h-9 gap-1 px-1.5 text-[12.5px] sm:gap-1.5 sm:px-3 sm:text-[13px]" onClick={() => setEditing(true)}>
          <Pencil className="h-3.5 w-3.5" />
          Edit exits
        </Button>
        <Button
          variant="outline"
          className="h-9 px-1.5 text-[12.5px] text-[var(--down)] sm:px-3 sm:text-[13px]"
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

/** The shield and the word: protected, open, or NO STOP in red. */
function ShieldStatus({ naked, status }: { naked: boolean; status: string }) {
  return (
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
  );
}
