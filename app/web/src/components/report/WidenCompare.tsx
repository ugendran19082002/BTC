import { useEffect, useState } from 'react';
import { pct } from '@/lib/format';
import { dayLabel, moneyText } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { BtTot, WidenMode } from '@/types/signal-backtest';
import { Panel } from '@/components/mobile/parts';
import { FOLD, count, netClass } from '@/components/report/backtest-parts';

/**
 * The perp's SL and TGT three ways on the same trades (owner, 18 Oct 2026: "keep the widest vs back to the signal's own
 * when calm -- in the backtest report"): the signal's own levels all trade; widened with volatility and kept at the
 * widest; widened only while the 1m ATR is over its level at the fill, back to the signal's own once it is not. Each
 * the same backtest -- or the same run together -- asked again with that one setting changed: money, won and lost, the
 * perp SL's hits and the worst day. Asked on a tap, one after another (each is a whole backtest).
 */
export type WidenVariant = { slAtr: number; tgtAtr: number; mode: WidenMode } | null;
type Answer = { total: BtTot; days: readonly { day: string; net: number }[] };
const VARIANTS: { key: string; label: string; v: (sl: number, tgt: number) => WidenVariant }[] = [
  { key: 'own', label: "Signal's own", v: () => null },
  { key: 'widest', label: 'Keep widest', v: (sl, tgt) => ({ slAtr: sl, tgtAtr: tgt, mode: 'widest' }) },
  { key: 'calm', label: 'Back when calm', v: (sl, tgt) => ({ slAtr: sl, tgtAtr: tgt, mode: 'calm' }) },
];

export function WidenCompare({ sl, tgt, ask, askKey }: {
  /** The multipliers being compared: the screen's own, or the run's. */
  sl: number; tgt: number;
  ask: (v: WidenVariant) => Promise<Answer>;
  /** Changes with everything else asked: a comparison of other settings is not kept. */
  askKey: string;
}) {
  const [state, setState] = useState<{ busy: boolean; rows: Record<string, Answer> | null; error: string | null }>({ busy: false, rows: null, error: null });
  useEffect(() => { setState({ busy: false, rows: null, error: null }); }, [askKey, sl, tgt]);
  const go = async () => {
    setState({ busy: true, rows: null, error: null });
    try {
      const rows: Record<string, Answer> = {};
      for (const x of VARIANTS) rows[x.key] = await ask(x.v(sl, tgt));
      setState({ busy: false, rows, error: null });
    } catch (e) {
      setState({ busy: false, rows: null, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const rows = state.rows;
  const best = rows ? Math.max(...VARIANTS.map((x) => rows[x.key]!.total.net)) : null;
  return (
    <Panel title="Perp SL & TGT: the three ways">
      <p className="m-0 text-[12.5px] leading-snug text-muted-foreground">
        The same trades with the signal&apos;s own perp SL and TGT; widened with volatility and <b className="font-medium text-foreground">kept at the widest</b>; and widened only while the 1m ATR is over its level at the fill, <b className="font-medium text-foreground">back to the signal&apos;s own when calm</b>.
        {' '}At {[sl > 0 ? `SL ${sl}×` : null, tgt > 0 ? `TGT ${tgt}×` : null].filter(Boolean).join(', ')} ATR.
      </p>
      {!rows && (
        <button type="button" onClick={go} disabled={state.busy}
          className="m-0 mt-2 h-9 appearance-none rounded-md border border-solid border-border bg-background px-3 font-[inherit] text-[12.5px] text-foreground disabled:opacity-50">
          {state.busy ? 'Running the three…' : 'Compare the three'}
        </button>
      )}
      {state.error && <p role="alert" className="m-0 mt-1.5 text-[12px] text-[var(--down)]">{state.error}</p>}
      {rows && (
        <table className={cn(FOLD.table, 'mt-2')} aria-label="Perp SL and TGT, the three ways">
          <caption className="sr-only">The same trades three ways</caption>
          <thead className={FOLD.head}>
            <tr className="text-left text-[11.5px] text-muted-foreground">
              <th scope="col" className="py-1 pr-2 font-medium">Perp levels</th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">Net</th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">Won · lost</th>
              <th scope="col" className="py-1 text-right font-medium">Perp SL hits · worst day</th>
            </tr>
          </thead>
          <tbody className={FOLD.body}>
            {VARIANTS.map((x) => {
              const a = rows[x.key]!, t = a.total, slHit = t.exits['perp-sl'];
              const worst = a.days.length ? a.days.reduce((w, d) => (d.net < w.net ? d : w), a.days[0]!) : null;
              return (
                <tr key={x.key} className={FOLD.row}>
                  <th scope="row" className={FOLD.name}>{x.label}{t.net === best && t.n > 0 ? ' ★' : ''}</th>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    <span className={cn('block whitespace-nowrap font-semibold', netClass(t.net))}>{moneyText(t.net)}</span>
                    <span className="block whitespace-nowrap text-[11.5px] text-muted-foreground">{count(t.n)} trades</span>
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                    <span className="block whitespace-nowrap">{count(t.wins)} · {count(t.n - t.wins)}</span>
                    <span className="block whitespace-nowrap text-[11.5px]">{t.n ? pct(t.wins / t.n, 0) : '—'} won</span>
                  </td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    <span className="block whitespace-nowrap">{count(slHit?.n ?? 0)} <span className={netClass(slHit?.net ?? 0)}>{moneyText(slHit?.net ?? 0)}</span></span>
                    <span className="block whitespace-nowrap text-[11.5px]">{worst ? <>{dayLabel(worst.day)} <span className={netClass(worst.net)}>{moneyText(worst.net)}</span></> : '—'}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
