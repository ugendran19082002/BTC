import type { PerpTicker } from '@/api/desk';

export function DeskStatsBar({
  spot = 84595,
  perpTicker,
  atmIv = 25.3,
  rv = 42.5,
  pcr = 1.88,
  pcrVol = 1.36,
  changePct = 0.32,
}: {
  spot?: number;
  perpTicker?: PerpTicker | null;
  atmIv?: number;
  rv?: number;
  pcr?: number;
  pcrVol?: number;
  changePct?: number;
}) {
  const perpPrice = perpTicker?.last ?? (spot - 44.1);
  const perpChangePct = perpTicker?.change24hPct != null ? perpTicker.change24hPct : 0.66;

  const volUsd = perpTicker?.turnoverUsd24h ? `$${(perpTicker.turnoverUsd24h / 1_000_000).toFixed(1)}M` : '$606.2M';
  const volContracts = perpTicker?.volume24h ? `${Math.round(perpTicker.volume24h).toLocaleString()} contracts` : '7,168 contracts';

  const oiUsd = perpTicker?.oiUsd ? `$${(perpTicker.oiUsd / 1_000_000).toFixed(1)}M` : '$71.4M';
  const oiContracts = perpTicker?.oiContracts ? `${Math.round(perpTicker.oiContracts).toLocaleString()} contracts` : '843,959 contracts';

  const fundingRate = perpTicker?.fundingRate != null ? `${(perpTicker.fundingRate * 100).toFixed(4)}%` : '0.0018%';

  return (
    <div className="desk-stats-strip" aria-label="Market Statistics Strip">
      {/* 1. BTC Spot */}
      <div className="desk-stat-card">
        <span className="desk-stat-lbl">BTC Spot</span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="desk-stat-main" style={{ color: '#00e676' }}>
            {Math.round(spot).toLocaleString('en-US')}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="desk-stat-sub" style={{ color: changePct >= 0 ? '#00e676' : '#ff3b57' }}>
            {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
          </span>
          {/* Mini sparkline svg */}
          <svg width="45" height="14" viewBox="0 0 45 14" fill="none">
            <path d="M1 10 L10 12 L20 7 L30 9 L44 2" stroke="#00e676" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      {/* 2. BTC Perp */}
      <div className="desk-stat-card">
        <span className="desk-stat-lbl">BTC Perp</span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="desk-stat-main" style={{ color: '#00e5ff' }}>
            {perpPrice.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="desk-stat-sub" style={{ color: perpChangePct >= 0 ? '#00e676' : '#ff3b57' }}>
            {perpChangePct >= 0 ? '+' : ''}{perpChangePct.toFixed(2)}%
          </span>
          <svg width="45" height="14" viewBox="0 0 45 14" fill="none">
            <path d="M1 12 L12 9 L22 10 L32 5 L44 3" stroke="#00e5ff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      {/* 3. 24h Volume */}
      <div className="desk-stat-card">
        <span className="desk-stat-lbl">24h Volume</span>
        <span className="desk-stat-main">{volUsd}</span>
        <span className="desk-stat-sub">{volContracts}</span>
      </div>

      {/* 4. Open Interest */}
      <div className="desk-stat-card">
        <span className="desk-stat-lbl">Open Interest</span>
        <span className="desk-stat-main">{oiUsd}</span>
        <span className="desk-stat-sub">{oiContracts}</span>
      </div>

      {/* 5. Funding Rate */}
      <div className="desk-stat-card">
        <span className="desk-stat-lbl">Funding Rate</span>
        <span className="desk-stat-main" style={{ color: '#00e676' }}>{fundingRate}</span>
        <span className="desk-stat-sub">Longs pay (mild bullish) · 00:36:17</span>
      </div>

      {/* 6. IV (ATM) */}
      <div className="desk-stat-card">
        <span className="desk-stat-lbl">IV (ATM)</span>
        <span className="desk-stat-main" style={{ color: '#ff3b57' }}>{atmIv.toFixed(1)}%</span>
        <span className="desk-stat-sub">RV {rv.toFixed(1)}% · cheap</span>
      </div>

      {/* 7. PCR (OI) */}
      <div className="desk-stat-card">
        <span className="desk-stat-lbl">PCR (OI)</span>
        <span className="desk-stat-main">{pcr.toFixed(2)}</span>
        <span className="desk-stat-sub">PCR vol {pcrVol.toFixed(2)}</span>
      </div>
    </div>
  );
}
