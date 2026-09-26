import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, BarChart3, Bot, Briefcase, ListOrdered, RefreshCw, SlidersHorizontal,
} from 'lucide-react';
import { NotSignedIn } from '@/api/client';
import { getCandles, getChain, getExpiries, getHealth, getMarketState, getSpot, getStateHistory } from '@/api/desk';
import { getMe, type Stage } from '@/api/session';
import { ProfileMenu } from '@/components/auth/ProfileMenu';
import { TwoStepSetup } from '@/components/auth/TwoStepSetup';
import type { ChainResponse, ExpiryOption, Leg } from '@/types/desk';
import { ChainTable, type ChainSellIntent } from '@/components/chain/ChainTable';
import type { TicketSeed } from '@/components/trade/OrderTicket';
import { AlarmBanner } from '@/components/trade/ModeBanner';
import { ModeSwitch } from '@/components/trade/ModeSwitch';
import { AlertSwitch } from '@/components/trade/AlertSwitch';
import { getTradeStatus } from '@/api/trade';
import { heldLegs, type HeldLeg } from '@/lib/held';
import { getErrors } from '@/api/errors';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import type { Selected } from '@/components/overview/DecisionPanels';
import { usePoll } from '@/hooks/usePoll';
import { usePageVisible } from '@/hooks/usePageVisible';
import { useStream } from '@/hooks/useStream';
import { TodayPnl } from '@/components/desk/TodayPnl';
import { istToEpoch, type IstMoment } from '@/lib/ist-moment';
import { usePersisted } from '@/hooks/usePersisted';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { LoginPage } from '@/components/desk/LoginPage';
import { LivePrice } from '@/components/desk/LivePrice';
import { TODAY_MOVE } from '@/types/desk';
import { tabTitle } from '@/lib/tab-title';
import { pnlTone, signedInr, usdToInr } from '@/lib/format';
import { PriceChart, CHART_TFS, type ChartTf } from '@/components/desk/PriceChart';
import { MarketPanel } from '@/components/desk/MarketPanel';
import { markersFrom, mergeMarkers, patternMarkers } from '@/components/desk/chart-overlay';
import { Select, SelectItem } from '@/components/ui/select';
import { ColumnPicker } from '@/components/chain/ColumnPicker';
import { normalise, normaliseOrder, type ColumnKey, type ColumnState } from '@/components/chain/columns';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Download } from 'lucide-react';
import { toCsv, downloadCsv } from '@/lib/csv';
import { Button } from '@/components/ui/button';

/*
 * Everything off the Live screen is loaded when it is first opened. The Live
 * screen is what the desk opens on, so a phone downloads only what it needs to
 * show that -- the order ticket, the other tabs and their libraries follow on
 * demand and are cached from then on.
 */
const Overview = lazy(() => import('@/components/overview/Overview').then((m) => ({ default: m.Overview })));
const OrderTicket = lazy(() => import('@/components/trade/OrderTicket').then((m) => ({ default: m.OrderTicket })));
const StrikeAnalysis = lazy(() => import('@/components/desk/StrikeAnalysis').then((m) => ({ default: m.StrikeAnalysis })));
const PositionsCard = lazy(() => import('@/components/trade/PositionsCard').then((m) => ({ default: m.PositionsCard })));
const AccountCard = lazy(() => import('@/components/trade/AccountCard').then((m) => ({ default: m.AccountCard })));
const OrdersPanel = lazy(() => import('@/components/trade/OrdersPanel').then((m) => ({ default: m.OrdersPanel })));
const StrategyPanel = lazy(() => import('@/components/strategy/StrategyPanel').then((m) => ({ default: m.StrategyPanel })));
const SettingsPanel = lazy(() => import('@/components/desk/SettingsPanel').then((m) => ({ default: m.SettingsPanel })));
const ReportPanel = lazy(() => import('@/components/report/ReportPanel').then((m) => ({ default: m.ReportPanel })));
const ErrorLogPanel = lazy(() => import('@/components/layout/ErrorLogPanel').then((m) => ({ default: m.ErrorLogPanel })));
// The calendar library is a sixth of the first download and is needed only
// once somebody chooses a past date.
const DateTimePicker = lazy(() => import('@/components/research/DateTimePicker').then((m) => ({ default: m.DateTimePicker })));

/*
 * The board's cards redraw only when the board changes.
 *
 * This component holds the one-second price and position polls, so it renders
 * once a second -- and without these every child rendered with it: seventy
 * rows of chain, nine horizon cards, the chart, all rebuilt to show the same
 * five-second-old board. On a phone that was the lag. Each of these takes its
 * data from the chain response and callbacks that do not change between
 * loads, so the same props mean the same screen and React can skip them.
 * The rest of the props are kept stable below (`sides`, `held`, `reload`).
 */
const Board = memo(ChainTable);
const Chart = memo(PriceChart);

/** The timeframes the market-state card offers, which the chart also draws. */
/** One empty list, so "no bars yet" is the same prop every render. */
const NO_BARS: never[] = [];

type Tab = 'desk' | 'trade' | 'orders' | 'strategy' | 'pnl' | 'errors' | 'settings';

/** Of two answers to the same question, the one that arrived last; either may be missing. */
function newer<T>(a: T | null, aAt: number | null, b: T | null, bAt: number | null): T | null {
  if (a === null || aAt === null) return b;
  if (b === null || bAt === null) return a;
  return bAt > aAt ? b : a;
}

/** A tab remembered from an older build may no longer exist; it falls back to Live. */
/*
 * Every tab, and the type is not enough: this list is what a click is checked
 * against at runtime. Settings was added to the type and to the nav but not to
 * this line on 18 September, so clicking it fell straight back to Live. A tab
 * that exists in three places and not in the fourth is invisible.
 */
export const TABS: readonly Tab[] = ['desk', 'trade', 'orders', 'strategy', 'pnl', 'settings', 'errors'];
export const asTab = (v: string): Tab => (TABS as readonly string[]).includes(v) ? (v as Tab) : 'desk';

const REFRESH_SECONDS = 5;
// The expiry list changes once a day, at settlement.
const EXPIRY_RECHECK_SECONDS = 60;

/** Yesterday at the entry minute — a sensible default for a past date. */
function defaultPast(): IstMoment {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 - 86400_000);
  return { date: d.toISOString().slice(0, 10), time: '05:30' };
}

function loadCachedExpiries(): ExpiryOption[] {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('btc_expiries') : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const Loading = () => <div className="spinner">Loading…</div>;

export default function App() {
  const [storedTab, setTab] = usePersisted<Tab>('tab', 'desk');
  const tab = asTab(storedTab);
  // A ticket is a seed plus an open flag: the sheet animates closed with its contents still on screen.
  const [ticket, setTicket] = useState<TicketSeed | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [live, setLive] = usePersisted('live', true);
  const [when, setWhen] = useState<IstMoment>(defaultPast);
  // Remembered, but only while that expiry is still listed -- a settled contract must not pin the desk.
  const [expiry, setExpiry, forgetExpiry] = usePersisted<string>('expiry', '');
  const [expiries, setExpiries] = useState<ExpiryOption[]>(loadCachedExpiries);
  const defaultExpiry = expiries.find((e) => e.isDefault)?.expiry ?? expiries[0]?.expiry ?? '';
  const [width] = usePersisted('width', 20);
  /*
   * Every strike Delta lists, or the twenty each side the table usually shows.
   *
   * The walls and the summary read the whole board, so a card can name a strike
   * -- "89,000 holds 455k" on 18 September -- that the table never drew. Every
   * strike is the default now, because a strike named on the screen has to be
   * findable on the screen; the narrower view is the option, not the rule.
   */
  const [allStrikes, setAllStrikes] = usePersisted('chain:all', true);
  const shownWidth = allStrikes ? 500 : width;
  const [storedCols, setCols] = usePersisted<Partial<ColumnState> | null>('chain:columns', null);
  // Where each column sits, kept beside which ones show. Both are preferences
  // about this person's board, so both live as long as the browser does.
  const [storedOrder, setOrder] = usePersisted<ColumnKey[] | null>('chain:column-order', null);
  // A choice stored by an older build may not name every column this one has.
  // Memoised so the board sees the same columns until they are actually changed.
  const chainColumns = useMemo(() => normalise(storedCols), [storedCols]);
  const chainOrder = useMemo(() => normaliseOrder(storedOrder), [storedOrder]);
  const [storedView, setChainView] = usePersisted<'calls' | 'puts' | 'both'>('chain:view', 'both');
  const narrow = useMediaQuery('(max-width: 760px)');
  /*
   * One side on a phone, whichever side was last chosen.
   *
   * Both sides is 27 columns, and the strike — the one column you keep your
   * place with — then sits in the middle where nothing can pin it. The stored
   * choice is untouched, so a phone does not quietly rewrite what a desk opens
   * on; this only narrows what is *shown* while the screen is narrow.
   */
  const chainView = narrow && storedView === 'both' ? 'calls' : storedView;
  const [eligibleOnly, setEligibleOnly] = usePersisted('chain:eligible', false);
  /*
   * Strike choice, safety %, premium floor, lots, hedge gap and board width no
   * longer have controls: the settings bar is time and expiry, which is what
   * actually gets changed. The values stay -- the chain request and the
   * expected-value figures are still worked out from them -- at whatever was
   * last chosen, or the tested defaults on a fresh browser.
   */
  /* Which window every sudden-move reading is taken over. The server computes
     all four, so this switches without asking it for anything. */
  const [storedTf, setChartTf] = usePersisted<ChartTf>('chart:tf', '5m');
  // A timeframe remembered from an older build may no longer be offered.
  const chartTf = CHART_TFS.includes(storedTf) ? storedTf : '5m';
  // A strike is a leg plus an open flag, the same shape as the ticket: the sheet
  // animates closed with its contents still on screen.
  const [inspecting, setInspecting] = useState<{ cp: 'C' | 'P'; strike: number } | null>(null);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [minPremium] = usePersisted('minPremium', 15);
  const [mode] = usePersisted<'premium' | 'safety'>('mode', 'premium');
  const [safetyBar] = usePersisted('safetyBar', 98);
  const [hedgeGap] = usePersisted('hedgeGap', 0);
  const [requireHedge] = usePersisted('requireHedge', false);
  const [lots] = usePersisted('lots', 10);
  // The ticket's leverage, read here too so the margin estimates on the Live screen match the ticket.
  const [orderLeverage] = usePersisted('order:leverage', 200);
  // On by default: a live chain that silently goes stale is worse than no chain.
  const [autoRefresh, setAutoRefresh] = usePersisted('autoRefresh', true);
  const visible = usePageVisible();

  const [data, setData] = useState<ChainResponse | null>(null);
  const snapRef = useRef<ChainResponse['snapshot'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState<number | null>(null);
  // null while we are still asking the server whether a login is required
  const [signedIn, setSignedInState] = useState<boolean | null>(null);
  /** Where this browser is in signing in: password, code, first-time setup, or in. */
  const [stage, setStage] = useState<Stage>('none');
  const [username, setUsername] = useState<string | null>(null);
  const refreshMe = useCallback(() => {
    getMe()
      .then((m) => {
        const st: Stage = m.stage ?? (m.signedIn ? 'full' : 'none');
        setStage(st);
        setUsername(m.username);
        setSignedInState(st === 'full');
      })
      .catch(() => { setStage('none'); setSignedInState(false); });
  }, []);
  // Any "not signed in" from a poll re-asks where sign-in stands, rather than guessing.
  const setSignedIn = useCallback((v: boolean) => {
    if (v) refreshMe();
    else { setSignedInState(false); refreshMe(); }
  }, [refreshMe]);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setBusy(true);
    setErr(null);
    try {
      const at = live ? 'now' : new Date(istToEpoch(when) * 1000).toISOString();
      const r = await getChain(at, shownWidth, minPremium, hedgeGap, lots, expiry || undefined, requireHedge, mode, safetyBar / 100);
      // a slow earlier request must not overwrite a newer one
      if (my === seq.current) setData(r);
    } catch (e) {
      if (my === seq.current) {
        if (e instanceof NotSignedIn) {
          setSignedIn(false);
          setErr(null);
        } else {
          setErr((e as Error).message);
        }
        setData(null);
      }
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, [live, when, shownWidth, minPremium, hedgeGap, lots, expiry, requireHedge, mode, safetyBar]);

  useEffect(() => { if (signedIn === true) void load(); }, [signedIn, load]);
  // No way through on an error any more: an unanswered /api/me is not signed in.
  useEffect(() => { refreshMe(); }, [refreshMe]);

  useEffect(() => { getHealth().then((h) => setDays(h.days)).catch(() => setDays(null)); }, []);

  /**
   * The expiry list, re-read on a timer: a page left open overnight must not
   * keep offering a contract that settled hours ago. A pin on a contract that is
   * gone is released.
   */
  const loadExpiries = useCallback(() => {
    getExpiries()
      .then((r) => {
        setExpiries(r.expiries);
        try { sessionStorage.setItem('btc_expiries', JSON.stringify(r.expiries)); } catch {}
        setExpiry((cur) => (cur && !r.expiries.some((e) => e.expiry === cur) ? '' : cur));
      })
      .catch((e) => {
        if (e instanceof NotSignedIn) {
          setSignedIn(false);
          try { sessionStorage.removeItem('btc_expiries'); } catch {}
        } else {
          setExpiries([]);
        }
      });
  }, [setExpiry]);

  // Both timers stop while the page is hidden and pick up again the moment it is back.
  useEffect(() => {
    if (signedIn !== true || !visible) return;
    loadExpiries();
    const id = setInterval(loadExpiries, EXPIRY_RECHECK_SECONDS * 1000);
    return () => clearInterval(id);
  }, [signedIn, visible, loadExpiries]);

  useEffect(() => {
    if (!autoRefresh || !live || signedIn !== true || !visible) return;
    void load();
    const id = setInterval(() => { void load(); }, REFRESH_SECONDS * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, live, signedIn, visible, load]);

  /*
   * Positions and the price, pushed.
   *
   * One stream carries the status and the price the moment either changes.
   * The one-second polls are still here and run only while the stream is not
   * live -- a proxy that buffers, a browser that will not reconnect, a server
   * from before the stream -- so the screen never depends on the push to
   * move. Where both have an answer the newer one wins: a poll run right
   * after a button press must not be overwritten by a frame from a second
   * earlier.
   */
  const stream = useStream(signedIn === true);
  const polls = signedIn === true && !stream.live;
  const { data: polledTrade, updatedAt: polledTradeAt, refresh: refreshTrade } = usePoll(getTradeStatus, 1_000, { enabled: polls });
  const { data: errors } = usePoll(() => getErrors({ limit: 1 }), 30_000, { enabled: signedIn === true });
  const { data: polledTick, updatedAt: polledTickAt } = usePoll(getSpot, 1_000, { enabled: polls });
  const trade = newer(stream.status, stream.statusAt, polledTrade, polledTradeAt);
  const tick = useMemo(() => {
    const spot = newer(stream.spot, stream.spotAt, polledTick?.spot ?? null, polledTickAt);
    return spot === null ? null : { spot };
  }, [stream.spot, stream.spotAt, polledTick?.spot, polledTickAt]);
  /*
   * Bars move far more slowly than the book, and the chart is context rather
   * than a price to act on -- so a minute, not the board's five seconds. Only
   * while the Live screen is the one being looked at.
   */
  const { data: candles, loading: candlesBusy } = usePoll(
    () => getCandles(chartTf),
    60_000,
    { enabled: signedIn === true && tab === 'desk', deps: [chartTf] },
  );
  /*
   * The market state, on the chart's own timeframe.
   *
   * Every 30 seconds: it is read off closed bars, so polling it faster only
   * asks the same question again. The chart's minute timeframe has no state of
   * its own -- a level made of twenty one-minute bars is noise -- so the card
   * reads 5m under it and says which timeframe it is reading.
   */
  /*
   * One row for both: the analysis is read off the chart in front of you --
   * except at one minute, which the state engine does not read. A minute bar
   * has no level worth judging a break against, so the card stays on five
   * minutes and carries its own timeframe badge, which says so.
   */
  const stateTf = chartTf === '1m' ? '5m' : chartTf;
  const { data: marketState } = usePoll(
    () => getMarketState(stateTf),
    30_000,
    { enabled: signedIn === true && tab === 'desk', deps: [stateTf] },
  );
  const { data: stateHistory } = usePoll(
    () => getStateHistory(stateTf, 120),
    120_000,
    { enabled: signedIn === true && tab === 'desk', deps: [stateTf] },
  );

  /*
   * The two bands drawn behind the candles: the same levels the state is
   * judged against, to the same tolerance it breaks them by, so the chart and
   * the card can never disagree about where the level is.
   */
  const chartZones = useMemo(() => {
    const level = marketState?.state.level;
    const atr = marketState?.inputs.atr ?? null;
    if (!level || !atr) return [];
    const band = Math.max(atr * 0.1, 1);
    const out: { from: number; to: number; label: string; tone: 'up' | 'down' }[] = [];
    if (level.resistance !== null) {
      out.push({ from: level.resistance - band, to: level.resistance + band, label: 'Resistance zone', tone: 'up' });
    }
    if (level.support !== null) {
      out.push({ from: level.support - band, to: level.support + band, label: 'Support zone', tone: 'down' });
    }
    return out;
  }, [marketState]);

  /*
   * The flags on the candles: every pattern the desk named, on the bar it was
   * named on, plus the states it called from the journal. The strip under the
   * chart lists the same patterns -- this is where they happened, which is
   * what makes "Bearish Engulfing" mean anything.
   */
  const chartMarkers = useMemo(() => {
    const bars = candles?.bars ?? NO_BARS;
    if (!bars.length) return [];
    const seconds = bars.length > 1 ? bars[1]!.time - bars[0]!.time : 300;
    return mergeMarkers(
      markersFrom(stateHistory?.rows ?? [], seconds),
      patternMarkers(marketState?.patterns.all ?? marketState?.patterns.shown ?? [], bars),
    );
  }, [candles, marketState, stateHistory]);

  /** The two targets drawn off the right edge: the card's plan, on the chart. */
  const chartProjection = useMemo(() => {
    const plans = marketState?.state.plans;
    if (!plans || (!plans.up && !plans.down)) return null;
    return {
      up: plans.up ? { trigger: plans.up.trigger, target1: plans.up.target1 } : null,
      down: plans.down ? { trigger: plans.down.trigger, target1: plans.down.target1 } : null,
      /*
       * No range box on the chart. It said "84,108 – 84,326" in the gutter
       * while the two shaded bands either side of that range were already
       * drawn and labelled with the same two numbers -- the same fact three
       * times, in the most crowded corner of the screen. The card still gives
       * the range in words, where there is room for it.
       */
      range: null,
    };
  }, [marketState]);

  const openTicket = useCallback((i: ChainSellIntent) => {
    if (!snapRef.current) return;
    setTicket({
      symbol: `${i.cp}-BTC-${i.strike}-${snapRef.current.expiry}`,
      side: i.cp === 'C' ? 'CE' : 'PE',
      strike: i.strike,
      expiryTs: snapRef.current.expiryTs,
      bid: i.bid, ask: i.ask, mark: i.mark,
    });
    setTicketOpen(true);
  }, []);

  /** A whole leg, rather than the four fields a tap on a price hands back. */
  const sellLeg = useCallback((l: Leg) => {
    openTicket({ cp: l.cp, strike: l.strike, bid: l.bid, ask: l.ask, mark: l.mark });
  }, [openTicket]);

  /**
   * The board as a spreadsheet.
   *
   * Unformatted numbers, no currency symbols: the point of the download is to
   * do arithmetic on it, and the formatting belongs on the screen. Both sides
   * always, whatever the view is set to — a file that silently held half the
   * board would be the kind of thing nobody notices until they have built a
   * model on it.
   */
  const exportChain = useCallback(() => {
    if (!data || !snapRef.current) return;
    const csv = toCsv(data.legs, [
      { header: 'side', value: (l) => (l.cp === 'C' ? 'CE' : 'PE') },
      { header: 'strike', value: (l) => l.strike },
      { header: 'moneyness', value: (l) => l.moneyness },
      { header: 'otm_pct', value: (l) => l.distancePct?.toFixed(4) },
      { header: 'bid', value: (l) => l.bid },
      { header: 'ask', value: (l) => l.ask },
      { header: 'mark', value: (l) => l.mark },
      { header: 'oi', value: (l) => l.oi },
      { header: 'volume', value: (l) => l.volume },
      { header: 'volume_to_oi', value: (l) => l.ev?.volumeToOi?.toFixed(6) },
      { header: 'delta', value: (l) => l.delta },
      { header: 'iv', value: (l) => l.iv },
      { header: 'expire_worthless_adjusted', value: (l) => l.zero?.adjusted },
      { header: 'expire_worthless_model', value: (l) => l.pOtm },
      { header: 'expected_value_usd', value: (l) => l.ev?.evUsd?.toFixed(6) },
      { header: 'expected_payout_per_btc', value: (l) => l.ev?.payoutPerBtc?.toFixed(6) },
      { header: 'breakeven', value: (l) => l.ev?.breakeven },
      { header: 'signal', value: (l) => l.ev?.signal },
    ]);
    downloadCsv(`btc-chain-${snapRef.current.expiry}.csv`, csv);
  }, [data]);

  // The strike the decision panels are about; null = the desk's own default.
  const [focusStore, setFocusStore] = usePersisted<{ expiry: string; sel: Selected | null; C: number | null; P: number | null }>('live:focus', { expiry: '', sel: null, C: null, P: null });
  const focusExpiry = snapRef.current?.expiry ?? expiry;
  const focus = focusStore.expiry === focusExpiry ? focusStore.sel : null;
  // One strike a side, per expiry: a click sets its side's strike and becomes the one inspected.
  const pair = useMemo(() => (focusStore.expiry === focusExpiry ? { C: focusStore.C, P: focusStore.P } : { C: null, P: null }), [focusStore, focusExpiry]);
  const setFocus = useCallback((sel: Selected | null) => setFocusStore((f) => {
    const base = f.expiry === focusExpiry ? f : { expiry: focusExpiry, sel: null, C: null, P: null };
    return sel ? { ...base, sel, [sel.cp]: sel.strike } : { ...base, sel: null };
  }), [setFocusStore, focusExpiry]);
  const inspectLeg = useCallback((cp: 'C' | 'P', strike: number) => {
    setFocus({ cp, strike });
    setInspecting({ cp, strike });
    setInspectOpen(true);
  }, [setFocus]);

  const snap = data?.snapshot;
  snapRef.current = snap ?? null;
  // The last two hundred closes, for the spot KPI's sparkline.
  const sparkCloses = useMemo(() => (candles?.bars ?? NO_BARS).slice(-200).map((b) => b.close), [candles?.bars]);

  // The positions arrive every second as a new list; the board only needs to
  // hear about them when a held strike, its size or its P&L actually changes.
  const heldKey = useMemo(() => JSON.stringify([...heldLegs(trade?.open)]), [trade?.open]);
  const held = useMemo(() => new Map(JSON.parse(heldKey) as [string, HeldLeg][]), [heldKey]);
  const sides = useMemo(
    () => (data?.recommendation.ok ? data.recommendation.sides : []),
    [data?.recommendation],
  );
  // The chain's move is up to five seconds old; recover the 05:30 price from
  // it and measure the ticking price against that, so the move ticks too.
  const dayMove = data?.market?.moves.find((m) => m.label === TODAY_MOVE) ?? null;
  const openedAt = snap && dayMove?.changeUsd != null ? snap.spot - dayMove.changeUsd : null;
  const liveSpot = tick?.spot ?? snap?.spot ?? null;
  const sinceOpenUsd = openedAt !== null && liveSpot !== null ? liveSpot - openedAt : null;
  const sinceOpenPct = sinceOpenUsd !== null && openedAt ? sinceOpenUsd / openedAt : null;

  // The tab says what the header says, for a glance from another tab.
  const todayNetUsd = trade ? (trade.today?.netUsd ?? (trade.realisedTodayUsd ?? 0) + (trade.unrealisedPnlUsd ?? 0)) : null;
  const todayInr = todayNetUsd === null ? null : pnlTone(todayNetUsd) ? signedInr(usdToInr(todayNetUsd)) : '₹0';
  useEffect(() => {
    document.title = tabTitle({ signedIn: signedIn === true, spot: liveSpot, dayMoveUsd: sinceOpenUsd, todayInr });
  }, [signedIn, liveSpot, sinceOpenUsd, todayInr]);

  if (signedIn === null) return <Loading />;
  if (stage === 'setup') return <TwoStepSetup onDone={() => setSignedIn(true)} onRestart={() => setSignedIn(false)} />;
  if (!signedIn) {
    return (
      <LoginPage
        startAtCode={stage === 'totp'}
        onSignedIn={() => setSignedIn(true)}
        onNeedsSetup={() => setStage('setup')}
      />
    );
  }

  return (
    <div className="app">
      <header className="top">
        <div className="top-row">
          <h1>BTC Desk</h1>
          <span className="sub">
            Delta Exchange India{days !== null && <> · {days} days tested</>}
          </span>
          <div className="top-actions">
            <AlertSwitch status={trade} onChanged={() => void refreshTrade()} />
            <ModeSwitch status={trade} onChanged={() => void refreshTrade()} />
            <ProfileMenu username={username} onSignedOut={() => setSignedIn(false)} />
          </div>
        </div>
        <div className="top-row top-row-2">
          {snap && (
            <LivePrice
              spot={tick?.spot ?? snap.spot}
              live={snap.live}
              sinceOpenUsd={sinceOpenUsd}
              sinceOpenPct={sinceOpenPct}
              feed={stream.live ? 'pushed' : 'polling'}
            />
          )}
          <TodayPnl status={trade} />
        </div>
      </header>

      {trade && trade.open.some((t) => t.alarm) && (
        <div style={{ margin: '0 0 10px' }}>
          <AlarmBanner status={trade} />
        </div>
      )}

      <nav className="tabs" aria-label="Screens">
        <button className={tab === 'desk' ? 'on' : ''} onClick={() => setTab('desk')}>
          <Activity aria-hidden /> <span>Live</span>
        </button>
        <button className={tab === 'trade' ? 'on' : ''} onClick={() => setTab('trade')}>
          <Briefcase aria-hidden /> <span>Positions</span>
          {trade && trade.open.length > 0 && <span className="pip">{trade.open.length}</span>}
        </button>
        <button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>
          <ListOrdered aria-hidden /> <span>Orders</span>
        </button>
        <button className={tab === 'strategy' ? 'on' : ''} onClick={() => setTab('strategy')}>
          <Bot aria-hidden /> <span>Strategy</span>
        </button>
        <button className={tab === 'pnl' ? 'on' : ''} onClick={() => setTab('pnl')}>
          <BarChart3 aria-hidden /> <span>P&L</span>
        </button>
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
          <SlidersHorizontal aria-hidden /> <span>Settings</span>
        </button>
        <button className={tab === 'errors' ? 'on' : ''} onClick={() => setTab('errors')}>
          <AlertTriangle aria-hidden /> <span>Errors</span>
          {errors && errors.summary.unresolved > 0 && (
            <span className="pip pip-bad">{errors.summary.unresolved}</span>
          )}
        </button>
      </nav>

      <Suspense fallback={<Loading />}>
      {tab === 'desk' ? (
        <>
          {/*
            The Live screen: the KPI strip, three columns (market read · chart
            and the selected strike · the decision), and under them the full
            option chain -- once its own tab, now where the strike is chosen.
          */}
          {err && !data && <div className="err">{err}</div>}
          {busy && !data && <Loading />}
          {data && snap && (
            <ErrorBoundary where="Live screen">
              <Overview
                data={data}
                trade={trade}
                expiries={expiries}
                onExpiry={setExpiry}
                onSell={snap.live ? sellLeg : undefined}
                contracts={lots}
                leverage={orderLeverage}
                selected={focus}
                onSelect={setFocus}
                pair={pair}
                spark={sparkCloses}
                error={err}
                controls={
                  <>
                    <Select ariaLabel="when" value={live ? 'live' : 'past'} onValueChange={(v) => setLive(v === 'live')}>
                      <SelectItem value="live">Live now</SelectItem>
                      <SelectItem value="past">Past date</SelectItem>
                    </Select>
                    {!live && (
                      <Suspense fallback={<span className="dim">Loading…</span>}>
                        <DateTimePicker value={when} onChange={setWhen} maxDate={new Date()} />
                      </Suspense>
                    )}
                    {expiries.length > 0 && Boolean(expiry && expiry !== defaultExpiry) && (
                      <button className="pinned" onClick={forgetExpiry} title="Back to the default expiry">Reset expiry</button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
                      <RefreshCw className={busy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
                      {busy ? 'Loading…' : 'Refresh'}
                    </Button>
                    {live && (
                      <Button variant={autoRefresh ? 'default' : 'outline'} size="sm" onClick={() => setAutoRefresh((v) => !v)}
                        title={`Reload the live chain every ${REFRESH_SECONDS} seconds`} aria-pressed={autoRefresh}>
                        <Activity className="h-4 w-4" aria-hidden />
                        {autoRefresh ? 'Auto' : 'Manual'}
                      </Button>
                    )}
                  </>
                }
                chart={(slots) => (
                  <ErrorBoundary where="Price chart">
                    {/*
                      One panel, not four (23 Sep 2026): the candles, the shapes
                      on them, the readings behind those, the sentence and the
                      plan. They are one thought and they now sit in one card,
                      in the order somebody reads them.
                    */}
                    <MarketPanel
                      chart={
                        <Chart
                          bars={candles?.bars ?? NO_BARS}
                          // The wall within reach, not the heaviest on the board: a strike
                          // eleven expected moves away is open interest, not a level.
                          support={data.structure.peOiWallNear?.strike ?? null}
                          resistance={data.structure.ceOiWallNear?.strike ?? null}
                          spot={snap.spot}
                          zones={chartZones}
                          lines={marketState?.lines ?? []}
                          projection={chartProjection}
                          markers={chartMarkers}
                          bias={marketState?.bias ?? null}
                          trend={marketState?.inputs.regime === 'TREND_UP' ? 'UP'
                            : marketState?.inputs.regime === 'TREND_DOWN' ? 'DOWN'
                              : marketState?.inputs.regime ?? null}
                          tf={chartTf}
                          onTf={setChartTf}
                          loading={candlesBusy}
                          error={candles?.error}
                        />
                      }
                      data={marketState ?? null}
                      history={stateHistory?.rows}
                      hitRate={stateHistory?.hitRate}
                      tf={stateTf}
                      spot={snap.spot}
                      ready={live}
                      /*
                       * The expiry read and the options' CE/PE bias, as tabs on
                       * the analysis card. They asked the same question this
                       * card asks -- which way, and how sure -- from the board
                       * instead of the bars, from two more cards in the
                       * right-hand column. Same panels, same inputs, built
                       * where their inputs are; only where they are shown has
                       * changed.
                       */
                      extra={[
                        { label: 'Expiry', node: slots.expiry },
                        { label: 'Options', node: slots.options },
                      ]}
                    />
                  </ErrorBoundary>
                )}
              />
            </ErrorBoundary>
          )}

          {/*
            The full board, at the bottom of the Live screen (22 Sep 2026) rather
            than on a tab of its own: every column of every strike, with its own
            controls. A tap on a price opens the same ticket; a tap on a strike
            makes it the one the panels above are about.
          */}
          <section className="live-chain" aria-label="Option chain">
            <h2 className="live-chain-title">Option chain</h2>

          {data && snap && (
            <>
              <div className="chain-bar">
                <span className="dim">
                  {data.legs.length} strikes · {snap.step} apart
                  {data.recommendation.ok && data.recommendation.sides.length > 0
                    ? ' · highlighted = desk’s pick'
                    : ' · nothing qualifies today'}
                  {' · '}
                  <button
                    type="button"
                    className="chain-link"
                    aria-pressed={allStrikes}
                    onClick={() => setAllStrikes(!allStrikes)}
                  >
                    {allStrikes
                      ? `showing every strike Delta lists · show ${width} each side`
                      : `show all ${snap.coverage.above + snap.coverage.below + 1} strikes`}
                  </button>
                </span>

                <ToggleGroup
                  type="single"
                  value={chainView}
                  onValueChange={(v) => v && setChainView(v as 'calls' | 'puts' | 'both')}
                  aria-label="which side of the board"
                >
                  <ToggleGroupItem value="calls">Calls</ToggleGroupItem>
                  <ToggleGroupItem value="puts">Puts</ToggleGroupItem>
                  <ToggleGroupItem value="both" disabled={narrow} title={narrow ? 'Both sides is 27 columns — too wide for this screen' : undefined}>
                    Both
                  </ToggleGroupItem>
                </ToggleGroup>

                <button
                  type="button"
                  className={`chain-chip${eligibleOnly ? ' on' : ''}`}
                  onClick={() => setEligibleOnly((v) => !v)}
                  aria-pressed={eligibleOnly}
                  title="Hide the strikes the arithmetic refuses outright. Warned-about strikes stay."
                >
                  Eligible only
                </button>

                <button type="button" className="chain-chip" onClick={exportChain} title="Download the whole board as CSV">
                  <Download size={13} aria-hidden /> Export
                </button>

                <ColumnPicker
                  value={chainColumns}
                  onChange={setCols}
                  order={chainOrder}
                  onOrderChange={setOrder}
                />
              </div>
              <ErrorBoundary where="Chain">
                <Board
                  legs={data.legs}
                  snap={snap}
                  sides={sides}
                  columns={chainColumns}
                  columnOrder={chainOrder}
                  onSell={openTicket}
                  onInspect={inspectLeg}
                  focus={focus}
                  pair={pair}
                  onFocus={(cp, strike) => setFocus({ cp, strike })}
                  view={chainView}
                  eligibleOnly={eligibleOnly}
                  maxSpreadPct={trade?.limits.maxSpreadPct}
                  // Only on a live board: "you hold this" on a past snapshot would be about the wrong day.
                  held={snap.live ? held : undefined}
                />
              </ErrorBoundary>
            </>
          )}
          </section>
        </>
      ) : tab === 'trade' ? (
        <div className="flex flex-col gap-3">
          <ErrorBoundary where="Account">
            <AccountCard status={trade} />
          </ErrorBoundary>
          <ErrorBoundary where="Positions">
            <PositionsCard trades={trade?.open ?? []} onChanged={() => void refreshTrade()} />
          </ErrorBoundary>
        </div>
      ) : tab === 'orders' ? (
        <ErrorBoundary where="Orders">
          <OrdersPanel />
        </ErrorBoundary>
      ) : tab === 'strategy' ? (
        <StrategyPanel />
      ) : tab === 'pnl' ? (
        <ErrorBoundary where="Profit and loss">
          <ReportPanel />
        </ErrorBoundary>
      ) : tab === 'settings' ? (
        <ErrorBoundary where="Settings">
          <SettingsPanel />
        </ErrorBoundary>
      ) : (
        <ErrorBoundary where="Error log">
          <ErrorLogPanel />
        </ErrorBoundary>
      )}
      </Suspense>

      {inspecting && snap && (
        <Suspense fallback={null}>
          <StrikeAnalysis
            legs={data?.legs ?? []}
            strike={inspecting.strike}
            side={inspecting.cp}
            snap={snap}
            open={inspectOpen}
            onOpenChange={setInspectOpen}
            onSell={snap.live ? sellLeg : undefined}
          />
        </Suspense>
      )}

      {ticket && (
        <Suspense fallback={null}>
          <OrderTicket
            seed={ticket}
            open={ticketOpen}
            onOpenChange={setTicketOpen}
            onPlaced={() => void refreshTrade()}
            balanceUsd={trade?.balanceUsd ?? null}
          />
        </Suspense>
      )}
    </div>
  );
}
