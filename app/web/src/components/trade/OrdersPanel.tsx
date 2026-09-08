import { useState } from 'react';
import { ChevronRight, Download } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { getOrderHistory } from '@/api/trade';
import type { OrderRecord, OrderStatus } from '@/types/trade';
import { usePoll } from '@/hooks/usePoll';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DateRangePicker, istToday } from '@/components/ui/date-range-picker';
import { downloadCsv, toCsv } from '@/lib/csv';
import { contractLabel, price, signedInr, signedUsd, stamp, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Every order, looking backwards.
 *
 * Both ends of the date filter start on today, because that is the window
 * somebody opening this screen almost always wants and typing two dates to see
 * the day you are having is a poor greeting.
 *
 * The four statuses are the server's, not this component's, so the list, the
 * counts and the download can never disagree about what a trade was. The one
 * distinction worth the extra word is rejected against cancelled: something
 * refused the first, somebody took back the second, and only one of those is
 * worth investigating.
 */

const TONE: Record<OrderStatus, string> = {
  completed: 'text-[var(--up)]',
  pending: 'text-[var(--warn)]',
  rejected: 'text-[var(--down)]',
  cancelled: 'text-muted-foreground',
};

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
            disabled={rows.length === 0}
            onClick={() => downloadCsv(`orders-${from}-to-${to}.csv`, toCsv(rows, CSV_COLUMNS))}
          >
            <Download className="h-3 w-3" />
            download
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
        <ToggleGroupItem value="all">all{rows.length ? ` · ${rows.length}` : ''}</ToggleGroupItem>
        {(['completed', 'pending', 'rejected', 'cancelled'] as const).map((s) => (
          <ToggleGroupItem key={s} value={s}>
            {s}{data?.counts[s] ? ` · ${data.counts[s]}` : ''}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {rows.length === 0 ? (
        <p className="m-0 py-4 text-center text-[13px] text-muted-foreground">
          {loading ? 'looking…'
            : from === to
              ? `Nothing ${from === istToday() ? 'today' : `on ${from}`}.`
              : `Nothing between ${from} and ${to}.`}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => <OrderRow key={r.tradeId} order={r} />)}
        </div>
      )}
    </Card>
  );
}

function OrderRow({ order }: { order: OrderRecord }) {
  const [open, setOpen] = useState(false);
  const pnl = order.realisedPnl;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-muted">
      <Collapsible.Trigger className="flex w-full appearance-none items-start gap-2 border-0 bg-transparent p-2.5 text-left font-[inherit]">
        <ChevronRight className={cn('mt-[3px] h-3.5 w-3.5 flex-none text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13.5px] font-semibold text-foreground">{contractLabel(order.symbol)}</span>
            <span className={cn('text-[11px] font-medium uppercase tracking-[0.5px]', TONE[order.status])}>
              {order.status}
            </span>
          </span>
          <span className="mt-0.5 block text-[11.5px] text-muted-foreground">{order.outcome}</span>
        </span>
        <span className="flex-none text-right">
          {pnl !== 0 && (
            <span className={cn('block text-[13px] font-semibold tabular-nums', pnl > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
              {signedInr(usdToInr(pnl))}
            </span>
          )}
          <span className="block text-[11px] text-[var(--dim)]">{stamp(order.updatedAt)}</span>
        </span>
      </Collapsible.Trigger>

      <Collapsible.Content>
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border px-2.5 py-2 text-[11.5px] sm:grid-cols-3">
          <Field label="opened" value={stamp(order.openedAt)} />
          <Field label="last change" value={stamp(order.updatedAt)} />
          <Field label="lots asked" value={String(order.plan?.lots ?? order.requestedSize)} />
          <Field label="contracts filled" value={String(order.entrySize)} />
          <Field label="sold at" value={price(order.entryAvgPrice)} />
          <Field label="bought back at" value={price(order.exitAvgPrice)} />
          <Field label="target" value={price(order.plan?.takeProfitPrice) } />
          <Field label="stop" value={price(order.plan?.stopPrice)} />
          <Field label="leverage" value={order.plan?.leverage ? `${order.plan.leverage}x` : '—'} />
          <Field label="profit" value={`${signedInr(usdToInr(pnl))} · ${signedUsd(pnl)}`} />
        </dl>
        {order.note && (
          <p className="m-0 border-t border-border px-2.5 py-2 text-[11.5px] text-muted-foreground">
            {order.note}
          </p>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 sm:block">
      <dt className="m-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

/**
 * The download.
 *
 * Numbers go in unformatted so the sheet can add them up; the rupee column is
 * there because the account is Indian and converting a hundred rows by hand is
 * not a reasonable thing to ask.
 */
const CSV_COLUMNS = [
  { header: 'trade id', value: (r: OrderRecord) => r.tradeId },
  { header: 'symbol', value: (r: OrderRecord) => r.symbol },
  { header: 'side', value: (r: OrderRecord) => r.optionSide },
  { header: 'status', value: (r: OrderRecord) => r.status },
  { header: 'outcome', value: (r: OrderRecord) => r.outcome },
  { header: 'opened (IST)', value: (r: OrderRecord) => stamp(r.openedAt) },
  { header: 'last change (IST)', value: (r: OrderRecord) => stamp(r.updatedAt) },
  { header: 'lots asked', value: (r: OrderRecord) => r.plan?.lots ?? r.requestedSize },
  { header: 'contracts filled', value: (r: OrderRecord) => r.entrySize },
  { header: 'sold at', value: (r: OrderRecord) => r.entryAvgPrice },
  { header: 'bought back at', value: (r: OrderRecord) => r.exitAvgPrice },
  { header: 'target', value: (r: OrderRecord) => r.plan?.takeProfitPrice },
  { header: 'stop', value: (r: OrderRecord) => r.plan?.stopPrice },
  { header: 'leverage', value: (r: OrderRecord) => r.plan?.leverage },
  { header: 'profit usd', value: (r: OrderRecord) => r.realisedPnl },
  { header: 'profit inr', value: (r: OrderRecord) => usdToInr(r.realisedPnl) },
  { header: 'note', value: (r: OrderRecord) => r.note },
] as const;
