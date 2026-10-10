import { memo, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getOrders } from '@/api/phone';
import type { OrderRecord, OrderStatus } from '@/types/trade';
import { usePoll } from '@/hooks/usePoll';
import { clock, contractLabel, price, size } from '@/lib/format';
import { daysAgoIst, todayIst } from '@/lib/report';
import { usePhoneData } from '@/components/mobile/phone-context';
import { Chip, Chips, Empty, ListButton, Loading, Panel, When } from '@/components/mobile/parts';
import { PlacedLine } from '@/components/mobile/StrategyTag';
import { orderStatusWord } from '@/components/mobile/order-status';

/**
 * Orders (6 Oct 2026): the day's orders as the desk placed them -- what was asked, what it filled at, and where
 * each stands -- filtered by status, a day at a time. "What price did it actually fill at?" in one tap. Each row
 * says which strategy placed it, as a tag (`StrategyTag`): until 8 Oct 2026 a signal trade's row named the signal
 * and not the strategy.
 */

const FILTERS: { key: OrderStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Working' },
  { key: 'completed', label: 'Filled' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'rejected', label: 'Rejected' },
];

// The status word lives with Home's copy of it (order-status.tsx); said here too for whatever read it from here.
export { orderStatusWord };

/** The day `n` back from today, IST; never in the future. */
const dayBack = (n: number, now: number) => (n <= 0 ? todayIst(now) : daysAgoIst(n, now));

export function OrdersScreen() {
  const p = usePhoneData();
  const [back, setBack] = useState(0);
  const [filter, setFilter] = useState<OrderStatus | 'all'>('all');
  const [limit, setLimit] = useState(PAGE);
  const day = dayBack(back, p.now);
  useEffect(() => { setLimit(PAGE); }, [day, filter, p.accountParam]);
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
            {shown.slice(0, limit).map((o) => <OrderRow key={`${o.account?.id ?? ''}-${o.tradeId}`} o={o} openTrade={p.openTrade} showAccount={p.shown === 'all'} />)}
          </ul>
        )}
        {/* Forty at a time, the rest a tap away: a busy day's hundred-odd rows drawn at once were the screen's lag. */}
        {shown.length > limit && (
          <button
            type="button" onClick={() => setLimit((l) => l + PAGE)}
            className="m-0 mt-2 flex h-11 w-full appearance-none items-center justify-center rounded-lg border border-solid border-border bg-transparent font-[inherit] text-[13.5px] text-foreground"
          >
            Show {Math.min(PAGE, shown.length - limit)} more · {limit} of {shown.length}
          </button>
        )}
      </Panel>
    </>
  );
}

/** Rows drawn at first, and each "Show more" adds. */
const PAGE = 40;

// Memoised: an order that has not changed since the last reading (the poll keeps its object) is not drawn again.
const OrderRow = memo(function OrderRow({ o, openTrade, showAccount }: { o: OrderRecord; openTrade: (tradeId: string) => void; showAccount: boolean }) {
  const onOpen = () => openTrade(o.tradeId);
  const buy = o.plan?.action === 'buy';
  const limit = o.plan?.entry.limitPrice ?? null;
  const signal = o.plan?.signal ? `#${o.plan.signal.n} ${o.plan.signal.name} · ${o.plan.signal.tf}` : null;
  return (
    <li>
      <ListButton onClick={onOpen} label={`${buy ? 'Buy' : 'Sell'} ${contractLabel(o.symbol)}: open the order`}>
        {/* What and where it stands, whole, on the first line; when and at what price on the second; who placed it --
            the strategy's tag, the signal, the account -- on the third. A time column, and then the time on line one,
            each cut the contract short at 360px. */}
        <span className="flex items-center justify-between gap-2">
          {/* Wraps rather than cuts: beside WORKING on a 320px phone it read "SELL 79,500 PE …" (9 Oct 2026). */}
          <span className="min-w-0 text-[14px] font-semibold leading-snug">
            <span className={buy ? 'text-[var(--buy)]' : 'text-[var(--down)]'}>{buy ? 'BUY' : 'SELL'}</span> {contractLabel(o.symbol)} <span className="whitespace-nowrap">× {size(o.requestedSize)}</span>
          </span>
          {orderStatusWord(o)}
        </span>
        <span className="flex items-baseline gap-1.5 text-[12.5px] tabular-nums text-muted-foreground">
          <When className="shrink-0 text-[12px]">{clock(o.openedAt)}</When>
          <span className="min-w-0 truncate">·
            Limit {limit !== null ? price(limit) : 'market'} · Filled {o.entryAvgPrice !== null ? <b className="text-foreground">{price(o.entryAvgPrice)}</b> : '—'}{o.entrySize > 0 && o.entrySize < o.requestedSize ? ` (${size(o.entrySize)})` : ''}
          </span>
        </span>
        <PlacedLine plan={o.plan} rest={[signal, showAccount && o.account ? o.account.name : null]} className="mt-0.5" />
        {/* Two lines for an order that filled; its outcome is said only when it is not simply "filled". */}
        {/* Two lines before it is cut: a refusal's reason is the point of the line. */}
        {o.status !== 'completed' && <span className="line-clamp-2 text-[12px] leading-snug text-muted-foreground">{o.outcome}</span>}
      </ListButton>
    </li>
  );
});
