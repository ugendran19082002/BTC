import type { Candle } from '@/types/desk';
import type { LiveLtp } from '@/hooks/useStream';
import type { ChartTf } from '@/components/desk/PriceChart';
import { DeskHeader } from './DeskHeader';
import { DeskChart } from './DeskChart';
import './desk-dashboard.css';

/*
 * The Live screen's top: a one-row header, then the price chart at full
 * width. The KPI strip, expiry prediction and analysis grid went on 28 Sep
 * 2026, and later that day the Big Momentum Signal card and the stats strip
 * (spot, perp, volume, OI, funding, IV, PCR) -- the chart's own readout carries
 * the setup now. See docs/TODO.md.
 */
export function DeskDashboard({
  bars,
  ltp = null,
  tf = '5m',
  expiryLabel,
  hoursToExpiry,
  loading = false,
  error,
  onAlerts,
  onSettings,
  controls,
}: {
  bars: readonly Candle[];
  ltp?: LiveLtp | null;
  tf: ChartTf;
  expiryLabel?: string;
  hoursToExpiry?: number;
  loading?: boolean;
  error?: string;
  onAlerts?: () => void;
  onSettings?: () => void;
  controls?: React.ReactNode;
}) {
  return (
    <div className="desk-root" aria-label="BTC Live Desk">
      <DeskHeader
        expiryLabel={expiryLabel}
        hoursToExpiry={hoursToExpiry}
        onAlerts={onAlerts}
        onSettings={onSettings}
        controls={controls}
      />
      <div className="desk-chart-row">
        <DeskChart bars={bars} ltp={ltp} tf={tf} loading={loading} error={error} />
      </div>
    </div>
  );
}
