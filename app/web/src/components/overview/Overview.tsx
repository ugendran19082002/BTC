import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import type { Candle, ChainResponse, ExpiryOption, Leg } from '@/types/desk';
import type { TradeStatus } from '@/types/trade';
import { getBreakRisk, getMovement, getPerp, getTerm, type MarketStateResponse } from '@/api/desk';
import { getLive } from '@/api/live';
import type { LiveResponse } from '@/types/live';
import { DeskDashboard } from '@/components/desk-screen/DeskDashboard';
import { usePoll } from '@/hooks/usePoll';
import type { ChartTf } from '@/components/desk/PriceChart';
import {
  assessSides, bestLeg, expectedMove, ivRv, mtfConsensus, optionBias, windowMinutes, sideGates, sideSelector, sideStatusOf, skew,
 type SideAssessment, type SideChoice, type WindowChoice,
} from '@/lib/overview';
import { DEFAULT_CONFIG, thresholds } from '@/lib/screen-config';
import { PanelFold } from './parts';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import {
  FlowPanel, VolatilityPanel,
} from './MarketPanels';
import { findLeg, type Selected } from './DecisionPanels';
import { DecisionCards } from './DecisionCards';
import { SIGNAL_ANCHORS } from './SignalStrip';
import { BreakRiskCard, type WatchedStrike } from './BreakRiskCard';
import { parseOption } from '@/lib/break-risk';
import { ChangesPanel, EarlyWarningPanel, MovementPanel, useChanges } from './TraderPanels';

/**
 * The Live screen: the three reference designs (docs/image1-3.png) and the
 * single-screen spec, as one decision path --
 *
 *   market → price action → option chain → IV / OI / premium → horizons →
 *   CE / PE / both → strike → risk → P&L → entry → exit
 *
 * One fact, one place. The bar owns the clock (entry, window, expiry, time
 * left); the strategy decision owns the answer; the KPI strip owns the market's
 * headline numbers; the left column reads the market (levels,
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
  data, trade, expiries, onExpiry, onSell, contracts: deskContracts, leverage = 200, chart, chartTf = '15m',
  selected: selectedProp, onSelect, pair: pairProp, spark, tick, controls, error,
  bars = [], marketState = null, onTf, signals,
}: {
  data: ChainResponse;
  trade: TradeStatus | null;
  expiries?: readonly ExpiryOption[];
  onExpiry?: (expiry: string) => void;
  signals?: ReactNode;
  /** Opens the order ticket. Absent on a past snapshot. */
  onSell?: (leg: Leg) => void;
  /** The trade size the desk is set to, in contracts, and the ticket's leverage (for the margin estimates). */
  contracts: number;
  leverage?: number;
  chart?: ReactNode | ((slots: { expiry: ReactNode; options: ReactNode }) => ReactNode);
  /** The chart's timeframe: the price-action panel follows it. */
  chartTf?: ChartTf;
  /** The selected strike, when the screen owns it; `null` means the desk's pick. */
  selected?: Selected | null;
  onSelect?: (s: Selected | null) => void;
  /** The CE and PE chosen, when the screen keeps them; otherwise these panels remember their own. */
  pair?: { C: number | null; P: number | null } | null;
  /** Recent closes for the spot KPI's sparkline. */
  spark?: readonly number[];
  tick?: number | null;
  /** The screen's mode and refresh controls, drawn in the screen bar. */
  controls?: ReactNode;
  /** The last load's error, if the chain on screen is older than it should be. */
  error?: string | null;
  bars?: readonly Candle[];
  marketState?: MarketStateResponse | null;
  onTf?: (tf: ChartTf) => void;
}) {
  // A clock for the data-age gate and the status bar, ticking once a second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const { data: liveData } = usePoll<LiveResponse>(
    () => getLive({ expiry: data.snapshot.expiry }),
    5_000,
    { deps: [data.snapshot.expiry] },
  );

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
  /*
   * The price every figure on this screen is measured from — newest source first
   * (27 Sep 2026).
   *
   * It read `data.market?.spot ?? snap.spot`, which *preferred* the 5-minute
   * candle close over the ticker. Measured live that ran 36.8 points behind, so
   * the KPI strip said 84,358 while the header said 84,403.6 — two prices on one
   * screen, and the stale one feeding the arithmetic.
   *
   * Order now: the 1-second tick the header already polls, then the chain
   * snapshot's own `spot_price` (the option tickers, ~8s), then the 5-minute
   * close as a last resort. Every step down is a step staler, so the fallbacks
   * run in that order and never the other way.
   */
  const spot = tick ?? snap.spot ?? data.market?.spot ?? 0;
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
  // Entry is whenever the trader decides -- now. The only entry the screen measures from is a held position's:
  // its first fill, per strike for What changed, the oldest open one for the price-change table.
  const entryOf = useCallback((symbol: string | null) => {
    const open = (trade?.open ?? []).filter((x) => x.position !== 0 && (symbol === null || x.symbol === symbol));
    const ts = open.flatMap((x) => x.fills.map((f) => f.ts)).filter((v) => v > 0);
    return ts.length ? Math.min(...ts) : null;
  }, [trade?.open]);
  const entryMs = entryOf(null);
  const { data: movement } = usePoll(() => getMovement(entryMs, snap.expiryTs), 30_000, { enabled: snap.live, deps: [entryMs, snap.expiryTs] });
  const { data: term } = usePoll(() => getTerm(skewPts, atmIv), 60_000, { deps: [skewPts === null, atmIv === null] });
  // The hour after a break: read every 30 s, the server's own cache is 30 s too. Live only -- a past date has no current hour.
  const { data: breakRead } = usePoll(() => getBreakRisk(), 30_000, { enabled: snap.live });
  const breakRisk = snap.live ? breakRead?.risk : null;

  // The sides, gate by gate, then the side the desk would take.
  const heldShort = trade ? trade.open.reduce((a, x) => a + Math.max(0, -x.position), 0) : 0;
  const tradeLimits = useMemo(() => (trade ? {
    maxSpreadPct: trade.limits.maxSpreadPct, maxShortContracts: trade.limits.maxShortContracts, maxDailyLossUsd: trade.limits.maxDailyLossUsd,
    heldShort, dayNetUsd: trade.today?.netUsd ?? null, balanceUsd: trade.balanceUsd,
  } : null), [trade, heldShort]);
  // The finder's filters. Left at the desk's own, the cards carry the desk's picks; moved, each card
  // carries the best strike that passes them -- the decision is about what the person is considering.
  // The strike each card judges: the selected strike for its side; for the other side, the desk's pick (or the finder's best once its filters are moved).
  const deskLegOf = useCallback((cp: 'C' | 'P') => data.recommendation.sides.find((x) => x.side === (cp === 'C' ? 'CE' : 'PE'))?.leg ?? bestLeg(data.legs, cp), [data.recommendation, data.legs]);
  const chosenLeg = picked ? findLeg(data.legs, picked) : null;
  const pick = useMemo(() => (cp: 'C' | 'P') => {
    if (chosenLeg && chosenLeg.cp === cp) return chosenLeg;
    const paired = pair[cp] !== null ? data.legs.find((l) => l.cp === cp && l.strike === pair[cp]) ?? null : null;
    if (paired) return paired;
    /*
     * The strike finder is gone (24 Sep 2026), and with it the only way its
     * filters could be changed -- so the branch that picked a strike from them
     * could never be reached and has gone too. The desk's own pick is what is
     * left, which is what it fell back to every time anyway.
     */
    return deskLegOf(cp);
  }, [chosenLeg, pair, data.legs, deskLegOf]);
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

  // Collapse all / expand all: a stamp each press, and what it asked for.
  const [fold] = useState({ stamp: 0, collapsed: false });


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


  // What a move would hurt: the short strikes held, then the desk's picks, each once.
  const watched = useMemo<WatchedStrike[]>(() => {
    const out: WatchedStrike[] = [];
    const add = (w: WatchedStrike) => { if (!out.some((x) => x.cp === w.cp && x.strike === w.strike)) out.push(w); };
    for (const t of trade?.open ?? []) {
      const o = t.position < 0 ? parseOption(t.symbol) : null;
      if (o) add({ ...o, held: true });
    }
    for (const s of sides) if (s.leg) add({ cp: s.leg.cp, strike: s.leg.strike, held: false });
    return out;
  }, [trade?.open, sides]);

  // What changed, for the strike under inspection: one request, every 30 s, with the since-entry row.
  const changes = useChanges(data, leg, spot, leg ? entryOf(`${leg.cp}-BTC-${leg.strike}-${snap.expiry}`) : null);
  // The other chosen strike, so What changed shows the pair; one request each, and none when it is the same strike.
  const otherLeg = useMemo(() => { const cp = leg?.cp === 'C' ? 'P' : 'C'; const k = pair[cp]; return k === null ? null : data.legs.find((l) => l.cp === cp && l.strike === k) ?? null; }, [leg?.cp, pair, data.legs]);
  const otherChanges = useChanges(data, otherLeg, spot, otherLeg ? entryOf(`${otherLeg.cp}-BTC-${otherLeg.strike}-${snap.expiry}`) : null);
  // The chosen strikes, CE first, for the panels that show both.
  const chosenPair = useMemo(() => [{ leg, changes }, { leg: otherLeg, changes: otherChanges }].sort((a, b) => (a.leg?.cp === 'C' ? 0 : 1) - (b.leg?.cp === 'C' ? 0 : 1)), [leg, changes, otherLeg, otherChanges]);
  /*
   * What changed opens on the at-the-money CE and PE (26 Sep 2026).
   *
   * Until a strike is chosen it showed the desk's own pick, an out-of-the-money
   * strike whose premium moves a fraction of the ATM's -- the ATM pair is where
   * a change in the market shows first, and the pair the owner asked to see.
   * Choosing a strike on the chain still wins: the panel is about what is
   * being considered. The ATM reads reuse the inspected strike's request when
   * it is the same strike, and ask for nothing once a choice is made.
   */
  const chose = picked !== null || pair.C !== null || pair.P !== null;
  const atmLeg = (cp: 'C' | 'P') => (chose ? null : data.legs.find((l) => l.cp === cp && l.strike === snap.atm) ?? null);
  const atmC = atmLeg('C');
  const atmP = atmLeg('P');
  const same = (a: Leg | null, b: Leg | null) => !!a && !!b && a.cp === b.cp && a.strike === b.strike;
  const atmCChanges = useChanges(data, same(atmC, leg) ? null : atmC, spot, atmC ? entryOf(`C-BTC-${atmC.strike}-${snap.expiry}`) : null);
  const atmPChanges = useChanges(data, same(atmP, leg) ? null : atmP, spot, atmP ? entryOf(`P-BTC-${atmP.strike}-${snap.expiry}`) : null);
  const changedPair = useMemo(() => (chose ? chosenPair : [
    { leg: atmC, changes: same(atmC, leg) ? changes : atmCChanges },
    { leg: atmP, changes: same(atmP, leg) ? changes : atmPChanges },
  ]), [chose, chosenPair, atmC, atmP, leg, changes, atmCChanges, atmPChanges]);

  return (
    <PanelFold.Provider value={fold}>
    <div className="ov">
      {/* 1. Complete Desk Dashboard matching docs/image.png */}
      <DeskDashboard
        data={data}
        liveData={liveData}
        marketState={marketState}
        perp={perp}
        breakRisk={breakRisk}
        bars={bars}
        spot={spot}
        tf={chartTf}
        onTf={onTf ?? (() => {})}
        expiryLabel={snap.expiry ? `${snap.expiry} 17:30 IST` : undefined}
        hoursToExpiry={snap.hoursToExpiry}
        optionBias={bias}
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

      {/* 
        2. Protected Core Trading Panels (DO NOT TOUCH):
           - Signal history (LiveScreen signals) & Big move catch (BreakRiskCard) in 1 row, 2 columns
           - Flow · BTC perpetual & options (FlowPanel)
           - Strategy decision (DecisionCards)
      */}
      <section className="ov-protected-section" aria-label="Core Trading Panels" style={{ marginTop: 24 }}>
        <div className="desk-section-banner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="desk-banner-title">⚡ Big Move Catch &amp; Strategy Decision</span>
            <span className="desk-banner-pill">Active Execution</span>
          </div>
          <span className="desk-banner-subtitle">
            Flow · Decision Gates · Strike Inspections
          </span>
        </div>

        {/* 1 Row, 2 Columns: Signal History (Col 1) and Big Move Risk (Col 2) */}
        <div className="desk-signals-break-grid">
          {signals && (
            <div className="desk-col-signals">
              {signals}
            </div>
          )}
          <div className="desk-col-break">
            {snap.live && (
              <ErrorBoundary where="Big move risk">
                <div className="ov-anchor" id={SIGNAL_ANCHORS.momentum}>
                  <BreakRiskCard risk={breakRisk} now={now} strikes={watched} />
                </div>
              </ErrorBoundary>
            )}
          </div>
        </div>

        <div className="ov-main" style={{ marginTop: 16 }}>
          <div className="ov-col">
            <ErrorBoundary where="Early warning">
              <EarlyWarningPanel data={data} perp={perp} changes={changes?.rows ?? null} />
            </ErrorBoundary>
            <ErrorBoundary where="Volatility">
              <VolatilityPanel data={data} iv={iv} skewRank={term?.skew ?? null} />
            </ErrorBoundary>
          </div>

          <div className="ov-col">
            <ErrorBoundary where="Flow">
              <FlowPanel perp={perp} market={data.market} legs={data.legs} atm={snap.atm} window={flowWindow} onWindow={setFlowWindow} />
            </ErrorBoundary>
            <ErrorBoundary where="What changed">
              <ChangesPanel strikes={changedPair} />
            </ErrorBoundary>
          </div>

          <div className="ov-col ov-right">
            <div className="ov-anchor" id={SIGNAL_ANCHORS.trend} />
            <ErrorBoundary where="Multi-timeframe">
              <MovementPanel data={data} em={emSettle} activeMin={config.horizonMin} mtf={mtf} movement={movement?.rows ?? null} />
            </ErrorBoundary>
            <div className="ov-anchor" id={SIGNAL_ANCHORS.decision} />
            <ErrorBoundary where="Strategy decision">
              <DecisionCards data={data} sides={sides} choice={choice} iv={iv} em={emSettle} mtf={mtf} contracts={contracts} leverage={leverage}
                onSelect={(cp, strike) => setPicked({ cp, strike })} oi={perp?.oi ?? null} selectedCp={leg?.cp ?? null} pair={pair} />
            </ErrorBoundary>
          </div>
        </div>
      </section>
    </div>
    </PanelFold.Provider>
  );
}
