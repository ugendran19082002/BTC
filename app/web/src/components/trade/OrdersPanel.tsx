import { useState } from 'react';
import { ChevronRight, Download } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { getOrderHistory } from '@/api/trade';
import type { OrderRecord, OrderStatus } from '@/types/trade';
import { usePoll } from '@/hooks/usePoll';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { KV } from '@/components/ui/kv';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DateRangePicker, istToday } from '@/components/ui/date-range-picker';
import { downloadCsv, toCsv } from '@/lib/csv';
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

/** Why a closed trade ended, from the fill that closed it -- not from the plan. */
function exitReason(order: OrderRecord): string | null {
  if (order.status !== 'completed' || order.position !== 0) return null;
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
  const [range, setRange] = useState(() => ({ from: istToday(), to: istToday() }));
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const { from, to } = range;

  const { data, loading } = usePoll(
    () => getOrderHistory({ from, to, status: status === 'all' ? undefined : status }),
    10_000,
    { deps: [from, to, status] },
  );
  const rows = data?.trades ?? [];

  return (
    <Card>
      <CardTitle
        right={
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            aria-label="Download CSV"
            disabled={rows.length === 0}
            onClick={() => downloadCsv(`orders-${from}-to-${to}.csv`, toCsv(rows, CSV_COLUMNS))}
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </Button>
        }
      >
        Orders
      </CardTitle>

      <div className="mb-2.5">
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      <ToggleGroup
        type="single"
        value={status}
        onValueChange={(v) => v && setStatus(v as OrderStatus | 'all')}
        className="mb-2.5 flex"
      >
        <ToggleGroupItem value="all">All{rows.length ? ` · ${rows.length}` : ''}</ToggleGroupItem>
        {(['completed', 'pending', 'rejected', 'cancelled'] as const).map((s) => (
          <ToggleGroupItem key={s} value={s}>
            {STATUS_LABEL[s]}{data?.counts[s] ? ` · ${data.counts[s]}` : ''}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <RangeSummary rows={rows} />

      {rows.length === 0 ? (
        <p className="m-0 py-4 text-center text-[13px] text-muted-foreground">
          {loading ? 'Loading…'
            : from === to
              ? (from === istToday() ? 'No orders today.' : `No orders on ${from}.`)
              : `No orders from ${from} to ${to}.`}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => <OrderRow key={r.tradeId} order={r} />)}
        </div>
      )}
    </Card>
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

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-muted">
      <Collapsible.Trigger className="flex w-full appearance-none items-start gap-2 border-0 bg-transparent p-3 text-left font-[inherit]">
        <ChevronRight className={cn('mt-[3px] h-3.5 w-3.5 flex-none text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13.5px] font-semibold text-foreground">{contractLabel(order.symbol)}</span>
            <span className={cn('text-[11px] font-medium uppercase tracking-[0.5px]', STATUS_TONE[order.status])}>
              {STATUS_LABEL[order.status]}
            </span>
            {reason && <span className={cn('text-[11px] font-medium', REASON_TONE[reason])}>{reason}</span>}
          </span>
          <span className="mt-0.5 block text-[11.5px] text-muted-foreground">{order.outcome}</span>
        </span>
        <span className="flex-none text-right">
          {stillOpen ? (
            ifClosed !== null ? (
              <span
                className={cn('block text-[13px] font-semibold tabular-nums', toneClass(ifClosed))}
                title="What you keep if you close now, after Delta's charges in and out."
              >
                {signedInr(usdToInr(ifClosed))}
                <span className="ml-1 text-[10.5px] font-normal text-[var(--dim)]">if closed now</span>
              </span>
            ) : chargesOf(order) > 0 && (
              // no price yet: say what has been paid, plainly, rather than calling it a loss
              <span className="block text-[12px] tabular-nums text-muted-foreground">
                charges {inr(usdToInr(chargesOf(order)))}
              </span>
            )
          ) : net !== 0 && (
            <span className={cn('block text-[13px] font-semibold tabular-nums', toneClass(net))}>
              {signedInr(usdToInr(net))}
            </span>
          )}
          <span className="block text-[11px] text-[var(--dim)]">{stamp(order.updatedAt)}</span>
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
          <KV label="Target">{price(order.plan?.takeProfitPrice)}</KV>
          <KV label="Stop">{price(order.plan?.stopPrice)}</KV>
          <KV label="Leverage">{order.plan?.leverage ? `${order.plan.leverage}x` : '—'}</KV>
          {stillOpen ? (
            <>
              <KV label="Price now">{price(order.live?.markPrice)}</KV>
              <KV label="P&L now">{signedInr(usdToInr(order.live?.unrealisedPnl))}</KV>
              <KV label="Charges paid" hint="Delta's fee plus 18% GST on the fills so far.">
                {order.charges ? inr(usdToInr(order.charges.paidUsd)) : '—'}
              </KV>
              <KV label="Charges to close" hint="About what closing at today's price would add.">
                {order.charges ? inr(usdToInr(order.charges.toCloseUsd)) : '—'}
              </KV>
              <KV label="If closed now" hint="What you keep if you close now, after Delta's charges in and out.">
                {signedInr(usdToInr(ifClosed))}
              </KV>
            </>
          ) : (
            <>
              <KV label="Gross P&L">{signedInr(usdToInr(order.realisedPnl))}</KV>
              <KV label="Charges" hint="Delta's fee plus 18% GST on this trade's fills.">
                {order.charges ? signedInr(usdToInr(-order.charges.paidUsd)) : '—'}
              </KV>
              <KV label="Net P&L">{signedInr(usdToInr(net))}</KV>
            </>
          )}
        </dl>
        {order.note && (
          <p className="m-0 border-t border-border px-3 py-2 text-[11.5px] text-muted-foreground">{order.note}</p>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/** Contracts, said once -- and with what was asked for only when the two differ. */
function contractsLine(order: OrderRecord): string {
  const asked = order.plan?.lots ?? order.requestedSize;
  return order.entrySize === asked ? String(order.entrySize) : `${order.entrySize} of ${asked} filled`;
}

/** The download. Plain numbers, so a spreadsheet can add them up. */
const CSV_COLUMNS = [
  { header: 'trade id', value: (r: OrderRecord) => r.tradeId },
  { header: 'symbol', value: (r: OrderRecord) => r.symbol },
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
