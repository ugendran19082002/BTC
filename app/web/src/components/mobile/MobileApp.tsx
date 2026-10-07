import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Bell, Home, IndianRupee, Layers, ListOrdered, Menu, RefreshCw } from 'lucide-react';
import { NotSignedIn } from '@/api/client';
import { getMe, logout, type Me } from '@/api/session';
import { getAccounts } from '@/api/accounts';
import { getStatusOfAccounts, getTradeStatus } from '@/api/trade';
import { getGlance } from '@/api/glance';
import type { TradeStatus } from '@/types/trade';
import { LoginPage } from '@/components/desk/LoginPage';
import { Card, CardTitle } from '@/components/ui/card';
import { TradeDetail } from '@/components/mobile/TradeDetail';
import { Toasts } from '@/components/mobile/Toasts';
import { useTradeToasts } from '@/components/mobile/useTradeToasts';
import { PhoneContext, routeOf, searchOf, type PhoneData, type Route, type Tab } from '@/components/mobile/phone-context';
import { HomeScreen } from '@/components/mobile/screens/HomeScreen';
import { PnlScreen } from '@/components/mobile/screens/PnlScreen';
import { PositionsScreen } from '@/components/mobile/screens/PositionsScreen';
import { OrdersScreen } from '@/components/mobile/screens/OrdersScreen';
import { MoreScreen, SUB_TITLE } from '@/components/mobile/screens/MoreScreen';
import { HistoryScreen } from '@/components/mobile/screens/HistoryScreen';
import { SignalPairsScreen } from '@/components/mobile/screens/SignalPairsScreen';
import { PriceChangeScreen } from '@/components/mobile/screens/PriceChangeScreen';
import { PressureScreen } from '@/components/mobile/screens/PressureScreen';
import { AccountScreen } from '@/components/mobile/screens/AccountScreen';
import { MarketScreen } from '@/components/mobile/screens/MarketScreen';
import { StrategiesScreen } from '@/components/mobile/screens/StrategiesScreen';
import { AlertsScreen } from '@/components/mobile/screens/AlertsScreen';
import { SettingsScreen } from '@/components/mobile/screens/SettingsScreen';
import { Chip, Chips } from '@/components/mobile/parts';
import { usePoll } from '@/hooks/usePoll';
import { useStream } from '@/hooks/useStream';
import { usePersisted } from '@/hooks/usePersisted';
import { phoneAlerts } from '@/lib/phone-alerts';
import { duration } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The phone (6 Oct 2026): the desk read at a glance, and nothing that changes it.
 *
 * Signed in view-only, so the server refuses every write this device could send (http/app.ts, `viewRefuses`)
 * -- the screens have no trading buttons, and a lost phone is not trusted to keep to its screens. Five tabs at the
 * thumb -- Home, P&L, Positions, Orders, More (history, account, market, strategies, alerts, status) -- and any
 * trade's whole story one tap away, or one tap from a Telegram alert (`/m?trade=<id>`). The route lives in the
 * URL, so the phone's back button does what it should. Everything polls only while the screen is on, and says
 * how old it is. No trading logic runs here: the server is the one source of truth.
 */

/** Positions and the day: the desk's own status is cached at the server for about a second. */
const STATUS_MS = 5_000;
const GLANCE_MS = 15_000;
const ACCOUNTS_MS = 60_000;
/** Figures older than this get a banner saying so: an old number on a trading screen reads as a true one. */
const STALE_MS = 20_000;

type Choice = number | 'all';

export default function MobileApp() {
  const [me, setMe] = useState<Me | null>(null);
  const refreshMe = useCallback(() => {
    getMe().then(setMe).catch(() => setMe({ required: true, signedIn: false, username: null, stage: 'none' }));
  }, []);
  useEffect(() => { refreshMe(); }, [refreshMe]);
  usePhoneShell();

  if (me === null) return <Frame><p className="text-muted-foreground">Loading…</p></Frame>;
  if (me.stage === 'setup') {
    return (
      <Frame>
        <Card>
          <CardTitle>Two-step sign-in first</CardTitle>
          <p className="m-0 text-[14px]">Two-step sign-in is not set up yet. Finish it on the full desk, then sign in here.</p>
          <a className="mt-3 text-[14px] text-[var(--accent)]" href="/">Open the full desk</a>
        </Card>
      </Frame>
    );
  }
  if (!me.signedIn) {
    return <LoginPage viewOnly startAtCode={me.stage === 'totp'} onSignedIn={refreshMe} onNeedsSetup={refreshMe} />;
  }
  return <Phone me={me} onSignedOut={refreshMe} />;
}

const TAB_ITEMS: { tab: Tab; label: string; icon: typeof Home }[] = [
  { tab: 'home', label: 'Home', icon: Home },
  { tab: 'pnl', label: 'P&L', icon: IndianRupee },
  { tab: 'positions', label: 'Positions', icon: Layers },
  { tab: 'orders', label: 'Orders', icon: ListOrdered },
  { tab: 'more', label: 'More', icon: Menu },
];
const TAB_TITLE: Record<Tab, string> = { home: 'BTC Desk', pnl: 'P&L', positions: 'Positions', orders: 'Orders', more: 'More' };

function Phone({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [route, setRouteState] = useState<Route>(() => routeOf(window.location.search));
  // The route as of the last change, for `go` to read without being remade on every one.
  const current = useRef(route);
  const setRoute = useCallback((r: Route) => { current.current = r; setRouteState(r); }, []);
  useEffect(() => {
    const back = () => setRoute(routeOf(window.location.search));
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [setRoute]);
  /*
   * Move, and leave a step for the back button. The history is written here, once, and not inside a state updater:
   * React may run an updater twice (it does in development), and each run pushed its own entry (6 Oct 2026 review).
   * Tapping where you already are leaves no step, so Back never seems to do nothing.
   */
  const go = useCallback((to: Partial<Route>) => {
    const cur = current.current;
    const next: Route = {
      tab: to.tab ?? cur.tab,
      sub: to.sub !== undefined ? to.sub : to.tab && to.tab !== cur.tab ? null : cur.sub,
      trade: to.trade !== undefined ? to.trade : null,
    };
    if (next.tab === cur.tab && next.sub === cur.sub && next.trade === cur.trade) return;
    window.history.pushState({ phone: true }, '', `/m${searchOf(next)}`);
    if (next.tab !== cur.tab || next.sub !== cur.sub) window.scrollTo(0, 0);
    setRoute(next);
  }, [setRoute]);
  const openTrade = useCallback((trade: string) => go({ trade }), [go]);
  const closeTrade = useCallback(() => {
    // Opened here: back is where it came from. Opened from a link: there is nothing behind it, so stay on the tab.
    if ((window.history.state as { phone?: boolean } | null)?.phone) window.history.back();
    else { const next = { ...current.current, trade: null }; window.history.replaceState(null, '', `/m${searchOf(next)}`); setRoute(next); }
  }, [setRoute]);

  const [choice, setChoice] = usePersisted<Choice>('m-account', 'all');
  const accounts = usePoll(getAccounts, ACCOUNTS_MS);
  const all = accounts.data?.accounts ?? [];
  const trading = useMemo(() => all.filter((a) => a.active && a.trading !== false), [all]);
  // A remembered account that is no longer trading falls back to every account.
  const shown: Choice = choice !== 'all' && trading.some((a) => a.id === choice) ? choice : 'all';
  const known = accounts.data !== null;

  const status = usePoll<TradeStatus | null>(
    () => (shown !== 'all' ? getTradeStatus(shown) : trading.length <= 1 ? getTradeStatus(trading[0]?.id) : getStatusOfAccounts(trading)),
    STATUS_MS,
    { enabled: known, deps: [shown, trading.map((a) => a.id).join(',')] },
  );
  const glance = usePoll(getGlance, GLANCE_MS);
  // What changed since the last reading, as toasts over whatever screen is open.
  const live = useTradeToasts(status.data?.open, `${shown}|${trading.map((a) => a.id).join(',')}`);
  // The perp's last trade as it prints, for the SL / TGT line of a signal trade: the stream stops with the screen.
  const stream = useStream(true);
  const perpLive = stream.ltp !== null && Date.now() - stream.ltp.at < 30_000;
  // At most twice a second: the perp can print many times in one, and the marker takes 0.7 s to slide anyway.
  const perp = useThrottled(perpLive ? stream.ltp!.price : glance.data?.btc.perpMark ?? null, 500);

  // Any "not signed in" -- the session expired, or was signed out from the desk -- goes back to the sign-in.
  const lost = [accounts.error, status.error, glance.error].some((e) => e instanceof NotSignedIn);
  useEffect(() => { if (lost) onSignedOut(); }, [lost, onSignedOut]);

  const now = useNow(5_000);
  const stale = status.updatedAt !== null && now - status.updatedAt > STALE_MS;
  const refreshAll = () => { void status.refresh(); void glance.refresh(); void accounts.refresh(); };
  const signOut = useCallback(async () => { await logout().catch(() => undefined); onSignedOut(); }, [onSignedOut]);

  const data: PhoneData = {
    me, status: status.data, statusError: status.error, statusAt: status.updatedAt, glance: glance.data, glanceError: glance.error,
    accounts: all, trading, shown, accountParam: shown === 'all' ? null : shown, now, perp, perpLive, go, openTrade,
    signOut: () => void signOut(), onSignedOut,
  };
  const alertCount = phoneAlerts(status.data, glance.data, perp).filter((a) => a.level !== 'green').length;
  const title = route.sub ? SUB_TITLE[route.sub] : TAB_TITLE[route.tab];
  const s = status.data;

  return (
    <PhoneContext.Provider value={data}>
      <Frame
        header={
          <div className="flex items-center gap-2">
            {route.sub ? (
              <button type="button" aria-label="Back to More" onClick={() => go({ tab: 'more', sub: null })} className="-ml-2 grid h-11 w-11 place-items-center rounded-md border-0 bg-transparent text-foreground active:bg-muted">
                <ArrowLeft className="h-5 w-5" />
              </button>
            ) : <span className="btc-logo sm" aria-hidden="true">₿</span>}
            <h1 className="m-0 truncate whitespace-nowrap text-[17px] font-semibold">{title}</h1>
            <span className={cn(
              'whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold',
              s?.mode === 'live' ? 'bg-[var(--up-bg)] text-[var(--up)]' : 'bg-muted text-muted-foreground',
            )}>
              {s ? (s.mode === 'live' ? '● LIVE' : 'PAPER') : '…'}
            </span>
            {/* Under 380px, and on a sub-screen with its back arrow, the title and the 44px buttons win the room; Status says the same thing. */}
            <span className={cn('hidden whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground', !route.sub && 'min-[380px]:inline')}>
              {me.scope === 'view' ? 'View only' : 'Full access'}
            </span>
            <button
              type="button" aria-label="Refresh now" title="Refresh now" onClick={refreshAll}
              className={cn('ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-md border-0 bg-transparent text-muted-foreground active:bg-muted', status.loading && '[&>svg]:animate-spin')}
            >
              <RefreshCw className="h-[18px] w-[18px]" />
            </button>
            <button
              type="button" aria-label={`Alerts${alertCount ? `: ${alertCount}` : ''}`} title="Alerts" onClick={() => go({ tab: 'more', sub: 'alerts' })}
              className="relative -mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-md border-0 bg-transparent text-muted-foreground active:bg-muted"
            >
              <Bell className="h-[19px] w-[19px]" />
              {alertCount > 0 && <span aria-hidden="true" className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full border-2 border-[var(--bg)] bg-[var(--down)]" />}
            </button>
          </div>
        }
        nav={
          <nav aria-label="Screens" className="grid grid-cols-5">
            {TAB_ITEMS.map((t) => {
              const on = route.tab === t.tab;
              const badge = t.tab === 'positions' ? (s?.open.length ?? 0) : t.tab === 'more' ? alertCount : 0;
              return (
                <button
                  key={t.tab} type="button" aria-current={on ? 'page' : undefined} onClick={() => go({ tab: t.tab, sub: null })}
                  className={cn('relative flex h-[58px] flex-col items-center justify-center gap-0.5 border-0 bg-transparent font-[inherit] text-[11.5px]', on ? 'font-semibold text-[var(--up)]' : 'text-muted-foreground')}
                >
                  {on && <span aria-hidden="true" className="absolute top-0 h-[3px] w-8 rounded-b bg-[var(--up)]" />}
                  <t.icon aria-hidden="true" className="h-[22px] w-[22px]" />
                  <span>{t.label}</span>
                  {badge > 0 && (
                    <span className={cn(
                      'absolute left-1/2 top-1.5 ml-2 min-w-[18px] rounded-full px-1 text-center text-[11px] font-semibold leading-[18px]',
                      t.tab === 'more' ? 'bg-[var(--down)] text-white' : 'bg-[var(--panel-3)] text-foreground',
                    )}>
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        }
      >
        {trading.length > 1 && route.tab !== 'more' || (route.tab === 'more' && route.sub && ['history', 'account', 'strategies'].includes(route.sub) && trading.length > 1) ? (
          <Chips label="Accounts">
            <Chip on={shown === 'all'} onClick={() => setChoice('all')}>All accounts</Chip>
            {trading.map((a) => <Chip key={a.id} on={shown === a.id} onClick={() => setChoice(a.id)}>{a.name}</Chip>)}
          </Chips>
        ) : null}

        {stale && (
          <div role="alert" className="rounded-md bg-[var(--warn-bg)] px-3 py-2.5 text-[14px] text-[var(--warn)]">
            Not updated for {duration(now - status.updatedAt!)} — the figures may be old.
            {status.error && !(status.error instanceof NotSignedIn) ? ` (${status.error.message})` : ''}
          </div>
        )}

        {route.tab === 'home' ? <HomeScreen />
          : route.tab === 'pnl' ? <PnlScreen />
            : route.tab === 'positions' ? <PositionsScreen />
              : route.tab === 'orders' ? <OrdersScreen />
                : route.sub === 'history' ? <HistoryScreen />
                  : route.sub === 'pairs' ? <SignalPairsScreen />
                    : route.sub === 'price' ? <PriceChangeScreen />
                      : route.sub === 'pressure' ? <PressureScreen />
                  : route.sub === 'account' ? <AccountScreen />
                    : route.sub === 'market' ? <MarketScreen />
                      : route.sub === 'strategies' ? <StrategiesScreen />
                        : route.sub === 'alerts' ? <AlertsScreen />
                          : route.sub === 'settings' ? <SettingsScreen />
                            : <MoreScreen />}
      </Frame>
      {route.trade && <TradeDetail tradeId={route.trade} onClose={closeTrade} onSignedOut={onSignedOut} />}
      <Toasts toasts={live.toasts} onOpen={(t) => (t.tradeId ? openTrade(t.tradeId) : go({ tab: 'orders', sub: null }))} onDismiss={live.dismiss} />
    </PhoneContext.Provider>
  );
}

/** The page frame: a sticky header clear of the notch, one column with a 16px gutter, the tab bar at the thumb. */
function Frame({ header, nav, children }: { header?: ReactNode; nav?: ReactNode; children: ReactNode }) {
  return (
    <div className="m-phone min-h-[100dvh] bg-[var(--bg)]">
      {header && (
        <header className="sticky top-0 z-10 border-b border-border bg-[var(--bg)]/95 px-4 pb-1.5 pt-[calc(6px+env(safe-area-inset-top))] backdrop-blur">
          <div className="mx-auto max-w-[560px]">{header}</div>
        </header>
      )}
      <main className={cn(
        'mx-auto flex max-w-[560px] flex-col gap-3 px-4 pt-3 text-[14px]',
        nav ? 'pb-[calc(76px+env(safe-area-inset-bottom))]' : 'pb-[calc(20px+env(safe-area-inset-bottom))]',
      )}>
        {children}
      </main>
      {nav && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-[var(--bg)]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
          <div className="mx-auto max-w-[560px]">{nav}</div>
        </div>
      )}
    </div>
  );
}

/** A value that changes often, passed on at most once every `ms`: the newest one always arrives, late at worst. */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = ms - (Date.now() - last.current);
    if (wait <= 0) { last.current = Date.now(); setShown(value); return; }
    const id = setTimeout(() => { last.current = Date.now(); setShown(value); }, wait);
    return () => clearTimeout(id);
  }, [value, ms]);
  return shown;
}

/** The clock, ticking: countdowns and "updated 5 s ago" move without a poll. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/**
 * What makes /m an app on the home screen: its own manifest and icon, the page clear of the notch, and a
 * service worker that caches nothing from the API (public/m-sw.js) -- an old position on a trading screen
 * reads as a true one.
 */
function usePhoneShell() {
  useEffect(() => {
    document.title = 'BTC Desk';
    const added: HTMLElement[] = [];
    const link = (rel: string, href: string) => {
      const el = document.createElement('link');
      el.rel = rel;
      el.href = href;
      document.head.appendChild(el);
      added.push(el);
    };
    link('manifest', '/m-manifest.json');
    link('apple-touch-icon', '/m-icon-192.png');
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const before = viewport?.content ?? null;
    if (viewport) viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/m-sw.js', { scope: '/m' }).catch(() => undefined);
    return () => {
      added.forEach((el) => el.remove());
      if (viewport && before !== null) viewport.content = before;
    };
  }, []);
}
