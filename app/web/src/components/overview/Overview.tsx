import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChainResponse, ExpiryOption, Leg } from '@/types/desk';
import type { TradeStatus } from '@/types/trade';
import { getMovement, getPerp, getTerm } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import type { ChartTf } from '@/components/desk/PriceChart';
import {
  assessSides, DESK_FILTER, expectedMove, filtersChanged, findStrikes, ivRv, keyLevels, mtfConsensus, namedLevels, optionBias, riskEngine, windowMinutes, sideGates, sideSelector, sideStatusOf, skew,
  type FinderFilter, type SideAssessment, type SideChoice, type WindowChoice,
} from '@/lib/overview';
import { DEFAULT_CONFIG, entryTodayMs, thresholds } from '@/lib/screen-config';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import {
  KeyLevelsPanel, KpiStrip, IvTermPanel, OptionFlowPanel, PriceActionPanel, SkewPanel, TradeFlowPanel, VolatilityPanel,
} from './MarketPanels';
import { ChainPanel, findLeg, MtfTable, SelectedStrikePanel, type Selected } from './DecisionPanels';
import { DecisionCards } from './DecisionCards';
import { ScreenBar } from './ScreenBar';
import { RiskEnginePanel, ScenarioPanel } from './RiskPanels';
import { ChangesPanel, EarlyWarningPanel, MovementPanel, MovementTypePanel, StrikeFinder, useChanges, type ChangesTab } from './TraderPanels';

/**
 * The Live screen: the three reference designs (docs/image1-3.png) and the
 * single-screen spec, as one decision path --
 *
 *   market → price action → option chain → IV / OI / premium → horizons →
 *   CE / PE / both → strike → risk → P&L → entry → exit
 *
 * One fact, one place. The bar owns the clock (entry, window, expiry, time
 * left); the strategy decision owns the answer; the KPI strip owns the market's
 * headline numbers; the left column reads the market (trend, levels,
 * volatility, the tape, the early warning); the centre is the board (chart,
 * the strike under inspection, what changed, its risk and decay, its
 * scenario); the right column decides (horizon and MTF; SELL CE beside
 * SELL PE; then the vol surface). The bottom row
 * is the strike finder. Nothing
 * is shown twice: a figure the checklist judges is not repeated as a row.
 *
 * Every figure is read from the chain response, the perp feed or the desk's
 * own record, or is arithmetic on them (lib/overview.ts); what is not
 * captured is said so. The screen decides with the desk's fixed
 * configuration (lib/screen-config.ts): the gates say their limits as they
 * judge, so it is always visible what the screen is deciding with. Expiry is
 * the selected contract's, picked from the list in the bar; entry is now.
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

  // The desk's configuration: fixed, and shown by the panels that use it. See lib/screen-config.ts.
  const config = DEFAULT_CONFIG;
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
  // The chart's timeframe's ATR, the levels, and the multi-timeframe consensus: read once, shown where they belong.
  const tfRead = useMemo(() => {
    const have = data.market?.timeframes ?? [];
    const nearest: Record<string, string> = { '1m': '5m', '30m': '15m' };
    const use = have.some((t) => t.tf === chartTf) ? chartTf : nearest[chartTf] ?? '15m';
    return have.find((t) => t.tf === use) ?? null;
  }, [data.market, chartTf]);
  const atrUsd = tfRead?.atrPct == null ? null : tfRead.close * tfRead.atrPct / 100;
  const levels = useMemo(() => namedLevels(keyLevels(data.structure, data.market?.high24h ?? null, data.market?.low24h ?? null, data.market?.prevDayHigh ?? null, data.market?.prevDayLow ?? null), spot), [data.structure, data.market, spot]);
  const mtf = useMemo(() => mtfConsensus(data.market, data.outlook), [data.market, data.outlook]);

  // The perpetual (funding, book, the hour's flow, OI acceleration) every five
  // seconds; the term structure and the ranks once a minute -- they move slowly.
  // The tape's window, shared by the perp's flow and the options' flow; the request follows it.
  const [flowWindow, setFlowWindow] = useState<WindowChoice>('1h');
  const flowMin = windowMinutes(flowWindow, now);
  const { data: perp } = usePoll(() => getPerp(flowMin, snap.expiry), 5_000, { enabled: snap.live, deps: [snap.expiry, flowMin] });
  const skewPts = useMemo(() => skew(data.legs, data.structure.atmIv).putCallPts, [data.legs, data.structure.atmIv]);
  const atmIv = data.structure.atmIv;
  // The move's character by window, from the perp's records: every 30 s is plenty for minute-grain reads.
  const { data: movement } = usePoll(getMovement, 30_000, { enabled: snap.live });
  const { data: term, error: termError } = usePoll(() => getTerm(skewPts, atmIv), 60_000, { deps: [skewPts === null, atmIv === null] });

  // The sides, gate by gate, then the side the desk would take.
  const heldShort = trade ? trade.open.reduce((a, x) => a + Math.max(0, -x.position), 0) : 0;
  const tradeLimits = useMemo(() => (trade ? {
    maxSpreadPct: trade.limits.maxSpreadPct, maxShortContracts: trade.limits.maxShortContracts, maxDailyLossUsd: trade.limits.maxDailyLossUsd,
    heldShort, dayNetUsd: trade.today?.netUsd ?? null, balanceUsd: trade.balanceUsd,
  } : null), [trade, heldShort]);
  // The finder's filters. Left at the desk's own, the cards carry the desk's picks; moved, each card
  // carries the best strike that passes them -- the decision is about what the person is considering.
  const [filter, setFilter] = useState<FinderFilter>(DESK_FILTER);
  const pick = useMemo(() => (filtersChanged(filter)
    ? (cp: 'C' | 'P') => findStrikes(data.legs, { ...filter, side: cp, top: 1 })[0] ?? null
    : undefined), [filter, data.legs]);
  const sides: SideAssessment[] = useMemo(() => assessSides(data, iv, emSettle, contracts, leverage, pick).map((s) => {
    const gates = sideGates({
      side: s.side, leg: s.leg, iv, regime: data.market?.regime ?? null, direction: data.direction, outlook: data.outlook,
      maxSpreadPct: tradeLimits?.maxSpreadPct ?? null, tailLossUsd: s.tailLossUsd, maxDailyLossUsd: tradeLimits?.maxDailyLossUsd ?? null,
      marginUsd: s.marginUsd, balanceUsd: tradeLimits?.balanceUsd ?? null, t, mtf,
    });
    const allowed = config.sideMode === 'AUTO' || config.sideMode === 'BOTH_ALLOWED' || (config.sideMode === 'CE_ONLY' && s.side === 'CE') || (config.sideMode === 'PE_ONLY' && s.side === 'PE');
    return { ...s, gates, status: allowed ? sideStatusOf(gates, t.softFailsAllowed) : 'NOT PREFERRED', disabledBy: allowed ? null : `Disabled by side mode ${config.sideMode.replace('_', ' ')}` };
  }), [data, iv, emSettle, contracts, leverage, tradeLimits, t, config.sideMode, pick, mtf]);
  const bias = useMemo(() => optionBias({ legs: data.legs, atm: snap.atm, oi: perp?.oi ?? null, flow: perp?.optionFlow ?? null, sides }), [data.legs, snap.atm, perp, sides]);
  const choice: SideChoice = useMemo(() => {
    const auto = sideSelector(data.market?.regime ?? null, data.outlook, sides[0]!.status, sides[1]!.status, mtf);
    if (config.sideMode === 'CE_ONLY') return sides[0]!.status !== 'NOT PREFERRED' ? { side: 'CE', why: 'Side mode CE only; the call side passes' } : { side: 'NO_TRADE', why: 'Side mode CE only, and the call side fails its gates' };
    if (config.sideMode === 'PE_ONLY') return sides[1]!.status !== 'NOT PREFERRED' ? { side: 'PE', why: 'Side mode PE only; the put side passes' } : { side: 'NO_TRADE', why: 'Side mode PE only, and the put side fails its gates' };
    return auto;
  }, [data, sides, config.sideMode, mtf]);

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

  // What changed, a side at a time: the CE and the PE the decision is about (the selected strike where it is one of them).
  const ceLeg = leg?.cp === 'C' ? leg : sides[0]!.leg;
  const peLeg = leg?.cp === 'P' ? leg : sides[1]!.leg;
  const [changesTab, setChangesTab] = useState<ChangesTab>(leg?.cp === 'P' ? 'PE' : 'CE');
  useEffect(() => { if (leg) setChangesTab(leg.cp === 'P' ? 'PE' : 'CE'); }, [leg?.cp, leg?.strike]); // eslint-disable-line react-hooks/exhaustive-deps
  const entryMs = useMemo(() => { const e = entryTodayMs(config.entryIst, now); return e !== null && e < now ? e : null; }, [config.entryIst, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const ceChanges = useChanges(data, ceLeg, spot, entryMs);
  const peChanges = useChanges(data, peLeg, spot, entryMs);
  const changes = leg?.cp === 'P' ? peChanges : ceChanges;
  const activeChanges = changesTab === 'PE' ? peChanges : ceChanges;

  return (
    <div className="ov">
      <ScreenBar data={data} now={now} freshnessSec={config.freshnessSec} entryIst={config.entryIst} expiries={expiries} onExpiry={onExpiry} controls={controls} error={error} />
      <ErrorBoundary where="Overview KPIs"><KpiStrip data={data} spot={spot} iv={iv} perp={perp} spark={spark} now={now} bias={bias} /></ErrorBoundary>

      <div className="ov-main">
        <div className="ov-col">
          <ErrorBoundary where="Price action"><PriceActionPanel market={data.market} tf={chartTf} levels={levels} spot={spot} /></ErrorBoundary>
          <ErrorBoundary where="Key levels"><KeyLevelsPanel data={data} spot={spot} atrUsd={atrUsd} /></ErrorBoundary>
          <ErrorBoundary where="Volatility"><VolatilityPanel data={data} iv={iv} /></ErrorBoundary>
          <ErrorBoundary where="Trade flow"><TradeFlowPanel perp={perp} market={data.market} window={flowWindow} onWindow={setFlowWindow} /></ErrorBoundary>
          <ErrorBoundary where="Option flow"><OptionFlowPanel perp={perp} legs={data.legs} atm={snap.atm} window={flowWindow} onWindow={setFlowWindow} /></ErrorBoundary>
          <ErrorBoundary where="Early warning"><EarlyWarningPanel data={data} perp={perp} changes={changes?.rows ?? null} /></ErrorBoundary>
        </div>

        <div className="ov-col">
          {chart}
          {chain && (
            <ErrorBoundary where="Overview chain">
              <ChainPanel data={data} selected={selected} onSelect={setPicked} />
            </ErrorBoundary>
          )}
          <ErrorBoundary where="Selected strike">
            <SelectedStrikePanel data={data} leg={leg} em={emSettle} contracts={contracts} ivRank={term?.iv ?? null} momentum={changes?.momentum ?? null} />
          </ErrorBoundary>
          <ErrorBoundary where="What changed"><ChangesPanel tab={changesTab} onTab={setChangesTab} ce={ceLeg} pe={peLeg} board={(changesTab === 'BOARD' ? changes : activeChanges)?.rows ?? null} changes={activeChanges} /></ErrorBoundary>
          <ErrorBoundary where="Risk engine"><RiskEnginePanel leg={leg} risk={risk} contracts={contracts} hoursToExpiry={snap.hoursToExpiry} iv={iv} step={snap.step} /></ErrorBoundary>
          <ErrorBoundary where="Scenario"><ScenarioPanel leg={leg} contracts={contracts} /></ErrorBoundary>
        </div>

        <div className="ov-col ov-right">
          <ErrorBoundary where="Horizon / MTF"><MovementPanel data={data} em={emSettle} activeMin={config.horizonMin} mtf={<MtfTable mtf={mtf} />} /></ErrorBoundary>
          <ErrorBoundary where="Movement type"><MovementTypePanel rows={movement?.rows ?? null} outlook={data.outlook} /></ErrorBoundary>
          <ErrorBoundary where="Strategy decision">
            <DecisionCards data={data} sides={sides} choice={choice} iv={iv} em={emSettle} mtf={mtf} contracts={contracts} leverage={leverage}
              onSelect={(cp, strike) => setPicked({ cp, strike })} oi={perp?.oi ?? null} />
          </ErrorBoundary>
          <ErrorBoundary where="IV term structure"><IvTermPanel term={term} error={Boolean(termError)} /></ErrorBoundary>
          <ErrorBoundary where="Skew"><SkewPanel data={data} rank={term?.skew ?? null} /></ErrorBoundary>
        </div>
      </div>

      <div className="ov-bottom">
        <ErrorBoundary where="Strike finder">
          <StrikeFinder data={data} onSelect={(cp, strike) => setPicked({ cp, strike })} onSell={onSell} contracts={contracts} leverage={leverage}
            defaultSide={choice.side === 'CE' ? 'C' : choice.side === 'PE' ? 'P' : 'both'} em={emSettle} execution={config.execution}
            filter={filter} onFilter={setFilter} rvPct={data.market?.realisedVol ?? null} />
        </ErrorBoundary>
      </div>
    </div>
  );
}
