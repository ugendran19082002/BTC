import { useMemo, useState } from 'react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { usePersisted } from '@/hooks/usePersisted';
import { ChevronRight, Download, Search, X } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { getOrderHistory } from '@/api/trade';
import type { OrderRecord, OrderStatus } from '@/types/trade';
import { usePoll } from '@/hooks/usePoll';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { KV } from '@/components/ui/kv';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DateRangePicker, istToday } from '@/components/ui/date-range-picker';
import { downloadCsv, toCsv } from '@/lib/csv';
import { OriginTag } from '@/components/trade/OriginTag';
import { ActionTag } from '@/components/trade/ActionTag';
import { SignalTag } from '@/components/trade/SignalTag';
import {
  contractLabel, duration, inr, pnlTone, price, signedInr, signedUsd, stamp, usdToInr,
} from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Every order, looking back. Dates start on today, the window almost everyone
 * wants. Statuses come from the server, so the list, the counts and the CSV can
 * never disagree about what a trade was.
 *
 * Money here is net of Delta's charges (fee + 18% GST) wherever the server
 * sends them: what a trade really made, not what it made before the exchange
 * took its cut.
 */

const STATUS_LABEL: Record<OrderStatus, string> = {
  completed: 'Done',
  pending: 'Open',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const STATUS_TONE: Record<OrderStatus, string> = {
  completed: 'text-[var(--up)]',
  pending: 'text-[var(--warn)]',
  rejected: 'text-[var(--down)]',
  cancelled: 'text-muted-foreground',
};

/** Filter tabs for best-practice trade desk navigation. */
export type OrderFilterTab =
  | 'all'
  | 'win'
  | 'loss'
  | 'wait'
  | 'new'
  | 'open'
  | 'completed'
  | 'rejected'
  | 'cancelled';

const TABS: {
  key: OrderFilterTab;
  label: string;
  tone?: 'up' | 'down' | 'warn';
  hint: string;
}[] = [
  { key: 'all', label: 'All', hint: 'All orders in range' },
  { key: 'win', label: 'Win', tone: 'up', hint: 'Profitable closed trades' },
  { key: 'loss', label: 'Loss', tone: 'down', hint: 'Losing closed trades' },
  { key: 'wait', label: 'Wait', tone: 'warn', hint: 'Orders waiting on book or pending' },
  { key: 'open', label: 'Open', tone: 'warn', hint: 'Active positions in market' },
  { key: 'completed', label: 'Done', hint: 'All completed trades' },
  { key: 'rejected', label: 'Rejected', hint: 'Rejected orders' },
  { key: 'cancelled', label: 'Cancelled', hint: 'Cancelled orders' },
];

/** What each exit is called on the row. */
const EXIT_WORDS = {
  'perp-sl': 'perp SL hit', 'perp-tgt': 'perp TGT hit', 'option-tgt': 'target hit', 'option-sl': 'stop hit',
  'window-end': 'closed at exit time', manual: 'closed manually',
} as const;

/**
 * Why a closed trade ended.
 *
 * The server names it (`exitBy`), from the desk's own close reason first: a close the desk sends -- the perp's
 * SL or TGT, its option-stop watch, the exit time -- is a market buy-back whatever the reason, so reading only
 * the filling order called a perp SL hit "closed manually" (2 Oct 2026). An older server: the filling order.
 */
function exitReason(order: OrderRecord): string | null {
  if (order.status !== 'completed' || order.position !== 0) return null;
  if (order.exitBy) return EXIT_WORDS[order.exitBy];
  const closing = [...order.fills].reverse().find((f) => f.side === 'buy');
  switch (closing?.role) {
    case 'take_profit': return 'target hit';
    case 'stop_loss': return 'stop hit';
    case 'exit': return 'closed manually';
    default: return null;
  }
}

const REASON_TONE: Record<string, string> = {
  'target hit': 'text-[var(--up)]',
  'stop hit': 'text-[var(--down)]',
  'perp TGT hit': 'text-[var(--up)]',
  'perp SL hit': 'text-[var(--down)]',
  'closed at exit time': 'text-muted-foreground',
  'closed manually': 'text-muted-foreground',
};

const netOf = (r: OrderRecord) => r.netRealisedUsd ?? r.realisedPnl;
const chargesOf = (r: OrderRecord) => r.charges?.paidUsd ?? 0;
const toneClass = (n: number) =>
  n > 0 ? 'text-[var(--up)]' : n < 0 ? 'text-[var(--down)]' : 'text-foreground';

/**
 * The range in one block, counted from the rows on screen so it cannot disagree with them.
 *
 * Charges are the settled trades' only, so Gross − Charges is the Net beside
 * it. An open trade's entry charges belong to a result that does not exist yet.
 */
function summarise(rows: OrderRecord[]) {
  const settled = rows.filter((r) => r.status === 'completed' && r.position === 0);
  return {
    settled: settled.length,
    gross: settled.reduce((a, r) => a + r.realisedPnl, 0),
    charges: settled.reduce((a, r) => a + chargesOf(r), 0),
    net: settled.reduce((a, r) => a + netOf(r), 0),
    won: settled.filter((r) => netOf(r) > 0).length,
    lost: settled.filter((r) => netOf(r) < 0).length,
  };
}

export function OrdersPanel() {
  const [range, setRange] = usePersisted('orders:range', { from: istToday(), to: istToday() });
  const [savedStatus, setSavedStatus] = usePersisted<string>('orders:status', 'all');
  const [pageSize, setPageSize] = usePersisted<number>('orders:pageSize', 10);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const { from, to } = range;

  // Normalize status in case 'pending' was persisted by previous version
  const activeTab: OrderFilterTab = savedStatus === 'pending' ? 'open' : (savedStatus as OrderFilterTab);

  const { data, loading } = usePoll(
    () => getOrderHistory({ from, to }),
    10_000,
    { deps: [from, to] },
  );
  const rows = data?.trades ?? [];

  // Compute breakdown counts across all orders for the current range
  const counts = useMemo(() => {
    let openCount = 0;
    let winCount = 0;
    let lossCount = 0;
    let newCount = 0;
    let completedCount = 0;
    let rejectedCount = 0;
    let cancelledCount = 0;

    for (const r of rows) {
      if (r.status === 'pending') {
        if (r.position !== 0) openCount++;
        else newCount++;
      } else if (r.status === 'completed') {
        completedCount++;
        const net = netOf(r);
        if (net > 0) winCount++;
        else if (net < 0) lossCount++;
      } else if (r.status === 'rejected') {
        rejectedCount++;
      } else if (r.status === 'cancelled') {
        cancelledCount++;
      }
    }

    return {
      all: rows.length,
      win: winCount,
      loss: lossCount,
      wait: newCount,
      new: newCount,
      open: openCount,
      completed: completedCount,
      rejected: rejectedCount,
      cancelled: cancelledCount,
    };
  }, [rows]);

  // Filter rows by active tab
  const filteredByTab = useMemo(() => {
    switch (activeTab) {
      case 'open':
        // Active open positions (or all pending if position is zero and no new orders exist)
        return rows.filter((r) => r.status === 'pending' && (r.position !== 0 || counts.wait === 0));
      case 'win':
        return rows.filter((r) => r.status === 'completed' && netOf(r) > 0);
      case 'loss':
        return rows.filter((r) => r.status === 'completed' && netOf(r) < 0);
      case 'wait':
      case 'new':
        return rows.filter((r) => r.status === 'pending' && r.position === 0);
      case 'completed':
        return rows.filter((r) => r.status === 'completed');
      case 'rejected':
        return rows.filter((r) => r.status === 'rejected');
      case 'cancelled':
        return rows.filter((r) => r.status === 'cancelled');
      case 'all':
      default:
        return rows;
    }
  }, [rows, activeTab, counts.wait]);

  // Apply search query across symbol, strategy, rules, outcome, and notes
  const displayedRows = useMemo(() => {
    if (!search.trim()) return filteredByTab;
    const q = search.toLowerCase().trim();
    return filteredByTab.filter((r) => {
      const whyEnded = exitReason(r)?.toLowerCase() ?? '';
      return (
        r.symbol.toLowerCase().includes(q) ||
        contractLabel(r.symbol).toLowerCase().includes(q) ||
        (r.optionSide && r.optionSide.toLowerCase().includes(q)) ||
        (r.plan?.strategyName && r.plan.strategyName.toLowerCase().includes(q)) ||
        (r.plan?.strategyId && r.plan.strategyId.toLowerCase().includes(q)) ||
        (r.plan?.signal?.name && r.plan.signal.name.toLowerCase().includes(q)) ||
        (r.plan?.signal?.method && r.plan.signal.method.toLowerCase().includes(q)) ||
        (r.outcome && r.outcome.toLowerCase().includes(q)) ||
        (r.exitReason && r.exitReason.toLowerCase().includes(q)) ||
        whyEnded.includes(q) ||
        (r.plan?.origin && r.plan.origin.toLowerCase().includes(q)) ||
        r.tradeId.toLowerCase().includes(q) ||
        (r.note && r.note.toLowerCase().includes(q))
      );
    });
  }, [filteredByTab, search]);

  // Pagination calculation
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(displayedRows.length / pageSize)) : 1;
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = pageSize > 0 ? (currentPage - 1) * pageSize : 0;
  const endIndex = pageSize > 0 ? Math.min(startIndex + pageSize, displayedRows.length) : displayedRows.length;
  const paginatedRows = pageSize > 0 ? displayedRows.slice(startIndex, endIndex) : displayedRows;

  const handleTabChange = (val: string) => {
    if (!val) return;
    setSavedStatus(val);
    setPage(1);
  };

  const handleDateChange = (newRange: typeof range) => {
    setRange(newRange);
    setPage(1);
  };

  return (
    <CollapsibleCard
      id="orders"
      title="Orders"
      rightInline
      right={
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          aria-label="Download CSV"
          disabled={displayedRows.length === 0}
          onClick={() => downloadCsv(`orders-${from}-to-${to}.csv`, toCsv(displayedRows, CSV_COLUMNS))}
        >
          <Download className="h-3.5 w-3.5" />
          CSV
        </Button>
      }
    >
      <div className="mb-2.5">
        <DateRangePicker value={range} onChange={handleDateChange} />
      </div>

      {/* Tabs: All, Win, Loss, Wait, Open, Done, Rejected, Cancelled */}
      <ToggleGroup
        type="single"
        value={activeTab === 'new' ? 'wait' : activeTab}
        onValueChange={handleTabChange}
        // One row that scrolls sideways on a phone; wraps where there is room.
        className="chip-scroller -mx-1 mb-2.5 flex flex-nowrap gap-1 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
      >
        {TABS.map((t) => {
          const tabCount = counts[t.key] ?? 0;
          const fullLabel = `${t.label} · ${tabCount}`;
          return (
            <ToggleGroupItem
              key={t.key}
              value={t.key}
              title={t.hint}
              aria-label={fullLabel}
              className={cn(
                'flex flex-none items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium transition-colors',
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

      {/* Search and Table Page Limit Toolbar */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="relative w-full sm:w-auto sm:min-w-[200px] sm:max-w-sm sm:flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search strike, symbol, strategy, rule, ID..."
            className="h-9 pl-8 pr-7 text-[12px] sm:h-8"
          />
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setPage(1);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Page limit selector (5, 10, 15, 25, All, default 10) */}
        <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className="text-[var(--dim)]">Limit:</span>
          <div className="inline-flex rounded-md border border-border bg-muted/60 p-0.5" role="group" aria-label="Page limit">
            {[5, 10, 15, 25, 0].map((limit) => (
              <button
                key={limit}
                type="button"
                onClick={() => {
                  setPageSize(limit);
                  setPage(1);
                }}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                  (pageSize === limit || (limit === 0 && pageSize === 0))
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {limit === 0 ? 'All' : limit}
              </button>
            ))}
          </div>
        </div>
      </div>

      <RangeSummary rows={displayedRows} />

      {displayedRows.length === 0 ? (
        <div className="py-6 text-center text-[13px] text-muted-foreground">
          {loading ? (
            'Loading…'
          ) : search ? (
            <div className="flex flex-col items-center gap-1.5">
              <span>No orders matching "{search}"</span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11.5px]"
                onClick={() => {
                  setSearch('');
                  setPage(1);
                }}
              >
                Clear search
              </Button>
            </div>
          ) : from === to ? (
            from === istToday() ? 'No orders today.' : `No orders on ${from}.`
          ) : (
            `No orders from ${from} to ${to}.`
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {paginatedRows.map((r) => (
            <OrderRow key={r.tradeId} order={r} />
          ))}
        </div>
      )}

      {/* Pagination Controls */}
      {displayedRows.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-[12px] text-muted-foreground">
          <div aria-label="pagination status">
            Showing <span className="font-mono text-foreground">{displayedRows.length === 0 ? 0 : startIndex + 1}</span>–
            <span className="font-mono text-foreground">{endIndex}</span> of{' '}
            <span className="font-mono text-foreground">{displayedRows.length}</span> orders
            {displayedRows.length !== rows.length && (
              <span className="ml-1 text-[11px] text-[var(--dim)]">({rows.length} total)</span>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                disabled={currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => {
                const isNear = Math.abs(p - currentPage) <= 1;
                const isEnd = p === 1 || p === totalPages;
                if (totalPages > 7 && !isNear && !isEnd) {
                  if (p === 2 || p === totalPages - 1) {
                    return <span key={p} className="px-1 text-[11px] text-[var(--dim)]">…</span>;
                  }
                  return null;
                }
                return (
                  <Button
                    key={p}
                    size="sm"
                    variant={p === currentPage ? 'default' : 'outline'}
                    className={cn(
                      'h-7 min-w-7 px-1.5 text-[11px]',
                      p === currentPage && 'bg-[var(--accent)] font-semibold text-white',
                    )}
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </Button>
                );
              })}
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                disabled={currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      )}
    </CollapsibleCard>
  );
}

function RangeSummary({ rows }: { rows: OrderRecord[] }) {
  const { settled, gross, charges, net, won, lost } = summarise(rows);
  if (settled === 0) return null;
  const tone = pnlTone(net);

  return (
    <div aria-label="totals for the range" className="mb-3 rounded-lg border border-border bg-muted px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-[0.5px] text-muted-foreground">Net P&amp;L</span>
        <span className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'text-[17px] font-semibold tabular-nums',
              tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : 'text-foreground',
            )}
          >
            {signedInr(usdToInr(net))}
          </span>
          <span className="text-[11px] tabular-nums text-[var(--dim)]">{signedUsd(net)}</span>
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] tabular-nums text-muted-foreground">
        <span>Gross {signedInr(usdToInr(gross))}</span>
        {charges > 0 && <span title="Delta's fee plus 18% GST">Charges {signedInr(usdToInr(-charges))}</span>}
        <span>
          <span className="text-[var(--up)]">{won} won</span>
          {' · '}
          <span className="text-[var(--down)]">{lost} lost</span>
          {' · '}
          {Math.round((won / settled) * 100)}%
        </span>
        <span className="text-[var(--dim)]">{settled} of {rows.length} closed</span>
      </div>
    </div>
  );
}

function OrderRow({ order }: { order: OrderRecord }) {
  const [open, setOpen] = useState(false);
  const net = netOf(order);
  const reason = exitReason(order);
  const held = order.position === 0 ? order.updatedAt - order.openedAt : null;
  /*
   * A position still open has no result yet. Its booked P&L is zero, so "net"
   * is just minus the charges to get in -- which read as a red loss on a trade
   * that was winning. What it shows instead is what closing now would leave,
   * the Positions card's own figure.
   */
  const stillOpen = order.position !== 0;
  const ifClosed = stillOpen ? order.live?.netIfClosedUsd ?? null : null;

  // Contracts and trade amount (notional / premium)
  const contracts = order.entrySize || Math.abs(order.position);
  const contractVal = 0.001;
  const premiumUsd = order.entryAvgPrice !== null && contracts > 0
    ? order.entryAvgPrice * contracts * contractVal
    : null;
  const premiumInr = premiumUsd !== null ? usdToInr(premiumUsd) : null;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-muted">
      <Collapsible.Trigger className="grid w-full appearance-none grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 border-0 bg-transparent p-3 text-left font-[inherit]">
        <ChevronRight className={cn('mt-[3px] h-3.5 w-3.5 flex-none text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="min-w-0">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[13.5px] font-semibold text-foreground">{contractLabel(order.symbol)}</span>
            <span className={cn('text-[11px] font-medium uppercase tracking-[0.5px]', STATUS_TONE[order.status])}>
              {STATUS_LABEL[order.status]}
            </span>
            {!stillOpen && order.status === 'completed' && net !== 0 && (
              <Badge tone={net > 0 ? 'ok' : 'danger'} className="px-1.5 py-0 text-[9.5px] font-semibold tracking-wider">
                {net > 0 ? 'WIN' : 'LOSS'}
              </Badge>
            )}
            {reason && <span className={cn('text-[11px] font-medium', REASON_TONE[reason])}>{reason}</span>}
            {/* What was done with the option: sold or bought. */}
            <ActionTag action={order.plan?.action} />
            {/* Who asked for it: the ticket, a strategy, or the best-pick auto-trade. */}
            <OriginTag origin={order.plan?.origin} strategyName={order.plan?.strategyName ?? null} strategyId={order.plan?.strategyId ?? null} />
          </span>
        </span>

        {/* Row PnL & Timestamp */}
        <span className="flex-none text-right">
          {stillOpen ? (
            ifClosed !== null ? (
              <div>
                <span
                  className={cn('block text-[13px] font-semibold tabular-nums', toneClass(ifClosed))}
                  title="What you keep if you close now, after Delta's charges in and out."
                >
                  {signedInr(usdToInr(ifClosed))}
                  <span className="ml-1 text-[10.5px] font-normal text-[var(--dim)]">if closed now</span>
                </span>
                <span className="block text-[11px] tabular-nums text-[var(--dim)]">
                  {signedUsd(ifClosed)}
                </span>
              </div>
            ) : chargesOf(order) > 0 && (
              // no price yet: say what has been paid, plainly, rather than calling it a loss
              <span className="block text-[12px] tabular-nums text-muted-foreground">
                charges {inr(usdToInr(chargesOf(order)))}
              </span>
            )
          ) : (
            <div>
              {net !== 0 ? (
                <span className={cn('block text-[13px] font-semibold tabular-nums', toneClass(net))}>
                  {signedInr(usdToInr(net))}
                </span>
              ) : (
                <span className="block text-[13px] font-semibold tabular-nums text-foreground">
                  ₹0.00
                </span>
              )}
              <span className="block text-[11px] tabular-nums text-[var(--dim)]">
                {signedUsd(net)}
              </span>
            </div>
          )}
          <span className="block text-[11px] text-[var(--dim)]">{stamp(order.updatedAt)}</span>
        </span>

        {/* Under the name and the figures, the card's full width less the chevron: a phone has no room beside them. */}
        <span className="col-start-2 col-end-4 min-w-0">
          <SignalTag plan={order.plan} perpExit={order.position === 0 ? (order.perpExit ?? null) : null} className="mt-1" />

          {/* Subline with Outcome, Entry/Exit prices, and Trade Amount */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-muted-foreground">
            <span>{order.outcome}</span>
            {order.entryAvgPrice !== null && (
              <span>
                Entry <span className="font-mono text-foreground">{price(order.entryAvgPrice)}</span>
              </span>
            )}
            {order.exitAvgPrice !== null && (
              <span>
                Exit <span className="font-mono text-foreground">{price(order.exitAvgPrice)}</span>
              </span>
            )}
            {premiumInr !== null && premiumUsd !== null && premiumUsd > 0 && (
              <span title="Total premium value (size × price × contract value)">
                Amt <span className="font-mono text-foreground">{inr(premiumInr)}</span>
                <span className="ml-0.5 text-[10.5px] text-[var(--dim)]">(${premiumUsd.toFixed(2)})</span>
              </span>
            )}
          </div>

          {/* Why the desk closed it, when it was the desk's decision: "BTC perp at 84,590 reached the signal's stop 84,600". */}
          {order.exitReason && <span className="mt-0.5 block text-[11px] text-[var(--dim)]">{order.exitReason}</span>}
        </span>

      </Collapsible.Trigger>

      <Collapsible.Content>
        <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 border-t border-border px-3 py-2 sm:grid-cols-2">
          <KV label="Opened">{stamp(order.openedAt)}</KV>
          <KV label="Closed">{order.position === 0 ? stamp(order.updatedAt) : '—'}</KV>
          <KV label="Held for">{duration(held)}</KV>
          <KV label="Contracts">{contractsLine(order)}</KV>
          <KV label="Sold at">{price(order.entryAvgPrice)}</KV>
          <KV label="Bought back at">{price(order.exitAvgPrice)}</KV>
          {premiumInr !== null && premiumUsd !== null && premiumUsd > 0 && (
            <KV label="Trade amount" hint="Total premium value at entry.">
              <span>{inr(premiumInr)}</span>
              <span className="ml-1 text-[11px] text-[var(--dim)]">({signedUsd(premiumUsd)})</span>
            </KV>
          )}
          <KV label="Target">{price(order.plan?.takeProfitPrice)}</KV>
          <KV label="Stop">{price(order.plan?.stopPrice)}</KV>
          <KV label="Leverage">{order.plan?.leverage ? `${order.plan.leverage}x` : '—'}</KV>
          {stillOpen ? (
            <>
              {order.exitSize > 0 && (
                <>
                  <KV label="Bought back so far">{`${order.exitSize} of ${order.entrySize}`}</KV>
                  <KV label="Booked so far" hint="The part already bought back, before charges.">
                    <span>{signedInr(usdToInr(order.realisedPnl))}</span>
                    <span className="ml-1 text-[11px] text-[var(--dim)]">({signedUsd(order.realisedPnl)})</span>
                  </KV>
                </>
              )}
              <KV label="Price now">{price(order.live?.markPrice)}</KV>
              <KV label="P&L now">
                <span>{signedInr(usdToInr(order.live?.unrealisedPnl))}</span>
                <span className="ml-1 text-[11px] text-[var(--dim)]">({signedUsd(order.live?.unrealisedPnl)})</span>
              </KV>
              <KV label="Charges paid" hint="Delta's fee plus 18% GST on the fills so far.">
                {order.charges ? inr(usdToInr(order.charges.paidUsd)) : '—'}
              </KV>
              <KV label="Charges to close" hint="About what closing at today's price would add.">
                {order.charges ? inr(usdToInr(order.charges.toCloseUsd)) : '—'}
              </KV>
              <KV label="If closed now" hint="What you keep if you close now, after Delta's charges in and out.">
                <span>{signedInr(usdToInr(ifClosed))}</span>
                <span className="ml-1 text-[11px] text-[var(--dim)]">({signedUsd(ifClosed)})</span>
              </KV>
            </>
          ) : (
            <>
              <KV label="Gross P&L">
                <span>{signedInr(usdToInr(order.realisedPnl))}</span>
                <span className="ml-1 text-[11px] text-[var(--dim)]">({signedUsd(order.realisedPnl)})</span>
              </KV>
              <KV label="Charges" hint="Delta's fee plus 18% GST on this trade's fills.">
                {order.charges ? signedInr(usdToInr(-order.charges.paidUsd)) : '—'}
              </KV>
              <KV label="Net P&L">
                <span>{signedInr(usdToInr(net))}</span>
                <span className="ml-1 text-[11px] text-[var(--dim)]">({signedUsd(net)})</span>
              </KV>
            </>
          )}
        </dl>
        <FillLog fills={order.fills} addedSize={order.addedSize ?? 0} />
        {order.note && (
          <p className="m-0 border-t border-border px-3 py-2 text-[11.5px] text-muted-foreground">{order.note}</p>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

const FILL_LABEL: Record<string, string> = {
  entry: 'Sold',
  take_profit: 'Target',
  stop_loss: 'Stop',
  exit: 'Closed',
};

/**
 * Every piece, in order.
 *
 * One order is one row, however many pieces it traded in: a 425 target that
 * buys back 200 and then 3 is one trade with two exit fills, not two orders.
 * This is where the pieces are, so nothing about the trade is missing from it.
 */
function FillLog({ fills, addedSize = 0 }: { fills: OrderRecord['fills']; addedSize?: number }) {
  if (fills.length === 0) return null;
  const sorted = [...fills].sort((a, b) => a.ts - b.ts);
  // Sells past the entry's own size were added later, when the other leg's
  // target bought back: the same contract, appended to this trade.
  const entryTotal = sorted.filter((f) => f.role === 'entry').reduce((n, f) => n + f.size, 0);
  let sold = 0;
  const labelOf = (f: OrderRecord['fills'][number]) => {
    if (f.role !== 'entry') return FILL_LABEL[f.role] ?? f.role;
    sold += f.size;
    return sold > entryTotal - addedSize ? 'Added' : 'Sold';
  };
  return (
    <div className="border-t border-border px-3 py-2">
      <p className="m-0 mb-1 text-[10px] uppercase tracking-[0.6px] text-muted-foreground">Fills · {fills.length}</p>
      <ul aria-label="fills" className="m-0 grid list-none gap-0.5 p-0 text-[11.5px] tabular-nums">
        {sorted.map((f, i) => (
          <li key={`${f.orderId}-${f.ts}-${i}`} className="flex justify-between gap-3">
            <span className="text-muted-foreground">{stamp(f.ts)}</span>
            <span className={cn(f.side === 'buy' ? 'text-foreground' : 'text-muted-foreground')}>
              {labelOf(f)} {f.size} @ {price(f.price)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Contracts, said once -- and with what was asked for only when the two differ. */
function contractsLine(order: OrderRecord): string {
  const asked = order.plan?.lots ?? order.requestedSize;
  const added = order.addedSize ?? 0;
  // An add is more of the same contract sold later, not an over-filled entry.
  if (added > 0) return `${order.entrySize} (${order.entrySize - added} at entry + ${added} added)`;
  return order.entrySize === asked ? String(order.entrySize) : `${order.entrySize} of ${asked} filled`;
}

/** The download. Plain numbers, so a spreadsheet can add them up. */
const CSV_COLUMNS = [
  { header: 'trade id', value: (r: OrderRecord) => r.tradeId },
  { header: 'symbol', value: (r: OrderRecord) => r.symbol },
  // Who placed it, in the download as well as on the screen.
  { header: 'placed_by', value: (r: OrderRecord) => r.plan?.origin ?? 'manual' },
  { header: 'strategy', value: (r: OrderRecord) => r.plan?.strategyId ?? '' },
  { header: 'side', value: (r: OrderRecord) => r.optionSide },
  { header: 'status', value: (r: OrderRecord) => r.status },
  { header: 'outcome', value: (r: OrderRecord) => r.outcome },
  { header: 'why it ended', value: (r: OrderRecord) => exitReason(r) },
  { header: 'opened (IST)', value: (r: OrderRecord) => stamp(r.openedAt) },
  { header: 'last change (IST)', value: (r: OrderRecord) => stamp(r.updatedAt) },
  { header: 'held (seconds)', value: (r: OrderRecord) =>
      r.position === 0 ? Math.round((r.updatedAt - r.openedAt) / 1000) : null },
  { header: 'lots asked', value: (r: OrderRecord) => r.plan?.lots ?? r.requestedSize },
  { header: 'contracts filled', value: (r: OrderRecord) => r.entrySize },
  { header: 'sold at', value: (r: OrderRecord) => r.entryAvgPrice },
  { header: 'bought back at', value: (r: OrderRecord) => r.exitAvgPrice },
  { header: 'target', value: (r: OrderRecord) => r.plan?.takeProfitPrice },
  { header: 'stop', value: (r: OrderRecord) => r.plan?.stopPrice },
  { header: 'leverage', value: (r: OrderRecord) => r.plan?.leverage },
  { header: 'gross pnl usd', value: (r: OrderRecord) => r.realisedPnl },
  { header: 'charges usd (fee + gst)', value: (r: OrderRecord) => r.charges?.paidUsd ?? null },
  { header: 'net pnl usd', value: (r: OrderRecord) => netOf(r) },
  { header: 'net pnl inr', value: (r: OrderRecord) => usdToInr(netOf(r)) },
  { header: 'note', value: (r: OrderRecord) => r.note },
] as const;

