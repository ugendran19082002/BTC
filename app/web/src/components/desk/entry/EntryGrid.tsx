import { useEffect, useMemo, useRef } from 'react';
import { CandlestickSeries, ColorType, LineStyle, createChart, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp } from 'lightweight-charts';
import { usePoll } from '@/hooks/usePoll';
import { getCandles } from '@/api/desk';
import { aggregate } from '@/lib/smc/context';
import { cn } from '@/lib/utils';
import type { Candle } from '@/types/desk';
import type { EntryMode, EntryTf, MethodRead } from '@/types/entry';

/**
 * The twelve methods as twelve small charts, for one mode at a time: with the
 * timeframe chain (5m candles, where its entry is read) or without it (on the
 * timeframe chosen for that). Each draws its own TRADE's entry, stop and
 * targets; WAIT and NO TRADE draw the candles and say why. Only built while
 * the grid is shown -- twelve charts are not free on a phone.
 */

const BARS = 120;

export function EntryGrid({ mode, onMode, reads, fiveMinute, singleTf, setupsOn }: {
  mode: EntryMode;
  onMode: (m: EntryMode) => void;
  reads: readonly MethodRead[];
  fiveMinute: readonly Candle[];
  singleTf: EntryTf;
  setupsOn: boolean;
}) {
  const tf: EntryTf = mode === 'mtf' ? '5m' : singleTf;
  const needFetch = tf !== '5m';
  const fetchTf = tf === '3m' ? '1m' : tf;
  const { data } = usePoll(() => getCandles(fetchTf as Exclude<EntryTf, '3m'>), 30_000, { enabled: needFetch, deps: [fetchTf] });
  const bars = useMemo<readonly Candle[]>(() => {
    const raw = needFetch ? data?.bars ?? [] : fiveMinute;
    const folded = tf === '3m' ? aggregate(raw, 60, 180) : raw;
    return folded.slice(-BARS);
  }, [needFetch, data, fiveMinute, tf]);

  return (
    <div>
      <div role="group" aria-label="grid mode" className="mb-2 inline-flex overflow-hidden rounded-md border border-border text-[12px]">
        {(['mtf', 'single'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => onMode(m)}
                  className={cn('px-2.5 py-1', mode === m ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
            {m === 'mtf' ? 'With timeframe (12)' : `Without timeframe · ${singleTf} (12)`}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {reads.map((r) => <MiniChart key={`${r.mode}:${r.id}`} read={r} bars={bars} setupsOn={setupsOn} />)}
      </div>
    </div>
  );
}

function MiniChart({ read, bars, setupsOn }: { read: MethodRead; bars: readonly Candle[]; setupsOn: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lines = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      height: 170,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(148,163,184,0.08)' } },
      timeScale: { visible: false },
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
  }, []);

  useEffect(() => {
    series.current?.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    chart.current?.timeScale().fitContent();
  }, [bars]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = [];
    const p = read.plan;
    if (!setupsOn || !p) return;
    const add = (price: number, color: string, title: string, style = LineStyle.Solid) =>
      lines.current.push(s.createPriceLine({ price, color, title, lineWidth: 1, lineStyle: style, axisLabelVisible: true }));
    add(p.entryHi, '#94a3b8', 'entry', LineStyle.Dotted);
    add(p.entryLo, '#94a3b8', '', LineStyle.Dotted);
    add(p.stop, '#e2504f', 'SL');
    add(p.tp1, '#26a17b', 'TP1');
    if (p.tp2 !== null) add(p.tp2, '#26a17b', 'TP2', LineStyle.Dashed);
  }, [read, setupsOn]);

  const tone = read.state === 'TRADE' ? 'text-[var(--up)]' : read.state === 'WAIT' ? 'text-[var(--warn)]' : 'text-muted-foreground';
  return (
    <figure className="m-0 rounded-lg border border-border p-2" aria-label={`${read.name} chart`}>
      <figcaption className="mb-1 flex items-baseline justify-between gap-2 text-[12px]">
        <span><span className="text-muted-foreground">{read.n}</span> {read.name}{read.dir ? (read.dir === 'long' ? ' ▲' : ' ▼') : ''}</span>
        <span className={cn('font-semibold', tone)}>{read.state === 'NO_TRADE' ? 'NO TRADE' : read.state}</span>
      </figcaption>
      <div ref={box} />
      <p className="m-0 mt-1 line-clamp-2 text-[11px] text-muted-foreground">{read.reason}</p>
    </figure>
  );
}
