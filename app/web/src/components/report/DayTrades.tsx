import { useEffect, useMemo, useState } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Loading } from '@/components/mobile/parts';
import { count, netClass } from '@/components/report/backtest-parts';
import { dayLabel, moneyText, ptsText, timeIst } from '@/lib/market-report';
import { pct } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BtDayTrades, BtExit, BtTradeRow } from '@/types/signal-backtest';

/**
 * One expiry day of a backtest, trade by trade (owner, 14 Oct 2026: "tap the count -- each trade's entry, exit, SL,
 * TGT, points and money, user friendly"). Opened from a day's trade count; read when opened, as the backtest worked
 * that day out. Each trade a card: what was sold on which signal, in and out with the times, why it closed, the
 * perp's levels and the option's own, the points and the money. Narrowed by result or by exit, sorted by time or
 * by money, fifty at a time.
 */

const EXIT_WORDS: Record<BtExit, string> = {
  'perp-tgt': 'Perp TGT', 'perp-sl': 'Perp SL', 'option-tgt': 'Option TGT', 'option-sl': 'Option SL', 'window-end': 'Window end',
};
const PAGE = 50;
const opt = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : v.toFixed(v < 10 ? 2 : 1).replace(/0$/, ''));
const perp = (v: number) => Math.round(v).toLocaleString('en-US');

type Only = 'all' | 'won' | 'lost' | BtExit;
type Order = 'time' | 'best' | 'worst';

export function DayTradesSheet({ day, read, onClose }: {
  /** The expiry day open, or null: closed. */
  day: string | null;
  read: (day: string) => Promise<BtDayTrades>;
  onClose: () => void;
}) {
  const [got, setGot] = useState<{ day: string; data: BtDayTrades | null; error: Error | null } | null>(null);
  const [only, setOnly] = useState<Only>('all');
  const [order, setOrder] = useState<Order>('time');
  const [shown, setShown] = useState(PAGE);
  useEffect(() => {
    if (!day) return;
    let live = true;
    setGot({ day, data: null, error: null }); setOnly('all'); setOrder('time'); setShown(PAGE);
    read(day).then((data) => { if (live) setGot({ day, data, error: null }); }, (error: Error) => { if (live) setGot({ day, data: null, error }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  const data = got?.day === day ? got.data : null;
  const trades = data?.trades ?? [];
  const exits = useMemo(() => (Object.keys(EXIT_WORDS) as BtExit[]).map((k) => ({ k, n: trades.filter((t) => t.by === k).length })).filter((x) => x.n > 0), [trades]);
  const list = useMemo(() => {
    const xs = trades.filter((t) => only === 'all' || (only === 'won' ? t.netUsd > 0 : only === 'lost' ? t.netUsd <= 0 : t.by === only));
    return order === 'time' ? xs : [...xs].sort((a, b) => (order === 'best' ? b.netUsd - a.netUsd : a.netUsd - b.netUsd));
  }, [trades, only, order]);
  const net = trades.reduce((a, t) => a + t.netUsd, 0);
  const won = trades.filter((t) => t.netUsd > 0).length;
  const chip = (on: boolean) => cn('m-0 h-9 shrink-0 appearance-none whitespace-nowrap rounded-full border border-solid px-3 font-[inherit] text-[13px] font-medium',
    on ? 'border-[var(--chosen-line)] bg-[var(--chosen-soft)] text-[var(--chosen)]' : 'border-border bg-transparent text-foreground');

  return (
    <Sheet open={day !== null} onOpenChange={(v) => { if (!v) onClose(); }}>
      {day && (
        <SheetContent className="sm:w-[min(960px,94vw)] sm:max-h-[88vh]" title={`${dayLabel(day)} · trade by trade`}
          description={data ? `${count(data.total)} trades · ${pct(data.total ? won / data.total : null, 0)} won · ${moneyText(net)} after charges` : undefined}>
          {!data ? <Loading error={got?.error ?? null} what="the day's trades (the day is played again: a moment)" /> : (
            <div className="grid min-w-0 gap-2">
              <div role="group" aria-label="Show" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
                <button type="button" aria-pressed={only === 'all'} className={chip(only === 'all')} onClick={() => { setOnly('all'); setShown(PAGE); }}>All {count(trades.length)}</button>
                <button type="button" aria-pressed={only === 'won'} className={chip(only === 'won')} onClick={() => { setOnly('won'); setShown(PAGE); }}>Won {count(won)}</button>
                <button type="button" aria-pressed={only === 'lost'} className={chip(only === 'lost')} onClick={() => { setOnly('lost'); setShown(PAGE); }}>Lost {count(trades.length - won)}</button>
                {exits.map((x) => (
                  <button key={x.k} type="button" aria-pressed={only === x.k} className={chip(only === x.k)} onClick={() => { setOnly(x.k); setShown(PAGE); }}>{EXIT_WORDS[x.k]} {count(x.n)}</button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                Order
                <select aria-label="Order the trades" value={order} onChange={(e) => setOrder(e.target.value as Order)}
                  className="h-9 rounded-md border border-solid border-border bg-background px-2 font-[inherit] text-[13px] text-foreground">
                  <option value="time">By time</option>
                  <option value="best">Most made first</option>
                  <option value="worst">Most lost first</option>
                </select>
              </label>
              {data.total > trades.length && (
                <p className="m-0 text-[12px] text-[var(--warn)]">The first {count(trades.length)} of {count(data.total)} trades, by time: narrow the backtest by time frame or method to see the rest.</p>
              )}
              {list.length === 0 ? <p className="m-0 py-2 text-[13px] text-muted-foreground">No trade of this kind on the day.</p> : (
                <ul aria-label="Trades" className="m-0 grid list-none gap-2 p-0 lg:grid-cols-2">
                  {list.slice(0, shown).map((t, i) => <TradeCard key={`${t.at}-${t.method}-${t.member ?? ''}-${i}`} t={t} />)}
                </ul>
              )}
              {list.length > shown && (
                <button type="button" onClick={() => setShown((n) => n + PAGE)}
                  className="m-0 min-h-[44px] w-full appearance-none rounded-md border border-solid border-border bg-transparent font-[inherit] text-[13.5px] font-medium text-foreground">
                  Show {count(Math.min(PAGE, list.length - shown))} more of {count(list.length - shown)}
                </button>
              )}
            </div>
          )}
        </SheetContent>
      )}
    </Sheet>
  );
}

/** One trade: the signal and the option, in and out, why it closed, its levels, and what it came to. */
export function TradeCard({ t }: { t: BtTradeRow }) {
  const side = t.dir === 1 ? 'BUY' : 'SELL';
  const leg = `${t.cp === 'P' ? 'PE' : 'CE'} ${t.strike.toLocaleString('en-US')}`;
  const row = 'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5';
  return (
    <li aria-label={`${timeIst(t.at)} ${t.name} ${side}: ${moneyText(t.netUsd)}`} className="grid min-w-0 gap-1.5 rounded-lg border border-solid border-[var(--line-soft)] p-3">
      <div className={row}>
        <span className="min-w-0 text-[13.5px] font-semibold [overflow-wrap:anywhere]">
          <span className="tabular-nums text-[var(--time)]">{timeIst(t.at)}</span> · {t.name}
        </span>
        <span className={cn('text-[16px] font-semibold tabular-nums', netClass(t.netUsd))}>{moneyText(t.netUsd)}</span>
      </div>
      <p className="m-0 text-[12.5px] text-muted-foreground">
        {t.member ? <>{t.member} · </> : null}{t.tf === 'chain' ? 'TF chain' : t.tf} · <span className={t.dir === 1 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{side}</span> · sold {leg} × {count(t.lots)}
      </p>
      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px] sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Entry</dt><dd className="m-0 tabular-nums">{opt(t.entry)} <span className="text-muted-foreground">at {timeIst(t.entryAt)}</span></dd></div>
        <div><dt className="text-muted-foreground">Exit</dt><dd className="m-0 tabular-nums">{opt(t.exit)} <span className="text-muted-foreground">at {timeIst(t.exitAt)}</span></dd></div>
        <div><dt className="text-muted-foreground">Closed by</dt><dd className="m-0">{EXIT_WORDS[t.by]}</dd></div>
        <div><dt className="text-muted-foreground">Perp pts</dt><dd className={cn('m-0 tabular-nums', netClass(t.perpPts))}>{ptsText(t.perpPts)}</dd></div>
        <div><dt className="text-muted-foreground">Perp entry</dt><dd className="m-0 tabular-nums">{perp(t.perpEntry)}</dd></div>
        <div><dt className="text-muted-foreground">Perp SL · TGT</dt><dd className="m-0 tabular-nums"><span className="text-[var(--down)]">{perp(t.perpSl)}</span> · <span className="text-[var(--up)]">{perp(t.perpTgt)}</span></dd></div>
        <div><dt className="text-muted-foreground">Option SL · TGT</dt><dd className="m-0 tabular-nums">{t.optStop !== null ? <span className="text-[var(--down)]">{opt(t.optStop)}</span> : 'none'} · {t.optTgt !== null ? <span className="text-[var(--up)]">{opt(t.optTgt)}</span> : 'none'}</dd></div>
        <div><dt className="text-muted-foreground">Charges</dt><dd className="m-0 tabular-nums">{moneyText(-t.chargesUsd)}</dd></div>
      </dl>
    </li>
  );
}
