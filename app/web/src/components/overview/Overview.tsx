import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import type { ChainResponse, ExpiryOption, Leg } from '@/types/desk';
import type { TradeStatus } from '@/types/trade';
import { getMovement, getPerp, getTerm } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import type { ChartTf } from '@/components/desk/PriceChart';
import {
  assessBoth, assessSides, bestLeg, dataFreshness, DESK_FILTER, mustChange, persistence, expectedMove, expiryDirection, filtersChanged, findStrikes, ivRv, keyLevels, mtfConsensus, namedLevels, optionBias, riskEngine, windowMinutes, sideGates, sideSelector, sideStatusOf, skew,
  type FinderFilter, type SideAssessment, type SideChoice, type WindowChoice,
} from '@/lib/overview';
import { DEFAULT_CONFIG, entryTodayMs, thresholds } from '@/lib/screen-config';
import { fmt, PanelFold } from './parts';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import {
  DeskEventsPanel, KeyLevelsPanel, KpiStrip, IvTermPanel, OptionBiasPanel, OptionFlowPanel, PriceActionPanel, PriceChangePanel, SkewPanel, TradeFlowPanel, VolatilityPanel,
} from './MarketPanels';
import { ChainPanel, findLeg, SelectedStrikePanel, type Selected } from './DecisionPanels';
import { DecisionCards } from './DecisionCards';
import { FinalDecision } from './FinalDecision';
import { ScreenBar } from './ScreenBar';
import { RiskEnginePanel } from './RiskPanels';
import { ChangesPanel, EarlyWarningPanel, ExpiryDirectionPanel, MovementPanel, StrikeFinder, useChanges } from './TraderPanels';

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
 * volatility, the options' tape, the early warning); the centre is the board (chart, the perpetual's tape under it,
 * compact chain, the strike under inspection, what changed on the chosen
 * strikes, their risk with stress and decay); the right column decides
 * (expiry direction, the option bias, the one multi-timeframe table, SELL
 * CE beside SELL PE, the vol surface, the strike finder). The final decision strip sits above it all. Nothing
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
  selected: selectedProp, onSelect, pair: pairProp, spark, controls, error,
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
  /** The CE and PE chosen, when the screen keeps them; otherwise these panels remember their own. */
  pair?: { C: number | null; P: number | null } | null;
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
  const [ownPicked, setOwnPicked] = usePersisted<Selected | null>('live:strike', null);
  const picked = onSelect ? selectedProp ?? null : ownPicked;
  // One strike a side: a click on the chain's call half sets the CE, on its put half the PE. The last click is the strike the panels inspect;
  // both sit on the cards and are lit on the chain.
  const snap = data.snapshot;
  // Remembered per expiry: a pair chosen on one contract says nothing about the next one's board.
  const [pairStore, setPairStore] = usePersisted<{ expiry: string; C: number | null; P: number | null }>('live:pair', { expiry: '', C: null, P: null });
  const pair = useMemo(() => pairProp ?? (pairStore.expiry === snap.expiry ? pairStore : { expiry: snap.expiry, C: null, P: null }), [pairProp, pairStore, snap.expiry]);
  const setPicked = useCallback((sel: Selected | null) => {
    (onSelect ?? setOwnPicked)(sel);
    if (sel && !pairProp) setPairStore((p) => ({ ...(p.expiry === snap.expiry ? p : { expiry: snap.expiry, C: null, P: null }), [sel.cp]: sel.strike }));
  }, [onSelect, setPairStore, snap.expiry, pairProp]);

  const iv = ivRv(data.structure.atmIv, data.market?.realisedVol ?? null);
  // To settlement, by IV: what every strike's distance and tail is measured in.
  const emSettle = useMemo(() => expectedMove(snap), [snap]);
  const spot = data.market?.spot ?? snap.spot;
  // The levels and the multi-timeframe consensus: read once, shown where they belong.
  const levels = useMemo(() => namedLevels(keyLevels(data.structure, data.market?.high24h ?? null, data.market?.low24h ?? null, data.market?.prevDayHigh ?? null, data.market?.prevDayLow ?? null), spot), [data.structure, data.market, spot]);
  const mtf = useMemo(() => mtfConsensus(data.market, data.outlook), [data.market, data.outlook]);

  // The perpetual (funding, book, the hour's flow, OI acceleration) every five
  // seconds; the term structure and the ranks once a minute -- they move slowly.
  // The tape's window, shared by the perp's flow and the options' flow; the request follows it.
  const [flowWindow, setFlowWindow] = usePersisted<WindowChoice>('live:flow:window', '1h');
  const flowMin = windowMinutes(flowWindow, now);
  const { data: perp } = usePoll(() => getPerp(flowMin, snap.expiry), 5_000, { enabled: snap.live, deps: [snap.expiry, flowMin] });
  const skewPts = useMemo(() => skew(data.legs, data.structure.atmIv).putCallPts, [data.legs, data.structure.atmIv]);
  const atmIv = data.structure.atmIv;
  // The move's character by window, from the perp's records: every 30 s is plenty for minute-grain reads.
  const entryMs = useMemo(() => { const e = entryTodayMs(config.entryIst, now); return e !== null && e < now ? e : null; }, [config.entryIst, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: movement } = usePoll(() => getMovement(entryMs, snap.expiryTs), 30_000, { enabled: snap.live, deps: [entryMs, snap.expiryTs] });
  const { data: term, error: termError } = usePoll(() => getTerm(skewPts, atmIv), 60_000, { deps: [skewPts === null, atmIv === null] });

  // The sides, gate by gate, then the side the desk would take.
  const heldShort = trade ? trade.open.reduce((a, x) => a + Math.max(0, -x.position), 0) : 0;
  const tradeLimits = useMemo(() => (trade ? {
    maxSpreadPct: trade.limits.maxSpreadPct, maxShortContracts: trade.limits.maxShortContracts, maxDailyLossUsd: trade.limits.maxDailyLossUsd,
    heldShort, dayNetUsd: trade.today?.netUsd ?? null, balanceUsd: trade.balanceUsd,
  } : null), [trade, heldShort]);
  // The finder's filters. Left at the desk's own, the cards carry the desk's picks; moved, each card
  // carries the best strike that passes them -- the decision is about what the person is considering.
  const [filter, setFilter] = usePersisted<FinderFilter>('live:finder:filter', DESK_FILTER);
  // The strike each card judges: the selected strike for its side; for the other side, the desk's pick (or the finder's best once its filters are moved).
  const deskLegOf = useCallback((cp: 'C' | 'P') => data.recommendation.sides.find((x) => x.side === (cp === 'C' ? 'CE' : 'PE'))?.leg ?? bestLeg(data.legs, cp), [data.recommendation, data.legs]);
  const chosenLeg = picked ? findLeg(data.legs, picked) : null;
  const pick = useMemo(() => (cp: 'C' | 'P') => {
    if (chosenLeg && chosenLeg.cp === cp) return chosenLeg;
    const paired = pair[cp] !== null ? data.legs.find((l) => l.cp === cp && l.strike === pair[cp]) ?? null : null;
    if (paired) return paired;
    if (filtersChanged(filter)) return findStrikes(data.legs, { ...filter, side: cp, top: 1 })[0] ?? null;
    return deskLegOf(cp);
  }, [chosenLeg, pair, filter, data.legs, deskLegOf]);
  const sides: SideAssessment[] = useMemo(() => assessSides(data, iv, emSettle, contracts, leverage, pick).map((s) => {
    const gates = sideGates({
      side: s.side, leg: s.leg, iv, regime: data.market?.regime ?? null, direction: data.direction, outlook: data.outlook,
      maxSpreadPct: tradeLimits?.maxSpreadPct ?? null, tailLossUsd: s.tailLossUsd, maxDailyLossUsd: tradeLimits?.maxDailyLossUsd ?? null,
      marginUsd: s.marginUsd, balanceUsd: tradeLimits?.balanceUsd ?? null, t, mtf,
    });
    const allowed = config.sideMode === 'AUTO' || config.sideMode === 'BOTH_ALLOWED' || (config.sideMode === 'CE_ONLY' && s.side === 'CE') || (config.sideMode === 'PE_ONLY' && s.side === 'PE');
    return { ...s, gates, status: allowed ? sideStatusOf(gates, t.softFailsAllowed) : 'NOT PREFERRED', disabledBy: allowed ? null : `Disabled by side mode ${config.sideMode.replace('_', ' ')}` };
  }), [data, iv, emSettle, contracts, leverage, tradeLimits, t, config.sideMode, pick, mtf]);
  // Where this expiry settles against the price now, from the state of the market.
  const direction = useMemo(() => expiryDirection({ spot, atmIv: snap.atmIv, hoursToExpiry: snap.hoursToExpiry, outlook: data.outlook, mtf, movement: movement?.rows ?? null, market: data.market, structure: data.structure, iv, fundingRate: perp?.ticker?.fundingRate ?? null }), [spot, snap.atmIv, snap.hoursToExpiry, data.outlook, mtf, movement, data.market, data.structure, iv, perp?.ticker?.fundingRate]);
  const hoursLeftText = (() => { const ms = Math.max(0, snap.expiryTs * 1000 - now); return ms === 0 ? 'settled' : `${Math.floor(ms / 3_600_000)}h ${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}m`; })();
  const bias = useMemo(() => optionBias({ legs: data.legs, atm: snap.atm, oi: perp?.oi ?? null, flow: perp?.optionFlow ?? null, sides }), [data.legs, snap.atm, perp, sides]);
  const choice: SideChoice = useMemo(() => {
    const auto = sideSelector(data.market?.regime ?? null, data.outlook, sides[0]!.status, sides[1]!.status, mtf);
    if (config.sideMode === 'CE_ONLY') return sides[0]!.status !== 'NOT PREFERRED' ? { side: 'CE', why: 'Side mode CE only; the call side passes' } : { side: 'NO_TRADE', why: 'Side mode CE only, and the call side fails its gates' };
    if (config.sideMode === 'PE_ONLY') return sides[1]!.status !== 'NOT PREFERRED' ? { side: 'PE', why: 'Side mode PE only; the put side passes' } : { side: 'NO_TRADE', why: 'Side mode PE only, and the put side fails its gates' };
    return auto;
  }, [data, sides, config.sideMode, mtf]);

  // Collapse all / expand all, from the bar: a stamp each press, and what it asked for.
  const [fold, setFold] = useState({ stamp: 0, collapsed: false });
  const foldAll = useCallback((collapsed: boolean) => setFold((f) => ({ stamp: f.stamp + 1, collapsed })), []);

  // Signal persistence: the side the desk said on each board, newest last; three in a row make it VALID.
  const [history, setHistory] = useState<SideChoice['side'][]>([]);
  useEffect(() => { setHistory((h) => [...h.slice(-5), choice.side]); }, [snap.ts]); // eslint-disable-line react-hooks/exhaustive-deps
  const persist = useMemo(() => persistence(history.length ? history : [choice.side]), [history, choice.side]);
  const both = useMemo(() => assessBoth(data, sides, contracts, leverage, emSettle), [data, sides, contracts, leverage, emSettle]);
  const ages = useMemo(() => dataFreshness(data.freshness, now, { market: config.freshnessSec * 1000, chain: config.freshnessSec * 1000, oi: 15 * 60_000, model: 7 * 86_400_000 }), [data.freshness, now, config.freshnessSec]);
  // What must change, from the side that came closest.
  const must = useMemo(() => {
    if (choice.side !== 'NO_TRADE') return null;
    const focus = [...sides].sort((a, b) => ((a.gates ?? []).filter((g) => g.ok === false).length) - ((b.gates ?? []).filter((g) => g.ok === false).length))[0] ?? null;
    return mustChange(focus, mtf, t, tradeLimits?.maxSpreadPct ?? null, now, config.entryIst);
  }, [choice.side, sides, mtf, t, tradeLimits, now, config.entryIst]);

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

  // What changed, for the strike under inspection: one request, every 30 s, with the since-entry row.
  const changes = useChanges(data, leg, spot, entryMs);
  // The other chosen strike, so What changed shows the pair; one request each, and none when it is the same strike.
  const otherLeg = useMemo(() => { const cp = leg?.cp === 'C' ? 'P' : 'C'; const k = pair[cp]; return k === null ? null : data.legs.find((l) => l.cp === cp && l.strike === k) ?? null; }, [leg?.cp, pair, data.legs]);
  const otherChanges = useChanges(data, otherLeg, spot, entryMs);
  const otherRisk = useMemo(() => (otherLeg ? riskEngine(otherLeg, data.legs, emSettle, snap.spot, snap.hoursToExpiry, contracts, leverage) : null), [otherLeg, data.legs, emSettle, snap.spot, snap.hoursToExpiry, contracts, leverage]);
  // The chosen strikes, CE first, for the panels that show both.
  const chosenPair = useMemo(() => [{ leg, changes, risk }, { leg: otherLeg, changes: otherChanges, risk: otherRisk }].sort((a, b) => (a.leg?.cp === 'C' ? 0 : 1) - (b.leg?.cp === 'C' ? 0 : 1)), [leg, changes, risk, otherLeg, otherChanges, otherRisk]);

  return (
    <PanelFold.Provider value={fold}>
    <div className="ov">
      <ScreenBar data={data} now={now} freshnessSec={config.freshnessSec} entryIst={config.entryIst} expiries={expiries} onExpiry={onExpiry} controls={controls} error={error} onFoldAll={foldAll} />
      <ErrorBoundary where="Final decision">
        <FinalDecision data={data} sides={sides} both={both} choice={choice} leg={leg} mtf={mtf} persist={persist} freshness={ages} must={must} now={now} onSelect={(cp, strike) => setPicked({ cp, strike })} onSell={onSell} />
      </ErrorBoundary>
      <ErrorBoundary where="Overview KPIs"><KpiStrip data={data} spot={spot} iv={iv} perp={perp} spark={spark} now={now} /></ErrorBoundary>

      <div className="ov-main">
        <div className="ov-col">
          <ErrorBoundary where="Price action"><PriceActionPanel market={data.market} tf={chartTf} levels={levels} spot={spot} /></ErrorBoundary>
          <ErrorBoundary where="Price change"><PriceChangePanel price={movement?.price ?? null} spot={spot} entryIst={config.entryIst} /></ErrorBoundary>
          <ErrorBoundary where="Early warning"><EarlyWarningPanel data={data} perp={perp} changes={changes?.rows ?? null} /></ErrorBoundary>
          <ErrorBoundary where="Volatility"><VolatilityPanel data={data} iv={iv} /></ErrorBoundary>
          <ErrorBoundary where="Option flow"><OptionFlowPanel perp={perp} legs={data.legs} atm={snap.atm} window={flowWindow} onWindow={setFlowWindow} /></ErrorBoundary>
          <ErrorBoundary where="Key levels"><KeyLevelsPanel data={data} spot={spot} emUsd={emSettle?.move ?? null} /></ErrorBoundary>
          <ErrorBoundary where="Desk events"><DeskEventsPanel now={now} expiryTs={snap.expiryTs} entryIst={config.entryIst} /></ErrorBoundary>
        </div>

        <div className="ov-col">
          {chart}
          <ErrorBoundary where="Trade flow"><TradeFlowPanel perp={perp} market={data.market} window={flowWindow} onWindow={setFlowWindow} /></ErrorBoundary>
          {chain && (
            <ErrorBoundary where="Overview chain">
              <ChainPanel data={data} selected={selected} pair={pair} onSelect={setPicked} />
            </ErrorBoundary>
          )}
          <ErrorBoundary where="Selected strike">
            <SelectedStrikePanel data={data} leg={leg} contracts={contracts} iv={iv}
              onChoose={(cp, strike) => setPicked({ cp, strike })}
              options={(() => {
                const out: { key: string; cp: 'C' | 'P'; strike: number; label: string }[] = [];
                for (const cp of ['C', 'P'] as const) {
                  const d = pick(cp);
                  if (d) out.push({ key: `card${cp}`, cp, strike: d.strike, label: `Card · ${fmt.n(d.strike)} ${cp === 'C' ? 'CE' : 'PE'}` });
                  for (const f of findStrikes(data.legs, { ...filter, side: cp, top: 5 })) if (!out.some((o) => o.cp === cp && o.strike === f.strike)) out.push({ key: `f${cp}${f.strike}`, cp, strike: f.strike, label: `Finder · ${fmt.n(f.strike)} ${cp === 'C' ? 'CE' : 'PE'}${f.score === null ? '' : ` (${(f.score * 10).toFixed(1)})`}` });
                }
                return out;
              })()}
              changed={(() => { const r = changes?.rows.find((x) => x.minutes === 60) ?? null; return r ? { oiChange: r.oiChange, oiThen: r.oiThen, ivChangePts: r.ivChangePts } : null; })()} />
          </ErrorBoundary>
          <ErrorBoundary where="What changed"><ChangesPanel strikes={chosenPair} /></ErrorBoundary>
          <ErrorBoundary where="Risk engine"><RiskEnginePanel strikes={chosenPair} contracts={contracts} hoursToExpiry={snap.hoursToExpiry} iv={iv} step={snap.step} /></ErrorBoundary>
        </div>

        <div className="ov-col ov-right">
          <ErrorBoundary where="Expiry direction"><ExpiryDirectionPanel d={direction} hoursLeftText={hoursLeftText} /></ErrorBoundary>
          <ErrorBoundary where="Option bias"><OptionBiasPanel bias={bias} /></ErrorBoundary>
          <ErrorBoundary where="Multi-timeframe"><MovementPanel data={data} em={emSettle} activeMin={config.horizonMin} mtf={mtf} movement={movement?.rows ?? null} /></ErrorBoundary>
          <ErrorBoundary where="Strategy decision">
            <DecisionCards data={data} sides={sides} choice={choice} iv={iv} em={emSettle} mtf={mtf} contracts={contracts} leverage={leverage}
              onSelect={(cp, strike) => setPicked({ cp, strike })} oi={perp?.oi ?? null} selectedCp={leg?.cp ?? null} pair={pair} />
          </ErrorBoundary>
          <ErrorBoundary where="IV term structure"><IvTermPanel term={term} error={Boolean(termError)} /></ErrorBoundary>
          <ErrorBoundary where="Skew"><SkewPanel data={data} rank={term?.skew ?? null} /></ErrorBoundary>
          <ErrorBoundary where="Strike finder">
            <StrikeFinder data={data} onSelect={(cp, strike) => setPicked({ cp, strike })} onSell={onSell} contracts={contracts} leverage={leverage}
              defaultSide={choice.side === 'CE' ? 'C' : choice.side === 'PE' ? 'P' : 'both'} em={emSettle} execution={config.execution}
              filter={filter} onFilter={setFilter} rvPct={data.market?.realisedVol ?? null} />
          </ErrorBoundary>
        </div>
      </div>

    </div>
    </PanelFold.Provider>
  );
}
