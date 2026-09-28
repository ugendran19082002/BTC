import { useMemo } from 'react';
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

  const trend = marketState?.inputs.regime === 'TREND_UP'
    ? 'UP'
    : marketState?.inputs.regime === 'TREND_DOWN'
    ? 'DOWN'
    : (marketState?.inputs.regime as 'UP' | 'DOWN' | 'RANGE' | 'QUIET') ?? null;

  return (
    <div className="desk-chart-panel" aria-label="BTC Interactive Candlestick Chart">
      <div className="desk-chart-container">
        <PriceChart
          bars={bars}
          support={Math.round(sLevel)}
          resistance={Math.round(rLevel)}
          spot={spot}
          zones={zones}
          lines={marketState?.lines ?? []}
          markers={markers}
          trend={trend}
          bias={marketState?.bias ?? null}
          tf={tf}
          onTf={onTf}
          loading={loading}
          error={error}
          hideTfSelector={false}
          hideHeadline={false}
        />
      </div>
    </div>
  );
}
