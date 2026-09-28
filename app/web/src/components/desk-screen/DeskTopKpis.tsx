import { ArrowDown, ArrowLeftRight, ArrowUp, Zap, Ban, BarChart3 } from 'lucide-react';
import type { LiveResponse } from '@/types/live';
import type { MarketStateResponse } from '@/api/desk';

export function DeskTopKpis({
  liveData,
  marketState,
  breakRisk,
  hoursToExpiry = 20.6,
}: {
  liveData?: LiveResponse | null;
  marketState?: MarketStateResponse | null;
  breakRisk?: any;
  hoursToExpiry?: number;
}) {
  const ladder = liveData?.ladder;
  const prediction = liveData?.prediction;
  const readiness = liveData?.readiness;

  // Market state
  const stateEvent = marketState?.state?.event ?? (ladder?.bias === 'UP' ? 'TREND_UP' : ladder?.bias === 'DOWN' ? 'TREND_DOWN' : 'RANGE');
  const stateWord = stateEvent === 'RANGE' ? 'Sideways'
    : stateEvent.includes('BREAKOUT') ? 'Breakout Watch'
    : stateEvent.includes('BREAKDOWN') ? 'Breakdown Watch'
    : ladder?.bias === 'UP' ? 'Trending Up'
    : ladder?.bias === 'DOWN' ? 'Trending Down' : 'Sideways';

  const dirWay = ladder?.tiers.direction ?? 'UP';
  const setupWay = ladder?.tiers.setup ?? 'UP';
  const triggerWay = ladder?.tiers.trigger ?? 'DOWN';

  const arrowOf = (way: string) => (way === 'UP' ? '↑' : way === 'DOWN' ? '↓' : '→');
  const colorOf = (way: string) => (way === 'UP' ? '#00e676' : way === 'DOWN' ? '#ff3b57' : '#94a3b8');

  // At expiry
  const h = Math.floor(hoursToExpiry);
  const m = Math.round((hoursToExpiry - h) * 60);
  const band = prediction?.band;

  const toPct = (v: any, fallback: number): number => {
    if (v == null) return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return n <= 1 && n > 0 ? Math.round(n * 100) : Math.round(n);
  };

  const rawInside = band?.pInside;
  const rawBelow = band?.pBelow;
  const rawAbove = band?.pAbove;

  let pInside: number;
  let pBelow: number;
  let pAbove: number;

  if (rawInside != null) {
    pInside = toPct(rawInside, 64);
    const outside = Math.max(0, 100 - pInside);
    pBelow = rawBelow != null ? toPct(rawBelow, Math.floor(outside / 2)) : Math.floor(outside / 2);
    pAbove = 100 - pInside - pBelow;
  } else {
    pBelow = toPct(rawBelow, 18);
    pAbove = toPct(rawAbove, 18);
    pInside = Math.max(0, 100 - pBelow - pAbove);
  }

  const rawBias = ladder?.bias;
  const atExpiryBias = rawBias === 'UP' ? 'UP' : rawBias === 'DOWN' ? 'DOWN' : 'RANGE';
  const biasColor = atExpiryBias === 'UP' ? '#00e676' : atExpiryBias === 'DOWN' ? '#ff3b57' : '#00e5ff';
  const biasIconClass = atExpiryBias === 'UP' ? 'desk-icon-expiry' : atExpiryBias === 'DOWN' ? 'desk-icon-risk' : 'desk-icon-regime';

  const align = ladder?.alignment ?? 0.75;
  const confWord = align >= 0.7 ? 'High' : align >= 0.4 ? 'Medium' : 'Low';

  // Big Move Risk
  const move1h = breakRisk?.hourly?.p68Usd ? Math.round(breakRisk.hourly.p68Usd)
    : marketState?.inputs?.atr ? Math.round(marketState.inputs.atr * 1.5) : 352;
  const move10h = breakRisk?.shock?.p95Usd ? Math.round(breakRisk.shock.p95Usd)
    : Math.round(move1h * 2.3);

  // Decision
  const isReady = readiness?.ready ?? false;
  const decisionText = isReady ? `Trade · ${readiness?.side}` : 'No trade';
  const decisionSub = isReady
    ? `${Math.round((ladder?.alignment ?? 0.75) * 100)}% weight agrees`
    : (readiness?.blockers?.[0] ?? 'No side passes its gates');

  // Market Regime
  const regime = marketState?.context?.regime ?? 'Mixed';
  const atrWord = marketState?.context?.volatility?.word ?? 'Normal volatility';

  return (
    <div className="desk-kpis-grid" aria-label="Key Performance Indicators">
      {/* 1. Market State */}
      <div className="desk-kpi-card">
        <div className="desk-kpi-icon-wrap desk-icon-state">
          <ArrowLeftRight size={18} />
        </div>
        <div className="desk-kpi-content">
          <span className="desk-kpi-label">Market State</span>
          <span className="desk-kpi-val">{stateWord}</span>
          <span className="desk-kpi-sub">
            Direction <span style={{ color: colorOf(dirWay), fontWeight: 700 }}>{arrowOf(dirWay)}</span>
            {' '}Setup <span style={{ color: colorOf(setupWay), fontWeight: 700 }}>{arrowOf(setupWay)}</span>
            {' '}Trigger <span style={{ color: colorOf(triggerWay), fontWeight: 700 }}>{arrowOf(triggerWay)}</span>
          </span>
        </div>
      </div>

      {/* 2. At Expiry (matching DeskExpiryPrediction exactly) */}
      <div className="desk-kpi-card">
        <div className={`desk-kpi-icon-wrap ${biasIconClass}`}>
          {atExpiryBias === 'UP' ? (
            <ArrowUp size={18} />
          ) : atExpiryBias === 'DOWN' ? (
            <ArrowDown size={18} />
          ) : (
            <ArrowLeftRight size={18} />
          )}
        </div>
        <div className="desk-kpi-content">
          <span className="desk-kpi-label">At Expiry ({h}h {String(m).padStart(2, '0')}m)</span>
          <span className="desk-kpi-val">
            <span style={{ color: biasColor, marginRight: 6 }}>{atExpiryBias}</span>
            <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>({confWord})</span>
          </span>
          <span className="desk-kpi-sub" style={{ fontFamily: 'ui-monospace, monospace' }}>
            <span style={{ color: '#00e676' }} title={`Above range: ${pAbove}%`}>● {pAbove}%</span>
            <span style={{ color: '#cbd5e1', margin: '0 5px' }} title={`Inside range: ${pInside}%`}>● {pInside}%</span>
            <span style={{ color: '#ff3b57' }} title={`Below range: ${pBelow}%`}>● {pBelow}%</span>
          </span>
        </div>
      </div>

      {/* 3. Big Move Risk */}
      <div className="desk-kpi-card">
        <div className="desk-kpi-icon-wrap desk-icon-risk">
          <Zap size={18} />
        </div>
        <div className="desk-kpi-content">
          <span className="desk-kpi-label">Big Move Risk (Next 1h)</span>
          <span className="desk-kpi-val">±{move1h} pts</span>
          <span className="desk-kpi-sub">1 in 10 hours ±{move10h} pts</span>
        </div>
      </div>

      {/* 4. Decision */}
      <div className="desk-kpi-card">
        <div className="desk-kpi-icon-wrap desk-icon-decision">
          <Ban size={18} />
        </div>
        <div className="desk-kpi-content">
          <span className="desk-kpi-label">Decision</span>
          <span className="desk-kpi-val">{decisionText}</span>
          <span className="desk-kpi-sub">{decisionSub}</span>
        </div>
      </div>

      {/* 5. Market Regime */}
      <div className="desk-kpi-card">
        <div className="desk-kpi-icon-wrap desk-icon-regime">
          <BarChart3 size={18} />
        </div>
        <div className="desk-kpi-content">
          <span className="desk-kpi-label">Market Regime</span>
          <span className="desk-kpi-val">{regime}</span>
          <span className="desk-kpi-sub">{atrWord} · 1h RV 0.8x</span>
        </div>
      </div>
    </div>
  );
}
