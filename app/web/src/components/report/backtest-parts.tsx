import { pct } from '@/lib/format';
import { moneyText, ptsText } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { BtRow, BtTot } from '@/types/signal-backtest';
import { Empty } from '@/components/mobile/parts';

/**
 * The pieces the backtest's panels are made of -- the screen itself (`SignalBacktest.tsx`) and the saved
 * backtests run together (`SavedBacktests.tsx`): a table whose rows fold on a phone, three money figures that are
 * never cut short, and the small words for a count, a share and a trade's money.
 */

export const netClass = (n: number) => (n > 0 ? 'text-[var(--up)]' : n < 0 ? 'text-[var(--down)]' : '');
export const rate = (t: Pick<BtTot, 'n' | 'wins'>) => (t.n > 0 ? t.wins / t.n : null);
export const each = (t: Pick<BtTot, 'n' | 'net'>) => (t.n > 0 ? moneyText(t.net / t.n) : '—');
export const count = (n: number) => n.toLocaleString('en-US');

/**
 * Three money figures: three tiles side by side from 640px, and under it a list -- the name on the left, the whole
 * figure on the right. A third of a phone is 96px and "−₹1,23,456" is not: the tiles cut it to "−₹1,23,…" (seen 13 Oct 2026).
 */
export function Ledger({ children }: { children: React.ReactNode }) {
  return <dl className="m-0 grid grid-cols-[minmax(0,1fr)] gap-px overflow-hidden rounded-md bg-muted sm:grid-cols-3 sm:gap-2 sm:overflow-visible sm:bg-transparent">{children}</dl>;
}
export function Entry({ label, children, tone }: { label: string; children: React.ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 px-2.5 py-1.5 sm:block sm:rounded-md sm:bg-muted sm:py-2">
      <dt className="min-w-0 text-[12.5px] text-muted-foreground sm:truncate sm:text-[11.5px]">{label}</dt>
      <dd className={cn('m-0 whitespace-nowrap text-[15px] font-semibold tabular-nums sm:truncate', tone === 'up' && 'text-[var(--up)]', tone === 'down' && 'text-[var(--down)]')}>{children}</dd>
    </div>
  );
}

/*
 * A four-column table whose rows fold to two lines under 640px (owner, 13 Oct 2026: "the By method section is too
 * wide on the phone"): the name with the net beside it, and the trades and the share won under the name. Four
 * columns with a method's full name need about 330px and a phone's panel has 300, so the table pushed the whole
 * page sideways. The cells are the same ones in the same order -- only where they sit changes.
 *
 * The page's own `th` (styles.css) does not wrap, is small capitals and sticks to the top: a row's name undoes that.
 */
const FOLD_CELL = 'max-sm:border-0 max-sm:p-0';
const FOLD_UNDER = `${FOLD_CELL} max-sm:row-start-2 max-sm:text-left max-sm:text-[11.5px] max-sm:text-muted-foreground`;
export const FOLD = {
  table: 'w-full border-collapse text-[13px] tabular-nums max-sm:block',
  head: 'max-sm:sr-only',
  body: 'max-sm:block',
  row: 'border-t border-[var(--line-soft)] align-top max-sm:grid max-sm:grid-cols-[auto_minmax(0,1fr)_auto] max-sm:gap-x-1.5 max-sm:py-2',
  name: `static whitespace-normal bg-transparent py-1.5 pr-2 text-left text-[13px] font-medium normal-case tracking-normal text-foreground [overflow-wrap:anywhere] max-sm:col-span-2 max-sm:col-start-1 max-sm:row-start-1 ${FOLD_CELL}`,
  trades: `py-1.5 pr-2 text-right max-sm:col-start-1 max-sm:after:content-['_trades_·'] ${FOLD_UNDER}`,
  won: `py-1.5 pr-2 text-right max-sm:col-start-2 max-sm:after:content-['_won'] ${FOLD_UNDER}`,
  inProfit: `py-1.5 pr-2 text-right max-sm:col-start-2 max-sm:after:content-['_in_profit'] ${FOLD_UNDER}`,
  net: `py-1.5 text-right max-sm:col-start-3 max-sm:row-span-2 max-sm:row-start-1 ${FOLD_CELL} max-sm:pl-2`,
} as const;

export function Table({ caption, first, rows, perp = false, days = false }: { caption: string; first: string; rows: readonly BtRow[]; perp?: boolean; days?: boolean }) {
  const shown = rows.filter((r) => r.n > 0);
  if (shown.length === 0) return <Empty>No trade here.</Empty>;
  return (
    <table className={FOLD.table}>
      <caption className="sr-only">{caption}</caption>
      <thead className={FOLD.head}>
        <tr className="text-left text-[11.5px] text-muted-foreground">
          <th scope="col" className="py-1 pr-2 font-medium">{first}</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Trades</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Won</th>
          <th scope="col" className="py-1 text-right font-medium">Net</th>
        </tr>
      </thead>
      <tbody className={FOLD.body}>
        {shown.map((r) => (
          <tr key={r.key} className={FOLD.row}>
            <th scope="row" className={FOLD.name}>
              <span>{r.name}</span>
              {days && r.days ? <span className="block text-[11.5px] font-normal text-muted-foreground">{r.days} day{r.days === 1 ? '' : 's'}</span> : null}
              {perp && <span className={cn('block text-[11.5px] font-normal', netClass(r.perpPts))}>perp {ptsText(r.perpPts)}</span>}
            </th>
            <td className={FOLD.trades}>{count(r.n)}</td>
            <td className={FOLD.won}>{pct(rate(r), 0)}</td>
            <td className={FOLD.net}>
              <span className={cn('block whitespace-nowrap font-semibold', netClass(r.net))}>{moneyText(r.net)}</span>
              <span className={cn('block whitespace-nowrap text-[11.5px]', netClass(r.net))}>{each(r)}</span>
              {/* What the fees took, under what was left: the net is after them. */}
              <span className="block whitespace-nowrap text-[11px] text-muted-foreground">charges {moneyText(-r.charges)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
