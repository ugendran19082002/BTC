import { useEffect, useMemo, useRef } from 'react';
import { CandlestickSeries, ColorType, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { usePoll } from '@/hooks/usePoll';
import { getCandles } from '@/api/desk';
import { aggregate } from '@/lib/smc/context';
import type { Candle } from '@/types/desk';
import type { EntryPlan, EntryTf } from '@/types/entry';

/**
 * A small price chart for one entry setup: the candles of one timeframe and,
 * for a TRADE, its entry zone, stop and targets as labelled lines on the price
 * axis -- the reference layout's chart. 3m is folded from 1m (Delta does not
 * serve it). Nothing is drawn for WAIT or NO TRADE, or with Setups off.
 */

const fmt = (p: number) => Math.round(p).toLocaleString('en-US');

/** The last `n` candles of a timeframe, polled every 30 s. */
export function useEntryCandles(tf: EntryTf, n = 150): readonly Candle[] {
  const fetchTf = tf === '3m' ? '1m' : tf;
  const { data } = usePoll(() => getCandles(fetchTf as Exclude<EntryTf, '3m'>), 30_000, { deps: [fetchTf] });
  return useMemo(() => {
    const raw = data?.bars ?? [];
    return (tf === '3m' ? aggregate(raw, 60, 180) : raw).slice(-n);
  }, [data, tf, n]);
}

export function EntryChart({ bars, plan, dir, height = 240, label }: {
  bars: readonly Candle[];
  /** The TRADE's levels; null draws the candles alone. */
  plan: EntryPlan | null;
  dir: 'long' | 'short' | null;
  height?: number;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lines = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(148,163,184,0.08)' } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderVisible: false },
      handleScroll: false,
      handleScale: false,
      autoSize: true,
    });
    chart.current = c;
    series.current = c.addSeries(CandlestickSeries, {
      upColor: '#26a17b', downColor: '#e2504f', wickUpColor: '#26a17b', wickDownColor: '#e2504f', borderVisible: false,
    });
    return () => { c.remove(); chart.current = null; series.current = null; lines.current = []; };
  }, [height]);

  useEffect(() => {
    series.current?.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    chart.current?.timeScale().fitContent();
  }, [bars]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = [];
    if (!plan) return;
    const add = (price: number, color: string, title: string, style: LineStyle = LineStyle.Solid, width: 1 | 2 = 1) =>
      lines.current.push(s.createPriceLine({ price, color, title, lineWidth: width, lineStyle: style, axisLabelVisible: true }));
    const entryColor = dir === 'short' ? '#e2504f' : '#3b82f6';
    add(plan.entryHi, entryColor, `ENTRY ${fmt(plan.entryLo)}–${fmt(plan.entryHi)}`, LineStyle.Solid, 2);
    add(plan.entryLo, entryColor, '', LineStyle.Dotted);
    add(plan.stop, '#e2504f', `SL ${fmt(plan.stop)}`, LineStyle.Solid, 2);
    add(plan.tp1, '#26a17b', `TP1 ${fmt(plan.tp1)}`, LineStyle.Solid, 2);
    if (plan.tp2 !== null) add(plan.tp2, '#26a17b', `TP2 ${fmt(plan.tp2)}`, LineStyle.Dashed);
    if (plan.tp3 !== null) add(plan.tp3, '#94a3b8', `TP3 ${fmt(plan.tp3)}`, LineStyle.Dotted);
  }, [plan, dir]);

  const last = bars[bars.length - 1];
  const first = bars[0];
  const change = last && first ? last.close - first.open : null;
  return (
    <div>
      {last && change !== null ? (
        <div className="mb-0.5 flex items-baseline gap-2 text-[12px] tabular-nums">
          <span className="font-bold">₿ BTCUSD {last.close.toLocaleString('en-US', { maximumFractionDigits: 1 })}</span>
          <span className={change >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>
            {change >= 0 ? '+' : '−'}{Math.abs(change).toFixed(1)} ({((100 * change) / first!.open).toFixed(2)}%)
          </span>
          <span className="text-[10.5px] text-muted-foreground">over the {bars.length} candles shown</span>
        </div>
      ) : null}
      <div ref={box} role="img" aria-label={label} style={{ height }} />
    </div>
  );
}
