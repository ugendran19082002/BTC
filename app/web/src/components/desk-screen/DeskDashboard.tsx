import type { Candle, ChainResponse } from '@/types/desk';
import type { LiveResponse } from '@/types/live';
import type { MarketStateResponse, PerpResponse } from '@/api/desk';
import type { ChartTf } from '@/components/desk/PriceChart';
import { DeskHeader } from './DeskHeader';
import { DeskChart } from './DeskChart';
import { DeskMomentumSignal } from './DeskMomentumSignal';
import { DeskStatsBar } from './DeskStatsBar';
import './desk-dashboard.css';

/*
 * The KPI strip (market state, direction, expiry, big move risk, decision,
 * regime), the expiry prediction engine and the bottom analysis grid (key
 * levels, the multi-timeframe hierarchy, option bias, market score, expiry
 * chances) were removed on 28 Sep 2026. See docs/TODO.md.
 */
export function DeskDashboard({
  data,
  liveData,
  marketState,
  perp,
  bars,
  spot,
  tf = '15m',
  onTf,
  expiryLabel,
  hoursToExpiry,
  loading = false,
  error,
  onAlerts,
  onSettings,
  controls,
}: {
  data?: ChainResponse | null;
  liveData?: LiveResponse | null;
  marketState?: MarketStateResponse | null;
  perp?: PerpResponse | null;
  bars: readonly Candle[];
  spot: number;
  tf: ChartTf;
  onTf: (tf: ChartTf) => void;
  expiryLabel?: string;
  hoursToExpiry?: number;
  loading?: boolean;
  error?: string;
  onAlerts?: () => void;
  onSettings?: () => void;
  controls?: React.ReactNode;
}) {
  const effectiveHours = hoursToExpiry ?? liveData?.hoursToExpiry ?? 20.6;
  const effectiveSpot = spot || liveData?.spot || data?.snapshot.spot || 84595;
  const effectiveExpiryLabel = expiryLabel || '28 Sept 17:30 IST';

  const atmIv = data?.snapshot.atmIv ? data.snapshot.atmIv * 100 : (liveData?.atmIv ? liveData.atmIv * 100 : 25.3);
  const pcr = data?.structure.pcrOi ?? 1.88;
  const pcrVol = data?.structure.pcrVolume ?? 1.36;

  return (
    <div className="desk-root" aria-label="BTC Live Desk">
      {/* 1. Top Header */}
      <DeskHeader
        spot={effectiveSpot}
        changePct={perp?.ticker?.change24hPct ?? 0.32}
        tf={tf}
        onTf={onTf}
        expiryLabel={effectiveExpiryLabel}
        hoursToExpiry={effectiveHours}
        onAlerts={onAlerts}
        onSettings={onSettings}
        controls={controls}
      />

      {/* 2. Center row: Chart | Momentum signal */}
      <div className="desk-center-row">
        <DeskChart
          bars={bars}
          spot={effectiveSpot}
          tf={tf}
          onTf={onTf}
          marketState={marketState}
          loading={loading}
          error={error}
        />

        <DeskMomentumSignal
          spot={effectiveSpot}
          momentum={liveData?.momentum}
          marketState={marketState}
        />
      </div>

      {/* 3. Stats Bar Strip (7 KPI metrics) */}
      <DeskStatsBar
        spot={effectiveSpot}
        perpTicker={perp?.ticker}
        atmIv={atmIv}
        pcr={pcr}
        pcrVol={pcrVol}
        changePct={perp?.ticker?.change24hPct ?? 0.32}
      />
    </div>
  );
}
