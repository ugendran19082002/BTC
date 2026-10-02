import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import type { LiveLtp } from '@/hooks/useStream';
import type { Candle, ChainResponse, ExpiryOption } from '@/types/desk';
import type { TradeStatus } from '@/types/trade';
import { getPerp } from '@/api/desk';
import { DeskDashboard } from '@/components/desk-screen/DeskDashboard';
import { usePoll } from '@/hooks/usePoll';
import { bestLeg, windowMinutes, type WindowChoice } from '@/lib/overview';
import { PanelFold } from './parts';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { FlowPanel } from './MarketPanels';
import { findLeg, type Selected } from './DecisionPanels';
import { EarlyWarningPanel, useChanges } from './TraderPanels';
import { TimeframeAnalysisPanel } from './TimeframeAnalysisPanel';
import type { TimeframeRow } from '@/types/entry';

/**
 * The price the screen measures from: the one-second tick, then the chain
 * snapshot's own spot, then the 5-minute close -- each step staler than the
 * last, so never the other way round (27 Sep 2026).
 */
export const screenSpot = (tick: number | null | undefined, snapshot: number | null | undefined, close5m: number | null | undefined): number =>
  tick ?? snapshot ?? close5m ?? 0;

/**
 * The Live screen: the desk dashboard (header, then the chart), then the market read -- the early warning ("Big move catch") and
 * the options' and perpetual's tape.
 *
 * The Big Move Catch section's signal history and big move risk, What changed,
 * volatility & skew, the multi-timeframe table and the strategy decision
 * were removed on 28 Sep 2026, with the dashboard's KPI strip, expiry
 * prediction and analysis grid. See docs/history/2026-09.md.
 *
 * Every figure is read from the chain response, the perp feed or the desk's
 * own record, or is arithmetic on them (lib/overview.ts). Nothing here places
 * an order.
 */
export function Overview({
  data, trade, expiries, onExpiry,
  selected: selectedProp, onSelect, tick, controls,
  bars = [], ltp = null, belowEntry,
}: {
  data: ChainResponse;
  trade: TradeStatus | null;
  expiries?: readonly ExpiryOption[];
  onExpiry?: (expiry: string) => void;
  /** The selected strike, when the screen owns it; `null` means the desk's pick. */
  selected?: Selected | null;
  onSelect?: (s: Selected | null) => void;
  tick?: number | null;
  /** The screen's mode and refresh controls, drawn in the screen bar. */
  controls?: ReactNode;
  /** The desk's live 5m candles, for the entry section's charts. */
  bars?: readonly Candle[];
  /** The perp's last trade and the candles in progress, from the stream; null when it is down. */
  ltp?: LiveLtp | null;
  /** Drawn right under the entry setups: the signal strategies that trade them. */
  belowEntry?: ReactNode;
}) {
  // A clock for the flow window, ticking once a second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const snap = data.snapshot;

  /*
   * The price every figure on this screen is measured from — newest source first
   * (27 Sep 2026): the 1-second tick the header already polls, then the chain
   * snapshot's own `spot_price` (the option tickers, ~8s), then the 5-minute
   * close as a last resort. Every step down is a step staler.
   */
  const spot = screenSpot(tick, snap.spot, data.market?.spot);

  // The perpetual (funding, book, the hour's flow, OI acceleration) every five
  // seconds.
  // The tape's window, shared by the perp's flow and the options' flow; the request follows it.
  const [flowWindow, setFlowWindow] = usePersisted<WindowChoice>('live:flow:window', '1h');
  const flowMin = windowMinutes(flowWindow, now);
  const { data: perp } = usePoll(() => getPerp(flowMin, snap.expiry), 5_000, { enabled: snap.live, deps: [snap.expiry, flowMin] });

  // The strike the early warning reads its premium and IV changes from: the
  // one clicked on the chain, else the server's own pick, the put first -- the
  // side the desk sells most.
  const [ownPicked] = usePersisted<Selected | null>('live:strike', null);
  const picked = onSelect ? selectedProp ?? null : ownPicked;
  const deskPick = useMemo<Selected | null>(() => {
    const legOf = (cp: 'C' | 'P') => data.recommendation.sides.find((x) => x.side === (cp === 'C' ? 'CE' : 'PE'))?.leg ?? bestLeg(data.legs, cp);
    const s = legOf('P') ?? legOf('C');
    if (s) return { cp: s.cp, strike: s.strike };
    const p = data.best.pick && !data.best.bestOfNone ? data.best.pick : null;
    return p ? { cp: p.cp, strike: p.strike } : null;
  }, [data.recommendation, data.legs, data.best]);
  const selected = picked && findLeg(data.legs, picked) ? picked : deskPick;
  const leg = findLeg(data.legs, selected);
  // A held position's first fill, so the changes run from entry.
  const entryOf = useCallback((symbol: string) => {
    const open = (trade?.open ?? []).filter((x) => x.position !== 0 && x.symbol === symbol);
    const ts = open.flatMap((x) => x.fills.map((f) => f.ts)).filter((v) => v > 0);
    return ts.length ? Math.min(...ts) : null;
  }, [trade?.open]);
  const changes = useChanges(data, leg, spot, leg ? entryOf(`${leg.cp}-BTC-${leg.strike}-${snap.expiry}`) : null);

  // Collapse all / expand all: a stamp each press, and what it asked for.
  const [fold] = useState({ stamp: 0, collapsed: false });
  // The entry board's timeframe rows, handed up by the entry section.
  const [timeframes, setTimeframes] = useState<TimeframeRow[]>([]);

  // The board and the perp's positioning, for the chart's strike levels and context line.
  const strikes = useMemo(() => ({ legs: data.legs, maxPain: data.structure?.maxPain?.strike ?? null }), [data.legs, data.structure]);
  const derivs = useMemo(() => (perp ? { oi: perp.perpOi ?? null, funding: perp.ticker?.fundingRate ?? null } : null), [perp]);

  return (
    <PanelFold.Provider value={fold}>
    <div className="ov">
      <DeskDashboard
        onTimeframes={setTimeframes}
        bars={bars}
        ltp={ltp}
        strikes={strikes}
        derivs={derivs}
        expiryLabel={snap.expiry ? `${snap.expiry} 17:30 IST` : undefined}
        hoursToExpiry={snap.hoursToExpiry}
        controls={controls}
        belowEntry={belowEntry}
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
          <ErrorBoundary where="Early warning">
            <EarlyWarningPanel data={data} perp={perp} changes={changes?.rows ?? null} />
          </ErrorBoundary>
          {/* The timeframe chain, under the Big move catch (moved from the with-timeframe panel, 30 Sep 2026). */}
          <ErrorBoundary where="Timeframe analysis">
            <TimeframeAnalysisPanel rows={timeframes} />
          </ErrorBoundary>
        </div>
        <div className="ov-col">
          <ErrorBoundary where="Flow">
            <FlowPanel perp={perp} legs={data.legs} atm={snap.atm} window={flowWindow} onWindow={setFlowWindow} />
          </ErrorBoundary>
        </div>
      </section>
    </div>
    </PanelFold.Provider>
  );
}
