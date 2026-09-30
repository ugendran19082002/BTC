import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candle } from '@/types/desk';
import type { ChartTf } from '@/components/desk/PriceChart';
import { PriceChart } from '@/components/desk/PriceChart';
import { getCandles, getFlowBars, getHeatmap, getLargePrints, getTrendPaper, type HeatColumn, type PerpOiChange, type Wall } from '@/api/desk';
import type { Leg } from '@/types/desk';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { isForming, withLiveBar, withLtp } from '@/lib/live-bar';
import type { LiveLtp } from '@/hooks/useStream';
import { aggregate, closedBars, readTf, type TfRead } from '@/lib/smc/context';

/**
 * The desk tab's chart: the price chart with its order-flow layers fed in --
 * the book's heatmap, big trades, the delta / CVD pane and the trend plan --
 * each read on its own poll and shared between them.
 */

const HOUR = 3600;
const M5 = 300;
const M1 = 60;
/** What the viewer may switch the chart to. 5m is the main chart; 1m is for timing an entry the 5m already shows. */
const VIEWS: readonly ChartTf[] = ['5m', '1m'];

type Heat = { tf: string; step: number; columns: HeatColumn[]; walls: Wall[] };

/**
 * The book heatmap: every column once, then only from the newest one on (it
 * is still filling), merged in. Starts over when the timeframe changes.
 */
function useHeatmap(tf: '1m' | '5m'): Heat | null {
  const [heat, setHeat] = useState<Heat | null>(null);
  const ref = useRef(heat);
  ref.current = heat;
  const { data } = usePoll(() => {
    const cur = ref.current;
    return getHeatmap(tf, cur && cur.tf === tf ? cur.columns[cur.columns.length - 1]?.time : undefined);
  }, 20_000, { deps: [tf] });
  useEffect(() => {
    if (!data) return;
    setHeat((cur) => {
      if (!cur || cur.tf !== data.tf || cur.step !== data.step) return data;
      const from = data.columns[0]?.time ?? Infinity;
      const oldest = Date.now() / 1000 - 48 * 3600;
      return { ...data, columns: [...cur.columns.filter((c) => c.time < from && c.time >= oldest), ...data.columns] };
    });
  }, [data]);
  return heat && heat.tf === tf ? heat : null;
}

/**
 * The Live screen's chart, with the timeframe context the setup reads:
 * 1H = regime, 30M = bias, 15M = structure, 5M = setup, 1M = trigger.
 * The chart itself also draws the 1H order blocks and the 15m breaks.
 *
 * Three requests a minute: the hour candles (fourteen days), the 5-minute
 * (thirty-six hours, folded into 15m and 30m) and the 1-minute. Only closed
 * candles are read.
 *
 * The viewer may switch the chart to 1m (eight hours of candles). The 1m poll
 * then runs every ten seconds and its forming candle comes from the tape (the
 * stream's `ltp`), or, with the stream down, carries the 5m bars' live price.
 */
export function DeskChart({
  bars, ltp = null, strikes = null, derivs = null, tf = '5m', loading = false, error,
}: {
  bars: readonly Candle[];
  /** The option board's strikes and max pain, for the strike levels. */
  strikes?: { legs: readonly Leg[]; maxPain: number | null } | null;
  /** The perp's OI change and funding, for the context line. */
  derivs?: { oi: PerpOiChange | null; funding: number | null } | null;
  /** The perp's last trade and the candles in progress; null with the stream down. */
  ltp?: LiveLtp | null;
  tf: ChartTf;
  loading?: boolean;
  error?: string;
}) {
  const { data: h1 } = usePoll(() => getCandles('1h'), 60_000);
  const { data: m5 } = usePoll(() => getCandles('5m'), 60_000);
  const [view, setView] = usePersisted<ChartTf>('chart:view', tf);
  const shown = VIEWS.includes(view) ? view : tf;
  const { data: m1 } = usePoll(() => getCandles('1m'), shown === '1m' ? 10_000 : 60_000);
  // Big trades over what the chart spans (36 hours of 5m, 8 of 1m); how big is big, the server reads from the market.
  const bigHours = shown === '1m' ? 8 : 36;
  const { data: big } = usePoll(() => getLargePrints(bigHours), 15_000, { deps: [bigHours] });
  const heat = useHeatmap(shown === '1m' ? '1m' : '5m');
  const { data: paper } = usePoll(() => getTrendPaper(), 60_000);
  const { data: flow } = usePoll(() => getFlowBars(shown === '1m' ? '1m' : '5m', bigHours), 10_000, { deps: [shown, bigHours] });
  const bigTrades = useMemo(() => ({ prints: big?.prints ?? [], min: big?.min ?? 200, basis: big?.basis }), [big]);

  const minute = Math.floor(Date.now() / 60_000);
  const context = useMemo<TfRead[]>(() => {
    const now = minute * 60;
    const out: TfRead[] = [];
    const hour = closedBars(h1?.bars ?? [], HOUR, now);
    const five = closedBars(m5?.bars ?? [], M5, now);
    const one = closedBars(m1?.bars ?? [], M1, now);
    if (hour.length) out.push(readTf('1H', 'Regime', hour, HOUR));
    if (five.length) {
      out.push(readTf('30M', 'Bias', aggregate(five, M5, 1800), 1800));
      out.push(readTf('15M', 'Structure', aggregate(five, M5, 900), 900));
      out.push(readTf('5M', 'Setup', five, M5));
    }
    if (one.length) out.push(readTf('1M', 'Trigger', one, M1));
    return out;
  }, [h1, m5, m1, minute]);

  const higher = useMemo(() => [
    ...(h1?.bars?.length ? [{ tf: '1H', tfSec: HOUR, bars: h1.bars, show: 'zones' as const }] : []),
    ...(m5?.bars?.length ? [{ tf: '15m', tfSec: 900, bars: aggregate(m5.bars, M5, 900), show: 'structure' as const }] : []),
  ], [h1, m5]);

  const now = Date.now();
  const lastFive = bars[bars.length - 1];
  const liveSpot = lastFive && isForming(lastFive, M5, now) ? lastFive.close : null;
  const oneBars = useMemo(
    () => (ltp?.bars['1m'] ? withLiveBar(m1?.bars ?? [], ltp.bars['1m'], M1, now) : withLtp(m1?.bars ?? [], liveSpot, M1, now)),
    [m1, ltp, liveSpot],
  );

  return (
    <div className="desk-chart-panel" aria-label="BTC price chart">
      <div className="desk-chart-container">
        <PriceChart
          bars={shown === '1m' ? oneBars : bars}
          tf={shown}
          views={VIEWS}
          onView={setView}
          loading={shown === '1m' ? loading || !m1 : loading}
          error={error}
          context={context}
          regime={h1?.bars?.length ? { bars: h1.bars, tfSec: HOUR } : null}
          higher={higher}
          bigTrades={bigTrades}
          flowBars={flow?.bars}
          heat={heat}
          strikes={strikes}
          derivs={derivs}
          trendBars={h1?.bars}
          trendPaper={paper?.summary}
          trendPaperTrades={paper?.trades}
          ltp={ltp}
        />
      </div>
    </div>
  );
}
