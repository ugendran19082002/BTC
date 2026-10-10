import { memo, useEffect, useMemo, useState } from 'react';
import { getOrders } from '@/api/phone';
import type { OrderRecord } from '@/types/trade';
import { usePoll } from '@/hooks/usePoll';
import { clock, contractLabel, price, signedInr, usdToInr } from '@/lib/format';
import { daysAgoIst, todayIst } from '@/lib/report';
import { isLongTrade } from '@/lib/long-exits';
import { usePhoneData } from '@/components/mobile/phone-context';
import { Chip, Chips, Empty, ListButton, Loading, Panel, Rupees, Select, When } from '@/components/mobile/parts';
import { PlacedLine, placedBy } from '@/components/mobile/StrategyTag';

/**
 * Trade history (6 Oct 2026): the closed trades, not the orders -- what each made after charges -- filtered by
 * result, CE or PE, sold or bought and strategy, with the total of what is shown. Separate from Orders, which is
 * the order's life; this is the trade's end. Each row carries its strategy as a tag (`StrategyTag`), and the
 * strategy filter names them the way the tags do.
 */

type Days = '0' | '6' | '29';
const RANGES: { key: Days; label: string }[] = [{ key: '0', label: 'Today' }, { key: '6', label: '7 days' }, { key: '29', label: '30 days' }];
type Result = 'all' | 'win' | 'loss';
type Opt = 'all' | 'CE' | 'PE';
type Act = 'all' | 'sell' | 'buy';

const netOf = (o: OrderRecord) => o.netRealisedUsd ?? o.realisedPnl;
const closedAt = (o: OrderRecord) => Math.max(o.updatedAt, ...o.fills.filter((f) => f.role !== 'entry').map((f) => f.ts));

export function HistoryScreen() {
  const p = usePhoneData();
  const [days, setDays] = useState<Days>('0');
  const [result, setResult] = useState<Result>('all');
  const [opt, setOpt] = useState<Opt>('all');
  const [act, setAct] = useState<Act>('all');
  const [strategy, setStrategy] = useState('all');
  const to = todayIst(p.now);
  const from = days === '0' ? to : daysAgoIst(Number(days), p.now);
  const orders = usePoll(() => getOrders(from, to, p.accountParam, 'completed'), 60_000, { deps: [from, to, p.accountParam] });

  const closed = useMemo(
    () => (orders.data?.trades ?? []).filter((o) => o.position === 0 && o.exitSize > 0).sort((a, b) => closedAt(b) - closedAt(a)),
    [orders.data],
  );
  const strategies = useMemo(() => [...new Set(closed.map((o) => placedBy(o.plan).label))].sort(), [closed]);
  const shown = closed.filter((o) =>
    (result === 'all' || (result === 'win' ? netOf(o) > 0 : netOf(o) < 0))
    && (opt === 'all' || o.optionSide === opt)
    && (act === 'all' || (act === 'buy') === isLongTrade(o))
    && (strategy === 'all' || placedBy(o.plan).label === strategy));
  const total = shown.reduce((n, o) => n + netOf(o), 0);
  // Forty rows at a time (10 Oct 2026): thirty days is a thousand-odd trades, drawn at once on a phone. The count and the total above are of all.
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [from, to, result, opt, act, strategy, p.accountParam]);
  const wins = shown.filter((o) => netOf(o) > 0).length;

  return (
    <>
      <Chips label="Range">{RANGES.map((r) => <Chip key={r.key} on={days === r.key} onClick={() => setDays(r.key)}>{r.label}</Chip>)}</Chips>
      <Chips label="Filters">
        <Chip on={result === 'win'} onClick={() => setResult(result === 'win' ? 'all' : 'win')}>Won</Chip>
        <Chip on={result === 'loss'} onClick={() => setResult(result === 'loss' ? 'all' : 'loss')}>Lost</Chip>
        <Chip on={opt === 'CE'} onClick={() => setOpt(opt === 'CE' ? 'all' : 'CE')}>CE</Chip>
        <Chip on={opt === 'PE'} onClick={() => setOpt(opt === 'PE' ? 'all' : 'PE')}>PE</Chip>
        <Chip on={act === 'sell'} onClick={() => setAct(act === 'sell' ? 'all' : 'sell')}>Sold</Chip>
        <Chip on={act === 'buy'} onClick={() => setAct(act === 'buy' ? 'all' : 'buy')}>Bought</Chip>
      </Chips>
      {strategies.length > 1 && (
        <Select label="Strategy" value={strategy} onChange={setStrategy}>
          <option value="all">All strategies</option>
          {strategies.map((x) => <option key={x} value={x}>{x}</option>)}
        </Select>
      )}

      <Panel
        title={orders.data ? `${shown.length} trade${shown.length === 1 ? '' : 's'} · ${wins} won` : 'Closed trades'}
        right={orders.data && shown.length > 0 ? <Rupees usd={total} signed size="sm" /> : undefined}
      >
        {!orders.data ? <Loading error={orders.error} what="the trades" /> : shown.length === 0 ? (
          <Empty>{closed.length === 0 ? 'No trade closed in this range.' : 'None match these filters.'}</Empty>
        ) : (
          <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0" aria-label="Closed trades">
            {shown.slice(0, limit).map((o) => (
              <ClosedRow key={`${o.account?.id ?? ''}-${o.tradeId}`} o={o} openTrade={p.openTrade} showAccount={p.shown === 'all'} />
            ))}
          </ul>
        )}
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

// Memoised (10 Oct 2026): the screen redraws with the shell's clock every 5 s, and its forty rows with it, unchanged.
const ClosedRow = memo(function ClosedRow({ o, openTrade, showAccount }: { o: OrderRecord; openTrade: (tradeId: string) => void; showAccount: boolean }) {
  const net = netOf(o);
  const long = isLongTrade(o);
  return (
    <li>
      <ListButton onClick={() => openTrade(o.tradeId)} label={`${contractLabel(o.symbol)}: open the trade`}>
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-[14.5px] font-semibold">{long ? 'BUY' : 'SELL'} {contractLabel(o.symbol)}</span>
          <span className={net > 0 ? 'font-semibold text-[var(--up)]' : net < 0 ? 'font-semibold text-[var(--down)]' : 'font-semibold'}>{signedInr(usdToInr(net))}</span>
        </span>
        <span className="block text-[12.5px] tabular-nums text-muted-foreground">
          <When>{clock(closedAt(o))}</When> · in {price(o.entryAvgPrice)} → out {price(o.exitAvgPrice)}
        </span>
        <PlacedLine
          plan={o.plan} className="mt-0.5"
          rest={[o.plan?.signal ? `#${o.plan.signal.n} ${o.plan.signal.name} · ${o.plan.signal.tf}` : null, showAccount && o.account ? o.account.name : null]}
        />
      </ListButton>
    </li>
  );
});
