import { useMemo } from 'react';
import { Crosshair, Edit3, Eye, Maximize2, Minus, TrendingUp } from 'lucide-react';
import type { Candle } from '@/types/desk';
import type { ChartTf } from '@/components/desk/PriceChart';
import { PriceChart } from '@/components/desk/PriceChart';
import type { Zone, StateMarker } from '@/components/desk/chart-overlay';
import type { MarketStateResponse } from '@/api/desk';

export function DeskChart({
  bars,
  spot,
  tf = '15m',
  onTf,
  marketState,
  loading = false,
  error,
}: {
  bars: readonly Candle[];
  spot: number;
  tf: ChartTf;
  onTf: (tf: ChartTf) => void;
  marketState?: MarketStateResponse | null;
  loading?: boolean;
  error?: string;
}) {
  const lastBar = bars.length > 0 ? bars[bars.length - 1] : null;
  const prevBar = bars.length > 1 ? bars[bars.length - 2] : null;

  const open = lastBar?.open ?? spot;
  const high = lastBar?.high ?? spot;
  const low = lastBar?.low ?? spot;
  const close = lastBar?.close ?? spot;
  const vol = lastBar?.volume ? Math.round(lastBar.volume) : 384;

  const change = prevBar ? close - prevBar.close : 127;
  const changePct = prevBar && prevBar.close > 0 ? (change / prevBar.close) * 100 : 0.15;

  // Resistance & Support zones from levels or marketState
  const rLevel = marketState?.levels?.find((l) => l.side === 'resistance')?.price ?? (spot + 530);
  const sLevel = marketState?.levels?.find((l) => l.side === 'support')?.price ?? (spot - 300);

  const zones: Zone[] = useMemo(() => [
    {
      from: Math.round(rLevel - 20),
      to: Math.round(rLevel + 25),
      label: `Resistance Zone ${Math.round(rLevel - 20).toLocaleString()} – ${Math.round(rLevel + 25).toLocaleString()}`,
      tone: 'down',
    },
    {
      from: Math.round(sLevel - 25),
      to: Math.round(sLevel + 20),
      label: `Support Zone ${Math.round(sLevel - 25).toLocaleString()} – ${Math.round(sLevel + 20).toLocaleString()}`,
      tone: 'up',
    },
  ], [rLevel, sLevel]);

  // Swing markers
  const markers: StateMarker[] = useMemo(() => {
    if (bars.length < 5) return [];
    const targetBar = bars[bars.length - 4] ?? bars[bars.length - 1];
    if (!targetBar) return [];
    return [
      {
        time: targetBar.time,
        label: 'Lower High',
        above: true,
        tone: 'down',
      },
    ];
  }, [bars]);

  return (
    <div className="desk-chart-panel" aria-label="BTC Interactive Candlestick Chart">
      <div className="desk-chart-header">
        <div className="desk-chart-ohlc">
          <span className="desk-ohlc-sym">BTC · {tf}</span>
          <span>O <strong style={{ color: '#fff' }}>{Math.round(open).toLocaleString()}</strong></span>
          <span>H <strong style={{ color: '#00e676' }}>{Math.round(high).toLocaleString()}</strong></span>
          <span>L <strong style={{ color: '#ff3b57' }}>{Math.round(low).toLocaleString()}</strong></span>
          <span>C <strong style={{ color: '#00e676' }}>{Math.round(close).toLocaleString()}</strong></span>
          <span style={{ color: change >= 0 ? '#00e676' : '#ff3b57' }}>
            {change >= 0 ? '+' : ''}{Math.round(change)} ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
          </span>
          <span style={{ color: '#94a3b8' }}>Vol {vol}</span>
        </div>

        <div className="desk-chart-tools">
          <button type="button" className="desk-chart-tool-btn" title="Crosshair"><Crosshair size={14} /></button>
          <button type="button" className="desk-chart-tool-btn" title="Trendline"><TrendingUp size={14} /></button>
          <button type="button" className="desk-chart-tool-btn" title="Horizontal Line"><Minus size={14} /></button>
          <button type="button" className="desk-chart-tool-btn" title="Indicators"><Eye size={14} /></button>
          <button type="button" className="desk-chart-tool-btn" title="Draw"><Edit3 size={14} /></button>
          <button type="button" className="desk-chart-tool-btn" title="Expand"><Maximize2 size={14} /></button>
        </div>
      </div>

      <div className="desk-chart-container">
        <PriceChart
          bars={bars}
          support={Math.round(sLevel)}
          resistance={Math.round(rLevel)}
          spot={spot}
          zones={zones}
          markers={markers}
          tf={tf}
          onTf={onTf}
          loading={loading}
          error={error}
        />
      </div>
    </div>
  );
}
