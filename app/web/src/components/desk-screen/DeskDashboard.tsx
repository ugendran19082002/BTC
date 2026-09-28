import type { Candle, ChainResponse } from '@/types/desk';
import type { LiveResponse } from '@/types/live';
import type { MarketStateResponse, PerpResponse } from '@/api/desk';
import type { ChartTf } from '@/components/desk/PriceChart';
import { DeskHeader } from './DeskHeader';
import { DeskTopKpis } from './DeskTopKpis';
import { DeskChart } from './DeskChart';
import { DeskExpiryPrediction } from './DeskExpiryPrediction';
import { DeskMomentumSignal } from './DeskMomentumSignal';
import { DeskStatsBar } from './DeskStatsBar';
import { DeskBottomGrid } from './DeskBottomGrid';
import './desk-dashboard.css';

export function DeskDashboard({
  data,
  liveData,
  marketState,
  perp,
  breakRisk,
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
  optionBias,
  controls,
}: {
  data?: ChainResponse | null;
  liveData?: LiveResponse | null;
  marketState?: MarketStateResponse | null;
  perp?: PerpResponse | null;
  breakRisk?: any;
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
  optionBias?: any;
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

      {/* 2. Top 5 KPI Cards */}
      <DeskTopKpis
        liveData={liveData}
        marketState={marketState}
        breakRisk={breakRisk}
        hoursToExpiry={effectiveHours}
      />

      {/* 3. Center 3-Column Row: Chart | Expiry Prediction | Momentum & Score */}
      <div className="desk-center-row">
        {/* Left: Candlestick Chart with Volume & Overlaid Zones */}
        <DeskChart
          bars={bars}
          spot={effectiveSpot}
          tf={tf}
          onTf={onTf}
          marketState={marketState}
          loading={loading}
          error={error}
        />

        {/* Middle: Expiry Prediction Card */}
        <DeskExpiryPrediction
          prediction={liveData?.prediction}
          spot={effectiveSpot}
          hoursToExpiry={effectiveHours}
        />

        {/* Right: Big Momentum Signal (matching docs/image.png) */}
        <DeskMomentumSignal
          spot={effectiveSpot}
          momentum={liveData?.momentum}
          marketState={marketState}
          ladder={liveData?.ladder}
        />
      </div>

      {/* 4. Stats Bar Strip (7 KPI metrics) */}
      <DeskStatsBar
        spot={effectiveSpot}
        perpTicker={perp?.ticker}
        atmIv={atmIv}
        pcr={pcr}
        pcrVol={pcrVol}
        changePct={perp?.ticker?.change24hPct ?? 0.32}
      />

      {/* 5. Bottom 4-Column Analysis Grid */}
      <DeskBottomGrid
        bars={bars}
        spot={effectiveSpot}
        tf={tf}
        marketState={marketState}
        ladder={liveData?.ladder}
        prediction={liveData?.prediction}
        optionBias={optionBias}
      />
    </div>
  );
}
