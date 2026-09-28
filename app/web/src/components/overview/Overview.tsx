import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import type { Candle, ChainResponse, ExpiryOption } from '@/types/desk';
import { getPerp, getTerm, type MarketStateResponse } from '@/api/desk';
import { getLive } from '@/api/live';
import type { LiveResponse } from '@/types/live';
import { DeskDashboard } from '@/components/desk-screen/DeskDashboard';
import { usePoll } from '@/hooks/usePoll';
import type { ChartTf } from '@/components/desk/PriceChart';
import { ivRv, windowMinutes, skew, type WindowChoice } from '@/lib/overview';
import { PanelFold } from './parts';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { FlowPanel, VolatilityPanel } from './MarketPanels';

/**
 * The Live screen: the desk dashboard (header, chart, momentum signal, stats
 * strip), then the market read -- volatility and the options' and
 * perpetual's tape.
 *
 * The Big Move Catch section (the early warning, signal history, big move
 * risk), What changed, the multi-timeframe table and the strategy decision
 * were removed on 28 Sep 2026, with the dashboard's KPI strip, expiry
 * prediction and analysis grid. See docs/TODO.md.
 *
 * Every figure is read from the chain response, the perp feed or the desk's
 * own record, or is arithmetic on them (lib/overview.ts). Nothing here places
 * an order.
 */
export function Overview({
  data, expiries, onExpiry, chartTf = '15m', tick, controls, error,
  bars = [], marketState = null, onTf,
}: {
  data: ChainResponse;
  expiries?: readonly ExpiryOption[];
  onExpiry?: (expiry: string) => void;
  /** The chart's timeframe. */
  chartTf?: ChartTf;
  tick?: number | null;
  /** The screen's mode and refresh controls, drawn in the screen bar. */
  controls?: ReactNode;
  /** The last load's error, if the chain on screen is older than it should be. */
  error?: string | null;
  bars?: readonly Candle[];
  marketState?: MarketStateResponse | null;
  onTf?: (tf: ChartTf) => void;
}) {
  // A clock for the flow window, ticking once a second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const snap = data.snapshot;
  const { data: liveData } = usePoll<LiveResponse>(
    () => getLive({ expiry: snap.expiry }),
    5_000,
    { deps: [snap.expiry] },
  );

  const iv = ivRv(data.structure.atmIv, data.market?.realisedVol ?? null);
  /*
   * The price every figure on this screen is measured from — newest source first
   * (27 Sep 2026): the 1-second tick the header already polls, then the chain
   * snapshot's own `spot_price` (the option tickers, ~8s), then the 5-minute
   * close as a last resort. Every step down is a step staler.
   */
  const spot = tick ?? snap.spot ?? data.market?.spot ?? 0;

  // The perpetual (funding, book, the hour's flow, OI acceleration) every five
  // seconds; the term structure and the ranks once a minute -- they move slowly.
  // The tape's window, shared by the perp's flow and the options' flow; the request follows it.
  const [flowWindow, setFlowWindow] = usePersisted<WindowChoice>('live:flow:window', '1h');
  const flowMin = windowMinutes(flowWindow, now);
  const { data: perp } = usePoll(() => getPerp(flowMin, snap.expiry), 5_000, { enabled: snap.live, deps: [snap.expiry, flowMin] });
  const skewPts = useMemo(() => skew(data.legs, data.structure.atmIv).putCallPts, [data.legs, data.structure.atmIv]);
  const atmIv = data.structure.atmIv;
  const { data: term } = usePoll(() => getTerm(skewPts, atmIv), 60_000, { deps: [skewPts === null, atmIv === null] });

  // Collapse all / expand all: a stamp each press, and what it asked for.
  const [fold] = useState({ stamp: 0, collapsed: false });

  return (
    <PanelFold.Provider value={fold}>
    <div className="ov">
      <DeskDashboard
        data={data}
        liveData={liveData}
        marketState={marketState}
        perp={perp}
        bars={bars}
        spot={spot}
        tf={chartTf}
        onTf={onTf ?? (() => {})}
        expiryLabel={snap.expiry ? `${snap.expiry} 17:30 IST` : undefined}
        hoursToExpiry={snap.hoursToExpiry}
        error={error ?? undefined}
        controls={controls}
      />

      {/* Accessible Expiry select for automation and accessibility */}
      {expiries && expiries.length > 0 && (
        <label className="sr-only">
          Expiry
          <select
            aria-label="Expiry"
            value={snap.expiry}
            onChange={(e) => onExpiry?.(e.target.value)}
          >
            {expiries.map((e) => (
              <option key={e.expiry} value={e.expiry}>
                {e.expiry}
              </option>
            ))}
          </select>
        </label>
      )}

      <section className="ov-main" aria-label="Market read" style={{ marginTop: 24 }}>
        <div className="ov-col">
          <ErrorBoundary where="Volatility">
            <VolatilityPanel data={data} iv={iv} skewRank={term?.skew ?? null} />
          </ErrorBoundary>
        </div>
        <div className="ov-col">
          <ErrorBoundary where="Flow">
            <FlowPanel perp={perp} market={data.market} legs={data.legs} atm={snap.atm} window={flowWindow} onWindow={setFlowWindow} />
          </ErrorBoundary>
        </div>
      </section>
    </div>
    </PanelFold.Provider>
  );
}
