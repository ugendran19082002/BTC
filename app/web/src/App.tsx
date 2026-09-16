import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { Activity, AlertTriangle, BarChart3, Bot, Briefcase, ChevronDown, ListOrdered } from 'lucide-react';
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
import { getTradeStatus } from '@/api/trade';
import { heldLegs } from '@/lib/held';
import { getErrors } from '@/api/errors';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { usePoll } from '@/hooks/usePoll';
import { usePageVisible } from '@/hooks/usePageVisible';
import { MoveSection } from '@/components/desk/MoveSection';
import { TodayPnl } from '@/components/desk/TodayPnl';
import { DateTimePicker, istToEpoch, type IstMoment } from '@/components/research/DateTimePicker';
import { usePersisted } from '@/hooks/usePersisted';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { LoginPage } from '@/components/desk/LoginPage';
import { LivePrice } from '@/components/desk/LivePrice';
import { TODAY_MOVE } from '@/types/desk';
import { tabTitle } from '@/lib/tab-title';
import { pnlTone, signedInr, usdToInr } from '@/lib/format';
import { MarketInsights } from '@/components/desk/MarketInsights';
import { SideVerdict } from '@/components/desk/SideVerdict';
import { SuddenMove } from '@/components/desk/SuddenMove';
import { BestTrade } from '@/components/desk/BestTrade';
import { PriceChart, CHART_TFS, type ChartTf } from '@/components/desk/PriceChart';
import { Select, SelectItem } from '@/components/ui/select';
import { ColumnPicker } from '@/components/chain/ColumnPicker';
import { normalise, normaliseOrder, type ColumnKey, type ColumnState } from '@/components/chain/columns';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Download } from 'lucide-react';
import { toCsv, downloadCsv } from '@/lib/csv';
import { CardLead } from '@/components/ui/card';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Stat, StatDivider } from '@/components/ui/stat';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Metric, Formula } from '@/components/research/Explain';

/*
 * Everything off the Live screen is loaded when it is first opened. The Live
 * screen is what the desk opens on, so a phone downloads only what it needs to
 * show that -- the order ticket, the other tabs and their libraries follow on
 * demand and are cached from then on.
 */
const OrderTicket = lazy(() => import('@/components/trade/OrderTicket').then((m) => ({ default: m.OrderTicket })));
const StrikeAnalysis = lazy(() => import('@/components/desk/StrikeAnalysis').then((m) => ({ default: m.StrikeAnalysis })));
const PositionsCard = lazy(() => import('@/components/trade/PositionsCard').then((m) => ({ default: m.PositionsCard })));
const AccountCard = lazy(() => import('@/components/trade/AccountCard').then((m) => ({ default: m.AccountCard })));
const OrdersPanel = lazy(() => import('@/components/trade/OrdersPanel').then((m) => ({ default: m.OrdersPanel })));
const StrategyPanel = lazy(() => import('@/components/strategy/StrategyPanel').then((m) => ({ default: m.StrategyPanel })));
const ReportPanel = lazy(() => import('@/components/report/ReportPanel').then((m) => ({ default: m.ReportPanel })));
const ErrorLogPanel = lazy(() => import('@/components/layout/ErrorLogPanel').then((m) => ({ default: m.ErrorLogPanel })));

type Tab = 'desk' | 'trade' | 'orders' | 'strategy' | 'pnl' | 'errors';

/** A tab remembered from an older build may no longer exist; it falls back to Live. */
const TABS: readonly Tab[] = ['desk', 'trade', 'orders', 'strategy', 'pnl', 'errors'];
const asTab = (v: string): Tab => (TABS as readonly string[]).includes(v) ? (v as Tab) : 'desk';

const REFRESH_SECONDS = 5;
// The expiry list changes once a day, at settlement.
const EXPIRY_RECHECK_SECONDS = 60;

/** Wider than a phone. Long cards and the settings start open here, folded on a phone. */
const WIDE = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(min-width: 761px)').matches;

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', hour12: true,
});

/** Always India time, and always says so: the strategy is defined in IST. */
function istLabel(epochSeconds: number): string {
  return IST_FMT.format(new Date(epochSeconds * 1000)).replace(/,/g, '') + ' IST';
}

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
  const activeExpiry = (expiry && expiries.some((e) => e.expiry === expiry)) ? expiry : defaultExpiry;
  const [width] = usePersisted('width', 20);
  const [storedCols, setCols] = usePersisted<Partial<ColumnState> | null>('chain:columns', null);
  // Where each column sits, kept beside which ones show. Both are preferences
  // about this person's board, so both live as long as the browser does.
  const [storedOrder, setOrder] = usePersisted<ColumnKey[] | null>('chain:column-order', null);
  // A choice stored by an older build may not name every column this one has.
  const chainColumns = normalise(storedCols);
  const chainOrder = normaliseOrder(storedOrder);
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
  const [shockWindow, setShockWindow] = usePersisted('shock:window', 5);
  const [storedTf, setChartTf] = usePersisted<ChartTf>('chart:tf', '5m');
  // A timeframe remembered from an older build may no longer be offered.
  const chartTf = CHART_TFS.includes(storedTf) ? storedTf : '5m';
  // A strike is a leg plus an open flag, the same shape as the ticket: the sheet
  // animates closed with its contents still on screen.
  const [inspecting, setInspecting] = useState<{ cp: 'C' | 'P'; strike: number } | null>(null);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = usePersisted<boolean>('open:settings', WIDE);
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
      const r = await getChain(at, width, minPremium, hedgeGap, lots, expiry || undefined, requireHedge, mode, safetyBar / 100);
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
  }, [live, when, width, minPremium, hedgeGap, lots, expiry, requireHedge, mode, safetyBar]);

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

  // Positions and the price tick once a second on their own clock, so they keep
  // moving even while a chain fetch is slow or failing. The server caches the
  // exchange calls for just under a second, so this stays cheap.
  const { data: trade, refresh: refreshTrade } = usePoll(getTradeStatus, 1_000, { enabled: signedIn === true });
  const { data: errors } = usePoll(() => getErrors({ limit: 1 }), 30_000, { enabled: signedIn === true });
  const { data: tick } = usePoll(getSpot, 1_000, { enabled: signedIn === true });
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

  const inspectLeg = useCallback((cp: 'C' | 'P', strike: number) => {
    setInspecting({ cp, strike });
    setInspectOpen(true);
  }, []);

  const snap = data?.snapshot;
  snapRef.current = snap ?? null;

  const held = useMemo(() => heldLegs(trade?.open), [trade?.open]);
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
            One row: the settings and what the board is saying on the left,
            where BTC is against it on the right. They are read together — a
            wall means nothing until you can see how close price is to it.

            The settings live in that column rather than in a bar of their
            own: cut to time and expiry they were a strip of two controls
            across the whole page, and the column beside a chart was short
            by exactly their height. They stay outside the data guard, so a
            chain that 404s can still have its expiry changed.
          */}
          {/*
            Above everything, because it is the one thing on the screen about
            right now rather than about the contract. Quiet on an ordinary
            board — a warning that takes the same room whether or not there is
            anything to warn about is one nobody reads by the end of the week.
          */}
          {data?.shocks?.length && snap ? (
            <SuddenMove
              shocks={data.shocks}
              window={shockWindow}
              onWindow={setShockWindow}
              snap={snap}
              structure={data.structure}
              market={data.market}
            />
          ) : null}

          <div className="board-row">
            <div className="board-left">
              {/* Folded, the summary still says what the numbers below were worked out from. */}
              <Collapsible.Root open={settingsOpen} onOpenChange={setSettingsOpen} className="bar-wrap">
              <Collapsible.Trigger className="bar-toggle">
              <ChevronDown className={`h-3 w-3 flex-none transition-transform ${settingsOpen ? '' : '-rotate-90'}`} />
              <span>Settings</span>
              {!settingsOpen && (
              <span className="bar-summary">
              {live ? 'live' : 'past'}
              {activeExpiry && <> · {activeExpiry}</>}
              </span>
              )}
              </Collapsible.Trigger>
              <Collapsible.Content>
              <div className="bar">
              <div className="field">
              <label>Time</label>
              <Select ariaLabel="when" value={live ? 'live' : 'past'} onValueChange={(v) => setLive(v === 'live')}>
              <SelectItem value="live">Live now</SelectItem>
              <SelectItem value="past">Past date</SelectItem>
              </Select>
              </div>

              {!live && (
              <div className="field wide">
              <label>Date &amp; time (IST)</label>
              <DateTimePicker value={when} onChange={setWhen} maxDate={new Date()} />
              </div>
              )}

              <div className="field wide">
              <label>Expiry</label>
              <Select ariaLabel="expiry" value={activeExpiry} onValueChange={setExpiry}>
              {expiries.length === 0 && <SelectItem value="" disabled>Loading…</SelectItem>}
              {expiries.map((e) => (
              <SelectItem
              key={e.expiry}
              value={e.expiry}
              hint={
              e.isDefault
              ? 'Default — today’s contract'
              : e.isNextEntry
              ? 'The one you would sell at 05:30'
              : e.isDaily
              ? 'Today’s daily contract'
              : 'Not tested'
              }
              >
              {e.isDefault && '★ '}
              {istLabel(e.expiryTs)}
              {' · '}
              {e.hoursAway < 48 ? `in ${e.hoursAway.toFixed(0)}h` : `in ${(e.hoursAway / 24).toFixed(0)} days`}
              </SelectItem>
              ))}
              </Select>
              {expiries.length > 0 && Boolean(expiry && expiry !== defaultExpiry) && (
              <button className="pinned" onClick={forgetExpiry} title="Back to the default expiry">
              Reset to default
              </button>
              )}
              </div>

              <div className="actions">
              <Button onClick={() => void load()} disabled={busy}>
              {busy ? 'Loading…' : 'Refresh'}
              </Button>
              {live && (
              <Button
              variant={autoRefresh ? 'default' : 'outline'}
              onClick={() => setAutoRefresh((v) => !v)}
              title={`Reload the live chain every ${REFRESH_SECONDS} seconds`}
              >
              {autoRefresh ? 'Auto-refresh on' : 'Auto-refresh off'}
              </Button>
              )}
              </div>
              </div>
              </Collapsible.Content>
              </Collapsible.Root>
              {data && snap && (
                <SideVerdict direction={data.direction} containment={data.containment} />
              )}

            </div>

            {/*
              The right-hand column: the chart, and the board's own numbers
              under it.

              Market Insights used to sit in the left column, under the side
              verdict. Once the verdict card arrived that column ran several
              hundred pixels past the chart and left a hole beside it the height
              of a screen -- a two-column layout where one column simply stops.
              The insights also read better here: they are a two-up grid of
              tiles that was being squeezed into a third of the page.
            */}
            <div className="board-right">
              {data && snap && (
                <ErrorBoundary where="Price chart">
                  <PriceChart
                    bars={candles?.bars ?? []}
                    support={data.structure.peOiWall?.strike ?? null}
                    resistance={data.structure.ceOiWall?.strike ?? null}
                    spot={snap.spot}
                    tf={chartTf}
                    onTf={setChartTf}
                    loading={candlesBusy}
                    error={candles?.error}
                  />
                </ErrorBoundary>
              )}

              {data && snap && (
                <MarketInsights
                  structure={data.structure}
                  snap={snap}
                  market={data.market}
                />
              )}
            </div>
          </div>

          {err && <div className="err">{err}</div>}
          {busy && !data && <Loading />}

          {data && snap && (
            <>
              <div className="lead-row">
                <CollapsibleCard
                  id="live"
                  title={snap.live ? 'Market' : 'Past snapshot'}
                  defaultOpen={WIDE}
                  right={
                    (snap.isNextEntry || snap.isDaily)
                      ? <Badge tone="ok">{snap.isNextEntry ? 'Next entry' : 'Today’s daily'}</Badge>
                      : <Badge tone="warn">Not the tested contract</Badge>
                  }
                >
                  <CardLead>{snap.spot.toFixed(1)}</CardLead>

                  <div className="mt-2">
                    <Stat label="Settles" value={istLabel(snap.expiryTs)} />
                    <Stat
                      label="Contract"
                      value={`${snap.expiry} · ${
                        snap.hoursToExpiry < 48
                          ? `${snap.hoursToExpiry.toFixed(1)}h left`
                          : `${(snap.hoursToExpiry / 24).toFixed(0)} days left`
                      }`}
                      tone="dim"
                    />
                    <Stat label="As of" value={istLabel(snap.ts)} tone="dim" />
                    <StatDivider />
                    <Stat label="ATM strike" value={snap.atm.toLocaleString()} />
                  </div>

                  <Metric
                    label="Implied volatility"
                    value={snap.atmIv !== null ? (snap.atmIv * 100).toFixed(1) + '%' : '—'}
                  >
                    <p>How much movement the market is pricing in, per year. Same-day options show a lower number than monthly ones.</p>
                  </Metric>

                  <Metric
                    label="Expected move by expiry"
                    value={snap.expectedMove !== null ? '±$' + snap.expectedMove.toFixed(0) : '—'}
                  >
                    <Formula>
                      spot × volatility × √(hours ÷ 8760)
                      {snap.atmIv !== null && (
                        <>
                          <br />
                          {snap.spot.toFixed(0)} × {(snap.atmIv * 100).toFixed(1)}% × √({snap.hoursToExpiry.toFixed(2)} ÷ 8760)
                          <br />= ±${snap.expectedMove?.toFixed(0)}
                        </>
                      )}
                    </Formula>
                    <p>About a 2-in-3 chance BTC settles inside this range. A strike inside it is not safe.</p>
                    <p className="dim">In 733 days, every losing day moved further than this.</p>
                  </Metric>

                  <Metric
                    label="Expected move %"
                    value={snap.expectedMove !== null ? ((snap.expectedMove / snap.spot) * 100).toFixed(2) + '%' : '—'}
                  >
                    <p>For comparison: winning days moved 0.63% on average, losing days 2.25%.</p>
                  </Metric>

                  {snap.expectedMoveAtEntry !== null && snap.hoursToExpiry > 14 && (
                    <Metric label="Expected move over 12h" value={'±$' + snap.expectedMoveAtEntry.toFixed(0)}>
                      <p>You enter at 05:30 and it settles at 17:30 — about 12 hours. Judge strikes against this one.</p>
                      <Formula>
                        {snap.spot.toFixed(0)} × {snap.atmIv !== null ? (snap.atmIv * 100).toFixed(1) : '—'}% × √(12 ÷ 8760)
                        <br />= ±${snap.expectedMoveAtEntry.toFixed(0)}
                      </Formula>
                    </Metric>
                  )}
                  {data.market && <MoveSection market={data.market} snap={snap} />}
                </CollapsibleCard>

                <BestTrade
                  best={data.best}
                  legs={data.legs}
                  onSell={snap.live ? sellLeg : undefined}
                />
              </div>

              <div className="chain-bar">
                <span className="dim">
                  {data.legs.length} strikes · {snap.step} apart
                  {data.recommendation.ok && data.recommendation.sides.length > 0
                    ? ' · highlighted = desk’s pick'
                    : ' · nothing qualifies today'}
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
                <ChainTable
                  legs={data.legs}
                  snap={snap}
                  sides={data.recommendation.ok ? data.recommendation.sides : []}
                  columns={chainColumns}
                  columnOrder={chainOrder}
                  onSell={openTicket}
                  onInspect={inspectLeg}
                  view={chainView}
                  eligibleOnly={eligibleOnly}
                  maxSpreadPct={trade?.limits.maxSpreadPct}
                  // Only on a live board: "you hold this" on a past snapshot would be about the wrong day.
                  held={snap.live ? held : undefined}
                />
              </ErrorBoundary>
            </>
          )}
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
