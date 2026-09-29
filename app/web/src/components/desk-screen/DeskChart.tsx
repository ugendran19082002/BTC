import { useMemo } from 'react';
import type { Candle } from '@/types/desk';
import type { ChartTf } from '@/components/desk/PriceChart';
import { PriceChart } from '@/components/desk/PriceChart';
import { getCandles } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { isForming, withLtp } from '@/lib/live-bar';
import { aggregate, closedBars, readTf, type TfRead } from '@/lib/smc/context';

const HOUR = 3600;
const M5 = 300;
const M1 = 60;
/** What the viewer may switch the chart to. 5m is the main chart; 1m is for timing an entry the 5m already shows. */
const VIEWS: readonly ChartTf[] = ['5m', '1m'];

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
 * then runs every ten seconds and its forming candle carries the live price
 * from the 5m bars, which the screen already updates every second.
 */
export function DeskChart({
  bars, tf = '5m', loading = false, error,
}: {
  bars: readonly Candle[];
  tf: ChartTf;
  loading?: boolean;
  error?: string;
}) {
  const { data: h1 } = usePoll(() => getCandles('1h'), 60_000);
  const { data: m5 } = usePoll(() => getCandles('5m'), 60_000);
  const [view, setView] = usePersisted<ChartTf>('chart:view', tf);
  const shown = VIEWS.includes(view) ? view : tf;
  const { data: m1 } = usePoll(() => getCandles('1m'), shown === '1m' ? 10_000 : 60_000);

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
  const oneBars = useMemo(() => withLtp(m1?.bars ?? [], liveSpot, M1, now), [m1, liveSpot]);

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
        />
      </div>
    </div>
  );
}
