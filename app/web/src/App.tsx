import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, BarChart3, Bot, Briefcase, ListChecks, ListOrdered, RefreshCw, SlidersHorizontal,
} from 'lucide-react';
import { NotSignedIn } from '@/api/client';
import { getCandles, getChain, getExpiries, getHealth, getSpot } from '@/api/desk';
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
import { TF_SECONDS, withLiveBar, withLtp } from '@/lib/live-bar';
import { pnlTone, signedInr, usdToInr } from '@/lib/format';
import type { ChartTf } from '@/components/desk/PriceChart';
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
const SignalStrategiesCard = lazy(() => import('@/components/strategy/SignalStrategiesCard').then((m) => ({ default: m.SignalStrategiesCard })));
const StrategyPanel = lazy(() => import('@/components/strategy/StrategyPanel').then((m) => ({ default: m.StrategyPanel })));
const SettingsPanel = lazy(() => import('@/components/desk/SettingsPanel').then((m) => ({ default: m.SettingsPanel })));
const ReportPanel = lazy(() => import('@/components/report/ReportPanel').then((m) => ({ default: m.ReportPanel })));
const MethodReport = lazy(() => import('@/components/report/MethodReport').then((m) => ({ default: m.MethodReport })));
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

/** The timeframes the market-state card offers, which the chart also draws. */
/** One empty list, so "no bars yet" is the same prop every render. */
const NO_BARS: never[] = [];

type Tab = 'desk' | 'trade' | 'orders' | 'strategy' | 'pnl' | 'methods' | 'errors' | 'settings';

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
export const TABS: readonly Tab[] = ['desk', 'trade', 'orders', 'strategy', 'pnl', 'methods', 'settings', 'errors'];
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
  const [allStrikes, setAllStrikes] = usePersisted('chain:show_all_strikes', true);
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
  /*
   * The chart the desk is read on is the 5-minute, always (28 Sep 2026). The
   * other timeframes are read behind it -- 1m trigger, 15m structure, 30m
   * bias, 1H regime, 4H macro -- and shown as its context, not as charts of
   * equal weight to switch between.
   */
  const chartTf: ChartTf = '5m';
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
    const streamSpot = stream.spot;
    const pollSpot = polledTick?.spot ?? null;
    if (streamSpot === null && pollSpot === null) return null;
    if (streamSpot === null) return { spot: pollSpot!, at: polledTick?.at ?? polledTickAt };
    if (pollSpot === null) return { spot: streamSpot, at: stream.spotAt };
    return stream.spotAt !== null && stream.spotAt >= (polledTickAt ?? -Infinity)
      ? { spot: streamSpot, at: stream.spotAt }
      : { spot: pollSpot, at: polledTick?.at ?? polledTickAt };
  }, [stream.spot, stream.spotAt, polledTick?.spot, polledTick?.at, polledTickAt]);
  /*
   * Bars move far more slowly than the book, and the chart is context rather
   * than a price to act on -- so a minute, not the board's five seconds. Only
   * while the Live screen is the one being looked at.
   */
  const { data: candles } = usePoll(
    () => getCandles(chartTf),
    60_000,
    { enabled: signedIn === true && tab === 'desk', deps: [chartTf] },
  );
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

  const distinctStrikes = useMemo(() => {
    if (!data?.legs) return 0;
    return new Set(data.legs.map((l) => l.strike)).size;
  }, [data?.legs]);

  const totalStrikes = useMemo(() => {
    if (!snap?.coverage) return distinctStrikes;
    return snap.coverage.above + snap.coverage.below + 1;
  }, [snap?.coverage, distinctStrikes]);

  const isShowingAllStrikes = allStrikes || (totalStrikes > 0 && distinctStrikes >= totalStrikes);

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
  /*
   * The bars the chart draws, with the forming candle carried to the last
   * traded price (27 Sep 2026).
   *
   * `/api/candles` returns the forming bar as it stood when the request was
   * made, so between polls the newest candle sat still while the ticker moved
   * -- on a 1-hour chart, for minutes. The tick arrives every second, so the
   * bar is finished off here. Display only: `withLtp` never reaches the signal
   * rules, which read closed bars because that is what their measured records
   * were taken on. See lib/live-bar.ts.
   */
  const liveBars = useMemo(
    // `Date.now()` rather than a ticking clock of its own: the tick arrives
    // every second and is a dependency, so this recomputes as often as there is
    // anything new to draw. When the tick stops the bar stops being carried,
    // which is the right behaviour -- a dead feed must not keep painting.
    //
    // The tape first (29 Sep 2026): the stream's `ltp` is the perpetual's own
    // trades, the chart's instrument, with the high, low and volume between
    // ticks. The index spot is the fallback only while the stream is down --
    // it differs from the perp by the basis and refreshes every eight seconds.
    () => {
      const tape = stream.live && stream.ltp ? stream.ltp.bars[chartTf as '1m' | '5m'] ?? null : null;
      return tape
        ? withLiveBar(candles?.bars ?? NO_BARS, tape, TF_SECONDS[chartTf] ?? 0, Date.now())
        : withLtp(candles?.bars ?? NO_BARS, tick?.spot ?? null, TF_SECONDS[chartTf] ?? 0, Date.now());
    },
    [candles?.bars, tick?.spot, chartTf, stream.live, stream.ltp],
  );

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
          <span className="btc-logo sm" aria-hidden="true">₿</span>
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
          {liveSpot !== null && (
            <LivePrice
              spot={liveSpot}
              live={live}
              sinceOpenUsd={sinceOpenUsd}
              sinceOpenPct={sinceOpenPct}
              feed={stream.live ? 'pushed' : 'polling'}
              updatedAt={tick?.at ?? snap?.ts ?? null}
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
        <button className={tab === 'methods' ? 'on' : ''} onClick={() => setTab('methods')}>
          <ListChecks aria-hidden /> <span>Methods</span>
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
        <div className="desk-shell">
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
                selected={focus}
                onSelect={setFocus}
                tick={liveSpot}
                bars={liveBars}
                ltp={stream.live ? stream.ltp : null}
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
              />
            </ErrorBoundary>
          )}

          {/*
            The signal strategies, beside the methods that make the signals
            (2 Oct 2026): the same strategies as the Strategy tab, the ones that
            enter on a signal, with their switches and the last signals taken.
          */}
          <ErrorBoundary where="Signal strategies">
            <SignalStrategiesCard onOpenStrategyTab={() => setTab('strategy')} />
          </ErrorBoundary>

          {/*
            The full board, at the bottom of the Live screen (22 Sep 2026) rather
            than on a tab of its own: every column of every strike, with its own
            controls. A tap on a price opens the same ticket; a tap on a strike
            makes it the one the panels above are about.
          */}
          <section className="live-chain" aria-label="Option chain">
            <div className="desk-section-header">
              <div className="desk-section-title-wrap">
                <div className="desk-section-icon" style={{ background: 'rgba(168, 85, 247, 0.12)', color: '#a855f7' }}>
                  <BarChart3 size={18} />
                </div>
                <div>
                  <h2 className="desk-section-title">Option Chain Board</h2>
                  <span className="desk-section-subtitle">{snap?.expiry ? `${snap.expiry} Expiry` : 'Active Board'} · 27 Columns · Calls &amp; Puts Matrix</span>
                </div>
              </div>
              <div className="desk-section-badges">
                <span className="desk-badge-pill" style={{ background: 'rgba(0, 229, 255, 0.12)', color: '#00e5ff', border: '1px solid rgba(0, 229, 255, 0.3)' }}>
                  ATM: {snap?.atm ? snap.atm.toLocaleString() : '—'}
                </span>
                <span className="desk-badge-pill" style={{ background: 'rgba(255, 255, 255, 0.05)', color: '#94a3b8', border: '1px solid #1e293b' }}>
                  {distinctStrikes > 0 ? `${distinctStrikes} Strikes` : '— Strikes'}
                </span>
                <span className="desk-badge-pill" style={{ background: 'rgba(255, 255, 255, 0.05)', color: '#94a3b8', border: '1px solid #1e293b' }}>
                  {data?.legs ? `${data.legs.length} Contracts` : '— Contracts'}
                </span>
              </div>
            </div>

          {data && snap && (
            <>
              <div className="chain-bar">
                <span className="dim">
                  {isShowingAllStrikes
                    ? `Showing all ${distinctStrikes} strikes (${data.legs.length} contracts) · ${snap.step} apart`
                    : `Showing ${distinctStrikes} of ${totalStrikes} strikes (${data.legs.length} contracts) · ${snap.step} apart`}
                  {data.recommendation.ok && data.recommendation.sides.length > 0
                    ? ' · highlighted = desk’s pick'
                    : ' · nothing qualifies today'}
                  {totalStrikes > width * 2 && (
                    <>
                      {' · '}
                      <button
                        type="button"
                        className="chain-link"
                        aria-pressed={allStrikes}
                        onClick={() => setAllStrikes(!allStrikes)}
                      >
                        {allStrikes
                          ? `showing all strikes · show ±${width} near ATM`
                          : `show all ${totalStrikes} strikes`}
                      </button>
                    </>
                  )}
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
        </div>
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
      ) : tab === 'methods' ? (
        <ErrorBoundary where="Methods report">
          <MethodReport />
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
