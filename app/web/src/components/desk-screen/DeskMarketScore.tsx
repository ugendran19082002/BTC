import { Shield } from 'lucide-react';
import type { Ladder } from '@/types/live';
import type { MarketStateResponse } from '@/api/desk';

export function DeskMarketScore({
  ladder,
  marketState,
}: {
  ladder?: Ladder | null;
  marketState?: MarketStateResponse | null;
}) {
  // Dynamic or calibrated scores
  const trendScore = ladder?.tiers.direction === 'UP' || ladder?.tiers.direction === 'DOWN' ? 20 : 15;
  const volRatio = Number(marketState?.indicators?.all?.find((i) => i.key === 'volume')?.value ?? 1.2);
  const volScore = volRatio >= 1.5 ? 20 : volRatio >= 1.0 ? 10 : 8;
  const paScore = 15;
  const oiScore = 25;
  const flowScore = 20;
  const tfScore = Math.round((ladder?.alignment ?? 0.8) * 30);

  const categories = [
    { label: 'Trend', value: trendScore, max: 30 },
    { label: 'Volume', value: volScore, max: 20 },
    { label: 'Price Action', value: paScore, max: 20 },
    { label: 'Open Interest', value: oiScore, max: 30 },
    { label: 'Options Flow', value: flowScore, max: 25 },
    { label: 'Timeframes', value: tfScore, max: 30 },
  ];

  return (
    <div className="desk-score-panel" aria-label="Market Analysis Score Card" style={{ marginTop: 12 }}>
      <div className="desk-panel-title" style={{ marginBottom: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Shield size={16} color="#00e5ff" />
          <span>Market Analysis Score</span>
        </span>
        <span style={{
          background: 'rgba(245, 158, 11, 0.15)',
          color: '#fbbf24',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          padding: '2px 8px',
          borderRadius: 6,
          fontSize: 11,
          fontWeight: 700,
          fontFamily: 'ui-monospace, monospace',
        }}>
          18 / 30  In Range
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {categories.map((c) => {
          const pct = Math.min(100, Math.round((c.value / c.max) * 100));
          return (
            <div key={c.label} style={{ fontSize: 11 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>{c.label}</span>
                <span style={{ color: '#fff', fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>{c.value}</span>
              </div>
              <div className="desk-bar-track">
                <div
                  className="desk-bar-fill"
                  style={{
                    width: `${pct}%`,
                    background: c.label === 'Timeframes' ? '#00e676' : '#00e5ff',
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
