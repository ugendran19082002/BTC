import { useMemo } from 'react';
import type { Candle } from '@/types/desk';
import type { ChartTf } from '@/components/desk/PriceChart';
import { PriceChart } from '@/components/desk/PriceChart';
import { getCandles } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import { aggregate, closedBars, readTf, type TfRead } from '@/lib/smc/context';

const HOUR = 3600;
const M5 = 300;
const M1 = 60;

/**
 * The Live screen's chart, with the timeframe context the setup reads:
 * 1H = regime, 30M = bias, 15M = structure, 5M = setup, 1M = trigger.
 *
 * Three requests a minute: the hour candles (fourteen days), the 5-minute
 * (thirty-six hours, folded into 15m and 30m here) and the 1-minute. Only
 * closed candles are read.
 */
export function DeskChart({
  bars, tf = '15m', onTf, loading = false, error,
}: {
  bars: readonly Candle[];
  tf: ChartTf;
  onTf: (tf: ChartTf) => void;
  loading?: boolean;
  error?: string;
}) {
  const { data: h1 } = usePoll(() => getCandles('1h'), 60_000);
  const { data: m5 } = usePoll(() => getCandles('5m'), 60_000);
  const { data: m1 } = usePoll(() => getCandles('1m'), 60_000);

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

  return (
    <div className="desk-chart-panel" aria-label="BTC price chart">
      <div className="desk-chart-container">
        <PriceChart
          bars={bars}
          tf={tf}
          onTf={onTf}
          loading={loading}
          error={error}
          context={context}
          regime={h1?.bars?.length ? { bars: h1.bars, tfSec: HOUR } : null}
        />
      </div>
    </div>
  );
}
