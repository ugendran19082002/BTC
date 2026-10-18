import { pct } from '@/lib/format';
import { moneyText, ptsText } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import { usePersisted } from '@/hooks/usePersisted';
import { useState } from 'react';
import type { BtRow, BtTot } from '@/types/signal-backtest';
import { Chip, Panel } from '@/components/mobile/parts';
import { FOLD, count, netClass } from '@/components/report/backtest-parts';

/**
 * The perp and the options apart, on the same signals and days (18 Oct 2026, the R&D audit: "perp R and options P&L
 * after fees, separately -- a good perp result must not be taken for a good options one"). The options side is the
 * backtest's own money after charges; the perp side is what the same trades did on the perp, after its round trip's
 * fees (0.05% a side and GST), in points and in R -- the points over the signal's own risk, fill to stop.
 *
 * By time frame too (owner, 18 Oct 2026: "perp vs options by time frame -- 3m, 5m, 15m, 30m, 1h, 2h, 4h, all; won and
 * lost on the perp and the options, and the options' charges"): all of them together, or one, its methods under it.
 */
const rPer = (r: number | undefined, n: number) => (n > 0 && r !== undefined ? r / n : null);
const rText = (r: number | null) => (r === null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`);
/** Whether the two records point the same way: both up, both down, or one each. */
export const agree = (r: Pick<BtTot, 'net' | 'perpNetPts'>) => r.perpNetPts === undefined || Math.sign(r.net) === Math.sign(r.perpNetPts) || r.net === 0 || r.perpNetPts === 0;
/** The time frame a pair is of (`method|mode|tf`): its own, or the chain's. */
const tfOfPair = (key: string) => { const [, mode, tf] = key.split('|'); return mode === 'mtf' ? 'chain' : tf ?? ''; };
const tfName = (k: string) => (k === 'chain' ? 'TF chain' : k);
/** Won and lost: the options' by money after charges, the perp's after its fees. */
const optWL = (t: BtTot) => `${count(t.wins)} won · ${count(t.n - t.wins)} lost`;
const perpWL = (t: BtTot) => `${count(t.perpWins ?? 0)} won · ${count(t.n - (t.perpWins ?? 0))} lost`;

export function PerpVsOptions({ total, rows, pairs = [], byTf = [] }: {
  total: BtTot;
  /** Each method over every time frame. */
  rows: readonly BtRow[];
  /** Each method on each time frame (`method|mode|tf`): what one time frame's methods are. */
  pairs?: readonly BtRow[];
  /** Each time frame's total. */
  byTf?: readonly BtRow[];
}) {
  const [onlyApart, setOnlyApart] = useState(false);
  const [tfPick, setTf] = usePersisted<string>('signalBacktest.perpVsOptions.tf', 'all');
  const frames = byTf.filter((r) => r.n > 0 && r.perpNetPts !== undefined);
  // A time frame chosen before and not in this result: all of them.
  const tf = tfPick !== 'all' && frames.some((r) => r.key === tfPick) ? tfPick : 'all';
  const t = tf === 'all' ? total : frames.find((r) => r.key === tf)!;
  if (total.perpNetPts === undefined || total.n === 0) return null;
  const traded = (tf === 'all' ? rows : pairs.filter((p) => tfOfPair(p.key) === tf)).filter((r) => r.n > 0 && r.perpNetPts !== undefined);
  const apart = traded.filter((r) => !agree(r));
  const shown = (onlyApart ? apart : traded).slice().sort((a, b) => b.net - a.net);
  return (
    <Panel title="Perp vs options" right={<span className="text-[11.5px] text-muted-foreground">same {count(t.n)} trades{tf === 'all' ? '' : ` · ${tfName(tf)}`}</span>}>
      {frames.length > 1 && (
        <div role="group" aria-label="Perp vs options, time frame" className="mb-2 flex min-w-0 flex-wrap gap-1.5">
          <Chip on={tf === 'all'} onClick={() => setTf('all')}>All time frames</Chip>
          {frames.map((r) => <Chip key={r.key} on={tf === r.key} onClick={() => setTf(r.key)}>{tfName(r.key)}</Chip>)}
        </div>
      )}
      <div aria-label="Perp and options, the totals" className="grid min-w-0 grid-cols-2 gap-2">
        <div className="min-w-0 rounded-md bg-muted p-2">
          <div className="text-[11.5px] text-muted-foreground">As options sold, after charges</div>
          <div className={cn('text-[17px] font-semibold tabular-nums', netClass(t.net))}>{moneyText(t.net)}</div>
          <div className="text-[12px] tabular-nums text-muted-foreground">{optWL(t)} · {pct(t.wins / t.n, 0)} won</div>
          <div className="text-[12px] tabular-nums text-muted-foreground">charges {moneyText(-t.charges)} · {moneyText(t.net / t.n)} a trade</div>
        </div>
        <div className="min-w-0 rounded-md bg-muted p-2">
          <div className="text-[11.5px] text-muted-foreground">On the perp, after its fees</div>
          <div className={cn('text-[17px] font-semibold tabular-nums', netClass(t.perpNetPts ?? 0))}>{ptsText(t.perpNetPts ?? 0)}</div>
          <div className="text-[12px] tabular-nums text-muted-foreground">{perpWL(t)} · {pct((t.perpWins ?? 0) / t.n, 0)} won</div>
          <div className="text-[12px] tabular-nums text-muted-foreground">
            {rText(rPer(t.perpRNet, t.n))} a trade <span className="text-[var(--dim)]">({rText(rPer(t.perpR, t.n))} before fees)</span>
          </div>
        </div>
      </div>
      {/* Every time frame at a glance: the two records side by side, the ones pointing opposite ways marked. */}
      {tf === 'all' && frames.length > 1 && (
        <table className={cn(FOLD.table, 'mt-2')} aria-label="Perp vs options by time frame">
          <caption className="sr-only">Each time frame as options and on the perp</caption>
          <thead className={FOLD.head}>
            <tr className="text-left text-[11.5px] text-muted-foreground">
              <th scope="col" className="py-1 pr-2 font-medium">Time frame</th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">Trades</th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">Options</th>
              <th scope="col" className="py-1 text-right font-medium">Perp, after fees</th>
            </tr>
          </thead>
          <tbody className={FOLD.body}>
            {frames.map((r) => (
              <tr key={r.key} className={FOLD.row}>
                <th scope="row" className={FOLD.name}>
                  <button type="button" onClick={() => setTf(r.key)} className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[var(--accent)] underline underline-offset-2">{tfName(r.key)}</button>
                  {!agree(r) && <span className="ml-1 text-[10.5px] font-normal text-[var(--warn)]">differ</span>}
                </th>
                <td className={FOLD.trades}>{count(r.n)}</td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  <span className={cn('block whitespace-nowrap font-semibold', netClass(r.net))}>{moneyText(r.net)}</span>
                  <span className="block whitespace-nowrap text-[11.5px] text-muted-foreground">{optWL(r)}</span>
                  <span className="block whitespace-nowrap text-[11px] text-[var(--dim)]">charges {moneyText(-r.charges)}</span>
                </td>
                <td className="py-1 text-right tabular-nums">
                  <span className={cn('block whitespace-nowrap font-semibold', netClass(r.perpNetPts ?? 0))}>{ptsText(r.perpNetPts ?? 0)}</span>
                  <span className="block whitespace-nowrap text-[11.5px] text-muted-foreground">{perpWL(r)}</span>
                  <span className="block whitespace-nowrap text-[11px] text-[var(--dim)]">{rText(rPer(r.perpRNet, r.n))}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="m-0 mt-2 text-[12px] leading-snug text-muted-foreground">
        {apart.length === 0
          ? `Every method${tf === 'all' ? '' : ` on ${tfName(tf)}`} points the same way on both.`
          : <><b className="text-foreground">{count(apart.length)}</b> of {count(traded.length)} methods{tf === 'all' ? '' : ` on ${tfName(tf)}`} point opposite ways -- up on one, down on the other. Judge an options strategy by the options record.</>}
        {' '}Perp fees: 0.05% a side and GST, about {ptsText(-0.00118 * 84_000)} a round trip at $84,000.
      </p>
      {apart.length > 0 && (
        <div className="mt-1.5 flex gap-1.5">
          <Chip on={!onlyApart} onClick={() => setOnlyApart(false)}>Every method</Chip>
          <Chip on={onlyApart} onClick={() => setOnlyApart(true)}>Only where they differ ({apart.length})</Chip>
        </div>
      )}
      <table className={cn(FOLD.table, 'mt-1.5')} aria-label="Perp vs options by method">
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
                <span className="block whitespace-nowrap text-[11.5px] text-muted-foreground">{optWL(r)}</span>
                <span className="block whitespace-nowrap text-[11px] text-[var(--dim)]">charges {moneyText(-r.charges)}</span>
              </td>
              <td className="py-1 text-right tabular-nums">
                <span className={cn('block whitespace-nowrap font-semibold', netClass(r.perpNetPts ?? 0))}>{ptsText(r.perpNetPts ?? 0)}</span>
                <span className="block whitespace-nowrap text-[11.5px] text-muted-foreground">{perpWL(r)}</span>
                <span className="block whitespace-nowrap text-[11px] text-[var(--dim)]">{rText(rPer(r.perpRNet, r.n))}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
