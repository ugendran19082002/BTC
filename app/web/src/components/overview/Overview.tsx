import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChainResponse, ExpiryOption, Leg } from '@/types/desk';
import type { TradeStatus } from '@/types/trade';
import { expectedMove, ivRv } from '@/lib/overview';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import {
  KeyLevelsPanel, KpiStrip, IvTermPanel, PriceActionPanel, SkewPanel, TradeFlowPanel, VolatilityPanel,
} from './MarketPanels';
import {
  ChainPanel, EntryPanel, findLeg, ModelViewPanel, ScenarioPanel, SelectedStrikePanel, SellRecommendationPanel,
  StatusBar, StrategyDecisionPanel, type Selected,
} from './DecisionPanels';

/**
 * The decision panels of the Live screen, laid out after the two reference
 * designs in docs/image1.png and docs/image2.png and the checklist in
 * docs/test.md.
 *
 *   KPIs across the top
 *   left    price action · key levels · volatility · trade flow
 *   centre  [chart] · [option chain] · the selected strike
 *   right   model view · strategy decision · sell recommendation · checklist and order
 *   bottom  IV term structure · skew · scenario P&L
 *   status  mode · data age · model · the day
 *
 * The Live screen draws its own chart and its full chain board, so it passes
 * neither here and owns the selected strike: an inspect on the board picks the
 * strike these panels are about. Every figure is read from the chain response
 * or computed from it (lib/overview.ts); what the desk does not capture is
 * shown as not captured. Nothing here places an order: the button opens the
 * same ticket as the board, and the server runs every gate again.
 */
export function Overview({ data, trade, expiries, onExpiry, onSell, contracts, chart, chain = true, selected: selectedProp, onSelect }: {
  data: ChainResponse;
  trade: TradeStatus | null;
  expiries?: readonly ExpiryOption[];
  onExpiry?: (expiry: string) => void;
  /** Opens the order ticket. Absent on a past snapshot. */
  onSell?: (leg: Leg) => void;
  /** The trade size the desk is set to, in contracts. */
  contracts: number;
  /** A price chart for the centre column; none where the screen has its own. */
  chart?: ReactNode;
  /** Draw the compact chain. Off where the screen has the full board. */
  chain?: boolean;
  /** The selected strike, when the screen owns it; `null` means the desk's pick. */
  selected?: Selected | null;
  onSelect?: (s: Selected | null) => void;
}) {
  // A clock for the data-age gate and the status bar, ticking once a second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // The strike under inspection: the desk's own pick until someone clicks
  // another. Owned by the screen when it says so, by these panels otherwise.
  const [ownPicked, setOwnPicked] = useState<Selected | null>(null);
  const picked = onSelect ? selectedProp ?? null : ownPicked;
  const setPicked = onSelect ?? setOwnPicked;
  const deskPick = useMemo<Selected | null>(() => {
    const p = data.best.pick && !data.best.bestOfNone ? data.best.pick : null;
    if (p) return { cp: p.cp, strike: p.strike };
    const s = data.recommendation.sides[0]?.leg;
    return s ? { cp: s.cp, strike: s.strike } : null;
  }, [data.best, data.recommendation]);
  // A pick that is no longer on the board (a new expiry, a moved window) falls back to the desk's.
  const selected = picked && findLeg(data.legs, picked) ? picked : deskPick;
  const leg = findLeg(data.legs, selected);

  const iv = ivRv(data.structure.atmIv, data.market?.realisedVol ?? null);
  const em = expectedMove(data.snapshot);
  const spot = data.market?.spot ?? data.snapshot.spot;

  return (
    <div className="ov">
      <ErrorBoundary where="Overview KPIs"><KpiStrip data={data} spot={spot} iv={iv} /></ErrorBoundary>

      <div className="ov-main">
        <div className="ov-col">
          <ErrorBoundary where="Price action"><PriceActionPanel market={data.market} /></ErrorBoundary>
          <ErrorBoundary where="Key levels"><KeyLevelsPanel data={data} spot={spot} /></ErrorBoundary>
          <ErrorBoundary where="Volatility"><VolatilityPanel data={data} iv={iv} /></ErrorBoundary>
          <ErrorBoundary where="Trade flow"><TradeFlowPanel /></ErrorBoundary>
        </div>

        <div className="ov-col">
          {chart}
          {chain && (
            <ErrorBoundary where="Overview chain">
              <ChainPanel data={data} selected={selected} onSelect={setPicked} expiries={expiries} onExpiry={onExpiry} />
            </ErrorBoundary>
          )}
          <ErrorBoundary where="Selected strike">
            <SelectedStrikePanel data={data} leg={leg} em={em} iv={iv} contracts={contracts} />
          </ErrorBoundary>
        </div>

        <div className="ov-col ov-right">
          <ErrorBoundary where="Model view"><ModelViewPanel data={data} iv={iv} /></ErrorBoundary>
          <ErrorBoundary where="Strategy decision"><StrategyDecisionPanel data={data} iv={iv} onSelect={setPicked} /></ErrorBoundary>
          <ErrorBoundary where="Sell recommendation"><SellRecommendationPanel data={data} onSelect={setPicked} onSell={onSell} /></ErrorBoundary>
          <ErrorBoundary where="Entry"><EntryPanel data={data} leg={leg} iv={iv} trade={trade} onSell={onSell} now={now} contracts={contracts} /></ErrorBoundary>
        </div>
      </div>

      <div className="ov-bottom">
        <ErrorBoundary where="IV term structure"><IvTermPanel /></ErrorBoundary>
        <ErrorBoundary where="Skew"><SkewPanel data={data} /></ErrorBoundary>
        <ErrorBoundary where="Scenario P&L"><ScenarioPanel data={data} leg={leg} contracts={contracts} /></ErrorBoundary>
      </div>

      <StatusBar data={data} trade={trade} now={now} />
    </div>
  );
}
