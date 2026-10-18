import { useState } from 'react';
import { pct } from '@/lib/format';
import { moneyText, ptsText } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { BtRow, BtTot } from '@/types/signal-backtest';
import { Chip, Panel } from '@/components/mobile/parts';
import { FOLD, count, netClass } from '@/components/report/backtest-parts';

/**
 * The perp and the options apart, on the same signals and days (18 Oct 2026, the R&D audit: "perp R and options P&L
 * after fees, separately -- a good perp result must not be taken for a good options one"). The options side is the
 * backtest's own money after charges; the perp side is what the same trades did on the perp, after its round trip's
 * fees (0.05% a side and GST), in points and in R -- the points over the signal's own risk, fill to stop.
 */
const rPer = (r: number | undefined, n: number) => (n > 0 && r !== undefined ? r / n : null);
const rText = (r: number | null) => (r === null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`);
/** Whether the two records point the same way: both up, both down, or one each. */
export const agree = (r: Pick<BtTot, 'net' | 'perpNetPts'>) => r.perpNetPts === undefined || Math.sign(r.net) === Math.sign(r.perpNetPts) || r.net === 0 || r.perpNetPts === 0;

export function PerpVsOptions({ total: t, rows }: { total: BtTot; rows: readonly BtRow[] }) {
  const [onlyApart, setOnlyApart] = useState(false);
  if (t.perpNetPts === undefined || t.n === 0) return null;
  const traded = rows.filter((r) => r.n > 0 && r.perpNetPts !== undefined);
  const apart = traded.filter((r) => !agree(r));
  const shown = (onlyApart ? apart : traded).slice().sort((a, b) => b.net - a.net);
  return (
    <Panel title="Perp vs options" right={<span className="text-[11.5px] text-muted-foreground">same {count(t.n)} trades</span>}>
      <div aria-label="Perp and options, the totals" className="grid min-w-0 grid-cols-2 gap-2">
        <div className="min-w-0 rounded-md bg-muted p-2">
          <div className="text-[11.5px] text-muted-foreground">As options sold, after charges</div>
          <div className={cn('text-[17px] font-semibold tabular-nums', netClass(t.net))}>{moneyText(t.net)}</div>
          <div className="text-[12px] tabular-nums text-muted-foreground">{pct(t.wins / t.n, 0)} won · {moneyText(t.net / t.n)} a trade</div>
        </div>
        <div className="min-w-0 rounded-md bg-muted p-2">
          <div className="text-[11.5px] text-muted-foreground">On the perp, after its fees</div>
          <div className={cn('text-[17px] font-semibold tabular-nums', netClass(t.perpNetPts))}>{ptsText(t.perpNetPts)}</div>
          <div className="text-[12px] tabular-nums text-muted-foreground">
            {pct((t.perpWins ?? 0) / t.n, 0)} won · {rText(rPer(t.perpRNet, t.n))} a trade <span className="text-[var(--dim)]">({rText(rPer(t.perpR, t.n))} before fees)</span>
          </div>
        </div>
      </div>
      <p className="m-0 mt-2 text-[12px] leading-snug text-muted-foreground">
        {apart.length === 0
          ? 'Every method points the same way on both.'
          : <><b className="text-foreground">{count(apart.length)}</b> of {count(traded.length)} methods point opposite ways -- up on one, down on the other. Judge an options strategy by the options record.</>}
        {' '}Perp fees: 0.05% a side and GST, about {ptsText(-0.00118 * 84_000)} a round trip at $84,000.
      </p>
      {apart.length > 0 && (
        <div className="mt-1.5 flex gap-1.5">
          <Chip on={!onlyApart} onClick={() => setOnlyApart(false)}>Every method</Chip>
          <Chip on={onlyApart} onClick={() => setOnlyApart(true)}>Only where they differ ({apart.length})</Chip>
        </div>
      )}
      <table className={cn(FOLD.table, 'mt-1.5')}>
        <caption className="sr-only">Each method as options and on the perp</caption>
        <thead className={FOLD.head}>
          <tr className="text-left text-[11.5px] text-muted-foreground">
            <th scope="col" className="py-1 pr-2 font-medium">Method</th>
            <th scope="col" className="py-1 pr-2 text-right font-medium">Trades</th>
            <th scope="col" className="py-1 pr-2 text-right font-medium">Options</th>
            <th scope="col" className="py-1 text-right font-medium">Perp, after fees</th>
          </tr>
        </thead>
        <tbody className={FOLD.body}>
          {shown.map((r) => (
            <tr key={r.key} className={FOLD.row}>
              <th scope="row" className={FOLD.name}>
                {r.name}
                {!agree(r) && <span className="ml-1 text-[10.5px] font-normal text-[var(--warn)]">differ</span>}
              </th>
              <td className={FOLD.trades}>{count(r.n)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">
                <span className={cn('block whitespace-nowrap font-semibold', netClass(r.net))}>{moneyText(r.net)}</span>
                <span className="block whitespace-nowrap text-[11.5px] text-muted-foreground">{pct(r.wins / r.n, 0)} won</span>
              </td>
              <td className="py-1 text-right tabular-nums">
                <span className={cn('block whitespace-nowrap font-semibold', netClass(r.perpNetPts ?? 0))}>{ptsText(r.perpNetPts ?? 0)}</span>
                <span className="block whitespace-nowrap text-[11.5px] text-muted-foreground">{pct((r.perpWins ?? 0) / r.n, 0)} won · {rText(rPer(r.perpRNet, r.n))}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
