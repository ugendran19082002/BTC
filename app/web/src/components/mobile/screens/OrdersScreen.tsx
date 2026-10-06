import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getOrders } from '@/api/phone';
import type { OrderRecord, OrderStatus } from '@/types/trade';
import { usePoll } from '@/hooks/usePoll';
import { clock, contractLabel, price, size } from '@/lib/format';
import { daysAgoIst, todayIst } from '@/lib/report';
import { usePhone } from '@/components/mobile/phone-context';
import { Chip, Chips, Empty, ListButton, Loading, Panel, Pill, When } from '@/components/mobile/parts';

/**
 * Orders (6 Oct 2026): the day's orders as the desk placed them -- what was asked, what it filled at, and where
 * each stands -- filtered by status, a day at a time. "What price did it actually fill at?" in one tap.
 */

const FILTERS: { key: OrderStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Working' },
  { key: 'completed', label: 'Filled' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'rejected', label: 'Rejected' },
];

const WORD: Record<OrderStatus, { label: string; tone: 'up' | 'down' | 'warn' | 'dim' }> = {
  completed: { label: 'FILLED', tone: 'up' },
  pending: { label: 'WORKING', tone: 'warn' },
  cancelled: { label: 'CANCELLED', tone: 'dim' },
  rejected: { label: 'REJECTED', tone: 'down' },
};

export const orderStatusWord = (o: Pick<OrderRecord, 'status'>) => <Pill tone={WORD[o.status].tone}>{WORD[o.status].label}</Pill>;

/** The day `n` back from today, IST; never in the future. */
const dayBack = (n: number, now: number) => (n <= 0 ? todayIst(now) : daysAgoIst(n, now));

export function OrdersScreen() {
  const p = usePhone();
  const [back, setBack] = useState(0);
  const [filter, setFilter] = useState<OrderStatus | 'all'>('all');
  const day = dayBack(back, p.now);
  const orders = usePoll(() => getOrders(day, day, p.accountParam), back === 0 ? 10_000 : 120_000, { deps: [day, p.accountParam] });
  const all = (orders.data?.trades ?? []).slice().sort((a, b) => b.openedAt - a.openedAt);
  const shown = filter === 'all' ? all : all.filter((o) => o.status === filter);
  const count = (k: OrderStatus | 'all') => (k === 'all' ? all.length : all.filter((o) => o.status === k).length);

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <button type="button" aria-label="The day before" onClick={() => setBack((b) => b + 1)} className="grid h-11 w-11 place-items-center rounded-md border border-border bg-transparent text-foreground">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="text-[15px] font-semibold">{back === 0 ? 'Today' : back === 1 ? 'Yesterday' : day}</span>
        <button type="button" aria-label="The day after" disabled={back === 0} onClick={() => setBack((b) => Math.max(0, b - 1))} className="grid h-11 w-11 place-items-center rounded-md border border-border bg-transparent text-foreground disabled:opacity-30">
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      <Chips label="Order status">
        {FILTERS.map((f) => (
          <Chip key={f.key} on={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}{orders.data ? ` · ${count(f.key)}` : ''}
          </Chip>
        ))}
      </Chips>

      <Panel>
        {!orders.data ? <Loading error={orders.error} what="the orders" /> : shown.length === 0 ? (
          <Empty>{all.length === 0 ? 'No orders this day.' : 'None with this status.'}</Empty>
        ) : (
          <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0" aria-label="Orders">
            {shown.map((o) => <OrderRow key={`${o.account?.id ?? ''}-${o.tradeId}`} o={o} onOpen={() => p.openTrade(o.tradeId)} showAccount={p.shown === 'all'} />)}
          </ul>
        )}
      </Panel>
    </>
  );
}

function OrderRow({ o, onOpen, showAccount }: { o: OrderRecord; onOpen: () => void; showAccount: boolean }) {
  const buy = o.plan?.action === 'buy';
  const limit = o.plan?.entry.limitPrice ?? null;
  const who = o.plan?.signal ? `#${o.plan.signal.n} ${o.plan.signal.name}` : o.plan?.strategyName ? o.plan.strategyName : 'By hand';
  return (
    <li>
      <ListButton onClick={onOpen} label={`${buy ? 'Buy' : 'Sell'} ${contractLabel(o.symbol)}: open the order`}>
        {/* What and where it stands, whole, on the first line; when, at what price and by what on the second. A time
            column, and then the time on line one, each cut the contract short at 360px. */}
        <span className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[14px] font-semibold">
            <span className={buy ? 'text-[var(--buy)]' : 'text-[var(--down)]'}>{buy ? 'BUY' : 'SELL'}</span> {contractLabel(o.symbol)} × {size(o.requestedSize)}
          </span>
          {orderStatusWord(o)}
        </span>
        <span className="flex items-baseline gap-1.5 text-[12.5px] tabular-nums text-muted-foreground">
          <When className="shrink-0 text-[12px]">{clock(o.openedAt)}</When>
          <span className="shrink-0">·
            Limit {limit !== null ? price(limit) : 'market'} · Filled {o.entryAvgPrice !== null ? <b className="text-foreground">{price(o.entryAvgPrice)}</b> : '—'}{o.entrySize > 0 && o.entrySize < o.requestedSize ? ` (${size(o.entrySize)})` : ''}
          </span>
          <span className="min-w-0 truncate text-[12px]">· {who}{showAccount && o.account ? ` · ${o.account.name}` : ''}</span>
        </span>
        {/* Two lines for an order that filled; its outcome is said only when it is not simply "filled". */}
        {o.status !== 'completed' && <span className="block truncate text-[12px] text-muted-foreground">{o.outcome}</span>}
      </ListButton>
    </li>
  );
}
