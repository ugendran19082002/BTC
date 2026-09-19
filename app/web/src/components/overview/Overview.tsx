import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChainResponse, ExpiryOption, Leg } from '@/types/desk';
import type { TradeStatus } from '@/types/trade';
import { getPerp, getTerm } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import type { ChartTf } from '@/components/desk/PriceChart';
import {
  assessBoth, assessSides, expectedMove, ivRv, readiness, riskEngine, sideGates, sideSelector, sideStatusOf, skew,
  type SideAssessment, type SideChoice,
} from '@/lib/overview';
import { DEFAULT_CONFIG, thresholds, type ScreenConfig } from '@/lib/screen-config';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import {
  KeyLevelsPanel, KpiStrip, IvTermPanel, MtfPanel, PriceActionPanel, SkewPanel, TradeFlowPanel, VolatilityPanel,
} from './MarketPanels';
import { ChainPanel, ChecklistPanel, findLeg, SelectedStrikePanel, StrategyDecisionPanel, type Selected } from './DecisionPanels';
import { SettingsStrip } from './SettingsStrip';
import { RiskEnginePanel } from './RiskPanels';
import { ChangesPanel, DecisionHero, EarlyWarningPanel, MovementPanel, StrikeFinderPanel, useChanges } from './TraderPanels';

/**
 * The Live screen: the three reference designs (docs/image1-3.png) and the
 * single-screen spec, as one decision path --
 *
 *   market → price action → option chain → IV / OI / premium → horizons →
 *   CE / PE / both → strike → risk → P&L → entry → exit
 *
 * One fact, one place. The decision card owns the answer and the clock
 * (entry, window, expiry, time left); the KPI strip owns the market's
 * headline numbers; the left column reads the market (trend, levels,
 * volatility, the tape); the centre is the board (chart, chain, the strike
 * under inspection, what changed, its risk); the right column decides
 * (the outlook by horizon, the sides, the strikes, the checklist). Nothing
 * is shown twice: a figure the checklist judges is not repeated as a row.
 *
 * Every figure is read from the chain response, the perp feed or the desk's
 * own record, or is arithmetic on them (lib/overview.ts); what is not
 * captured is said so. The operator's settings live in one `ScreenConfig`
 * (lib/screen-config.ts) that the context bar shows in full, so it is always
 * visible which configuration the screen is deciding with. Expiry is the
 * selected contract's and is never typed in; entry is now.
 *
 * Nothing here places an order: the button opens the same ticket as the
 * board, and the server runs every gate again.
 */
export function Overview({
  data, trade, expiries, onExpiry, onSell, contracts: deskContracts, leverage = 200, chart, chartTf = '15m', chain = true,
  selected: selectedProp, onSelect, spark, controls, error,
}: {
  data: ChainResponse;
  trade: TradeStatus | null;
  expiries?: readonly ExpiryOption[];
  onExpiry?: (expiry: string) => void;
  /** Opens the order ticket. Absent on a past snapshot. */
  onSell?: (leg: Leg) => void;
  /** The trade size the desk is set to, in contracts, and the ticket's leverage (for the margin estimates). */
  contracts: number;
  leverage?: number;
  /** A price chart for the centre column; none where the screen has its own. */
  chart?: ReactNode;
  /** The chart's timeframe: the price-action panel follows it. */
  chartTf?: ChartTf;
  /** Draw the compact chain. Off where the screen has the full board. */
  chain?: boolean;
  /** The selected strike, when the screen owns it; `null` means the desk's pick. */
  selected?: Selected | null;
  onSelect?: (s: Selected | null) => void;
  /** Recent closes for the spot KPI's sparkline. */
  spark?: readonly number[];
  /** The screen's mode and refresh controls, drawn in the screen bar. */
  controls?: ReactNode;
  /** The last load's error, if the chain on screen is older than it should be. */
  error?: string | null;
}) {
  // A clock for the data-age gate and the status bar, ticking once a second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // The operator's configuration, remembered per browser. See lib/screen-config.ts.
  const [stored, setConfig] = usePersisted<Partial<ScreenConfig>>('live:config', {});
  const config: ScreenConfig = useMemo(() => ({ ...DEFAULT_CONFIG, ...stored }), [stored]);
  const t = useMemo(() => thresholds(config), [config]);
  const contracts = config.contracts ?? deskContracts;

  // The strike under inspection: the desk's own pick until someone clicks
  // another. Owned by the screen when it says so, by these panels otherwise.
  const [ownPicked, setOwnPicked] = useState<Selected | null>(null);
  const picked = onSelect ? selectedProp ?? null : ownPicked;
  const setPicked = onSelect ?? setOwnPicked;

  const snap = data.snapshot;
  const iv = ivRv(data.structure.atmIv, data.market?.realisedVol ?? null);
  // To settlement, by IV: what every strike's distance and tail is measured in.
  const emSettle = useMemo(() => expectedMove(snap), [snap]);
  const spot = data.market?.spot ?? snap.spot;

  // The perpetual (funding, book, the hour's flow, OI acceleration) every five
  // seconds; the term structure and the ranks once a minute -- they move slowly.
  const { data: perp } = usePoll(() => getPerp(60, snap.expiry), 5_000, { enabled: snap.live, deps: [snap.expiry] });
  const skewPts = useMemo(() => skew(data.legs, data.structure.atmIv).putCallPts, [data.legs, data.structure.atmIv]);
  const atmIv = data.structure.atmIv;
  const { data: term, error: termError } = usePoll(() => getTerm(skewPts, atmIv), 60_000, { deps: [skewPts === null, atmIv === null] });

  // The sides, gate by gate, then the side the desk would take.
  const heldShort = trade ? trade.open.reduce((a, x) => a + Math.max(0, -x.position), 0) : 0;
  const tradeLimits = useMemo(() => (trade ? {
    maxSpreadPct: trade.limits.maxSpreadPct, maxShortContracts: trade.limits.maxShortContracts, maxDailyLossUsd: trade.limits.maxDailyLossUsd,
    heldShort, dayNetUsd: trade.today?.netUsd ?? null, balanceUsd: trade.balanceUsd,
  } : null), [trade, heldShort]);
  const sides: SideAssessment[] = useMemo(() => assessSides(data, iv, emSettle, contracts, leverage).map((s) => {
    const gates = sideGates({
      side: s.side, leg: s.leg, iv, regime: data.market?.regime ?? null, direction: data.direction, outlook: data.outlook,
      maxSpreadPct: tradeLimits?.maxSpreadPct ?? null, tailLossUsd: s.tailLossUsd, maxDailyLossUsd: tradeLimits?.maxDailyLossUsd ?? null,
      marginUsd: s.marginUsd, balanceUsd: tradeLimits?.balanceUsd ?? null, t,
    });
    const allowed = config.sideMode === 'AUTO' || config.sideMode === 'BOTH_ALLOWED' || (config.sideMode === 'CE_ONLY' && s.side === 'CE') || (config.sideMode === 'PE_ONLY' && s.side === 'PE');
    return { ...s, gates, status: allowed ? sideStatusOf(gates, t.softFailsAllowed) : 'NOT PREFERRED', disabledBy: allowed ? null : `Disabled by side mode ${config.sideMode.replace('_', ' ')}` };
  }), [data, iv, emSettle, contracts, leverage, tradeLimits, t, config.sideMode]);
  const both = useMemo(() => assessBoth(data, sides, contracts, leverage, emSettle), [data, sides, contracts, leverage, emSettle]);
  const choice: SideChoice = useMemo(() => {
    const auto = sideSelector(data.market?.regime ?? null, data.outlook, sides[0]!.status, sides[1]!.status);
    if (config.sideMode === 'CE_ONLY') return sides[0]!.status !== 'NOT PREFERRED' ? { side: 'CE', why: 'Side mode CE only; the call side passes' } : { side: 'NO_TRADE', why: 'Side mode CE only, and the call side fails its gates' };
    if (config.sideMode === 'PE_ONLY') return sides[1]!.status !== 'NOT PREFERRED' ? { side: 'PE', why: 'Side mode PE only; the put side passes' } : { side: 'NO_TRADE', why: 'Side mode PE only, and the put side fails its gates' };
    if (config.sideMode === 'BOTH_ALLOWED') return both.status === 'BOTH' ? { side: 'BOTH', why: 'Both sides pass their gates' } : auto;
    return auto;
  }, [data, sides, both.status, config.sideMode]);

  // The default selection follows the desk's side; the operator's click overrides it.
  const deskPick = useMemo<Selected | null>(() => {
    // BOTH reads as the put first: the side the desk sells most; the call is one click away.
    const want = choice.side === 'CE' ? 'CE' : choice.side === 'PE' || choice.side === 'BOTH' ? 'PE' : null;
    const s = want ? sides.find((x) => x.side === want)?.leg : sides.map((x) => x.leg).find((l) => l);
    if (s) return { cp: s.cp, strike: s.strike };
    const p = data.best.pick && !data.best.bestOfNone ? data.best.pick : null;
    return p ? { cp: p.cp, strike: p.strike } : null;
  }, [choice.side, sides, data.best]);
  const selected = picked && findLeg(data.legs, picked) ? picked : deskPick;
  const leg = findLeg(data.legs, selected);

  const risk = useMemo(() => (leg ? riskEngine(leg, data.legs, emSettle, snap.spot, snap.hoursToExpiry, contracts, leverage) : null), [leg, data.legs, emSettle, snap.spot, snap.hoursToExpiry, contracts, leverage]);
  const ready = useMemo(() => readiness({ data, leg, iv, em: emSettle, nowMs: now, contracts, leverage, trade: tradeLimits, risk, t, freshnessMs: config.freshnessSec * 1000 }), [data, leg, iv, emSettle, now, contracts, leverage, tradeLimits, risk, t, config.freshnessSec]);

  const changes = useChanges(data, leg, spot);

  return (
    <div className="ov">
      <SettingsStrip data={data} now={now} config={config} stored={stored} onChange={(patch) => setConfig({ ...stored, ...patch })} onReset={() => setConfig({})}
        choice={choice} contracts={contracts} deskContracts={deskContracts} controls={controls} error={error} />
      <ErrorBoundary where="Decision">
        <DecisionHero data={data} now={now} choice={choice} sides={sides} ready={ready} leg={leg} contracts={contracts} leverage={leverage} onSell={onSell} entryIst={config.entryIst} />
      </ErrorBoundary>
      <ErrorBoundary where="Overview KPIs"><KpiStrip data={data} spot={spot} iv={iv} perp={perp} spark={spark} now={now} /></ErrorBoundary>

      <div className="ov-main">
        <div className="ov-col">
          <ErrorBoundary where="Price action"><PriceActionPanel market={data.market} tf={chartTf} /></ErrorBoundary>
          <ErrorBoundary where="Multi-timeframe"><MtfPanel data={data} activeTf={chartTf} horizonMin={config.horizonMin} /></ErrorBoundary>
          <ErrorBoundary where="Key levels"><KeyLevelsPanel data={data} spot={spot} /></ErrorBoundary>
          <ErrorBoundary where="Volatility"><VolatilityPanel data={data} iv={iv} /></ErrorBoundary>
          <ErrorBoundary where="Trade flow"><TradeFlowPanel perp={perp} market={data.market} /></ErrorBoundary>
          <ErrorBoundary where="Early warning"><EarlyWarningPanel data={data} perp={perp} changes={changes?.rows ?? null} /></ErrorBoundary>
        </div>

        <div className="ov-col">
          {chart}
          {chain && (
            <ErrorBoundary where="Overview chain">
              <ChainPanel data={data} selected={selected} onSelect={setPicked} expiries={expiries} onExpiry={onExpiry} />
            </ErrorBoundary>
          )}
          <ErrorBoundary where="Selected strike">
            <SelectedStrikePanel data={data} leg={leg} em={emSettle} contracts={contracts} ivRank={term?.iv ?? null} momentum={changes?.momentum ?? null} />
          </ErrorBoundary>
          <ErrorBoundary where="What changed"><ChangesPanel leg={leg} rows={changes?.rows ?? null} /></ErrorBoundary>
          <ErrorBoundary where="Risk engine"><RiskEnginePanel leg={leg} risk={risk} contracts={contracts} /></ErrorBoundary>
        </div>

        <div className="ov-col ov-right">
          <ErrorBoundary where="Outlook"><MovementPanel data={data} em={emSettle} activeMin={config.horizonMin} /></ErrorBoundary>
          <ErrorBoundary where="Strategy decision"><StrategyDecisionPanel data={data} sides={sides} both={both} choice={choice} onSelect={setPicked} /></ErrorBoundary>
          <ErrorBoundary where="Strikes">
            <StrikeFinderPanel data={data} onSelect={(cp, strike) => setPicked({ cp, strike })} onSell={onSell} contracts={contracts} leverage={leverage}
              defaultSide={choice.side === 'CE' ? 'C' : choice.side === 'PE' ? 'P' : 'both'} em={emSettle} execution={config.execution} />
          </ErrorBoundary>
          <ErrorBoundary where="Checklist"><ChecklistPanel leg={leg} ready={ready} onSell={onSell} /></ErrorBoundary>
        </div>
      </div>

      <div className="ov-bottom">
        <ErrorBoundary where="IV term structure"><IvTermPanel term={term} error={Boolean(termError)} /></ErrorBoundary>
        <ErrorBoundary where="Skew"><SkewPanel data={data} rank={term?.skew ?? null} /></ErrorBoundary>
      </div>
    </div>
  );
}
