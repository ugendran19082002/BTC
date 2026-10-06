import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LogOut, RefreshCw } from 'lucide-react';
import { json, NotSignedIn } from '@/api/client';
import { getMe, logout, type Me } from '@/api/session';
import { getAccounts } from '@/api/accounts';
import { getStatusOfAccounts, getTradeStatus } from '@/api/trade';
import { getGlance } from '@/api/glance';
import type { MtmReport } from '@/types/report';
import type { TradeStatus } from '@/types/trade';
import { LoginPage } from '@/components/desk/LoginPage';
import { Card, CardTitle, Note } from '@/components/ui/card';
import { HealthCard } from '@/components/mobile/HealthCard';
import { TodayCard } from '@/components/mobile/TodayCard';
import { PositionCard } from '@/components/mobile/PositionCard';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { positionRisk } from '@/lib/position-risk';
import { ago, duration } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The phone (6 Oct 2026): the desk read at a glance, and nothing that changes it.
 *
 * Signed in view-only, so the server refuses every write this device could send (http/app.ts, `viewRefuses`)
 * -- the screen has no buttons, and a lost phone is not trusted to keep to its screen. Three things, in the
 * order a person away from the desk asks them: is the desk all right, how is today going, and how close is each
 * open position to its stop. Everything polls only while the screen is on, and says how old it is.
 */

/** Positions and the day: the desk's own status is cached at the server for about a second. */
const STATUS_MS = 5_000;
const GLANCE_MS = 15_000;
const MTM_MS = 60_000;
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

  if (me === null) return <Shell><p className="text-muted-foreground">Loading…</p></Shell>;
  if (me.stage === 'setup') {
    return (
      <Shell>
        <Card>
          <CardTitle>Two-step sign-in first</CardTitle>
          <p className="m-0 text-[14px]">Two-step sign-in is not set up yet. Finish it on the full desk, then sign in here.</p>
          <a className="mt-3 text-[14px] text-[var(--accent)]" href="/">Open the full desk</a>
        </Card>
      </Shell>
    );
  }
  if (!me.signedIn) {
    return <LoginPage viewOnly startAtCode={me.stage === 'totp'} onSignedIn={refreshMe} onNeedsSetup={refreshMe} />;
  }
  return <Glance me={me} onSignedOut={refreshMe} />;
}

function Glance({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [choice, setChoice] = usePersisted<Choice>('m-account', 'all');

  const accounts = usePoll(getAccounts, ACCOUNTS_MS);
  const trading = useMemo(
    () => (accounts.data?.accounts ?? []).filter((a) => a.active && a.trading !== false),
    [accounts.data],
  );
  // A remembered account that is no longer trading falls back to every account.
  const shown: Choice = choice !== 'all' && trading.some((a) => a.id === choice) ? choice : 'all';
  const known = accounts.data !== null;

  const status = usePoll<TradeStatus | null>(
    () => (shown !== 'all' ? getTradeStatus(shown) : trading.length <= 1 ? getTradeStatus(trading[0]?.id) : getStatusOfAccounts(trading)),
    STATUS_MS,
    { enabled: known, deps: [shown, trading.map((a) => a.id).join(',')] },
  );
  const glance = usePoll(getGlance, GLANCE_MS);
  const mtm = usePoll(
    () => json<MtmReport>(shown === 'all' ? '/api/report/mtm' : `/api/report/mtm?account=${shown}`),
    MTM_MS,
    { deps: [shown] },
  );

  // Any "not signed in" -- the session expired, or was signed out from the desk -- goes back to the sign-in.
  const lost = [accounts.error, status.error, glance.error, mtm.error].some((e) => e instanceof NotSignedIn);
  useEffect(() => { if (lost) onSignedOut(); }, [lost, onSignedOut]);

  const now = useNow(5_000);
  const stale = status.updatedAt !== null && now - status.updatedAt > STALE_MS;

  const refreshAll = () => { void status.refresh(); void glance.refresh(); void mtm.refresh(); void accounts.refresh(); };
  const signOut = async () => { await logout().catch(() => undefined); onSignedOut(); };

  const s = status.data;
  const perpMark = glance.data?.btc.perpMark ?? null;
  // The riskiest first: anything wrong, then the stop with the least room left.
  const open = useMemo(() => {
    const list = (s?.open ?? []).map((t) => ({ t, r: positionRisk(t, { alarms: s?.alarms, perpMark }) }));
    const room = (x: (typeof list)[number]) => (x.r.stop && Number.isFinite(x.r.stop.pct) ? x.r.stop.pct! : Infinity);
    return list.sort((a, b) => (b.r.problems.length > 0 ? 1 : 0) - (a.r.problems.length > 0 ? 1 : 0) || room(a) - room(b)).map((x) => x.t);
  }, [s, perpMark]);

  return (
    <Shell
      header={
        <div className="flex items-center gap-2">
          <span className="btc-logo sm" aria-hidden="true">₿</span>
          <h1 className="m-0 whitespace-nowrap text-[17px] font-semibold">BTC Desk</h1>
          <span className={cn(
            'whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold',
            s?.mode === 'live' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-muted text-muted-foreground',
          )}>
            {s ? (s.mode === 'live' ? 'LIVE' : 'PAPER') : '…'}
          </span>
          {/* Under 380px the 44px buttons win the room; the footer says the same thing. */}
          <span className="hidden whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground min-[380px]:inline">
            {me.scope === 'view' ? 'View only' : 'Full access'}
          </span>
          <span className="ml-auto flex shrink-0">
            <IconButton label="Refresh now" onClick={refreshAll} spin={status.loading}><RefreshCw className="h-[18px] w-[18px]" /></IconButton>
            <IconButton label="Sign out" onClick={() => void signOut()}><LogOut className="h-[18px] w-[18px]" /></IconButton>
          </span>
        </div>
      }
    >
      {trading.length > 1 && (
        <nav aria-label="Accounts" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <Chip on={shown === 'all'} onClick={() => setChoice('all')}>All accounts</Chip>
          {trading.map((a) => <Chip key={a.id} on={shown === a.id} onClick={() => setChoice(a.id)}>{a.name}</Chip>)}
        </nav>
      )}

      {stale && (
        <div role="alert" className="rounded-md bg-[var(--warn-bg)] px-3 py-2.5 text-[14px] text-[var(--warn)]">
          Not updated for {duration(now - status.updatedAt!)} — the figures below may be old.
          {status.error && !(status.error instanceof NotSignedIn) ? ` (${status.error.message})` : ''}
        </div>
      )}

      <HealthCard glance={glance.data} error={glance.error} />
      <TodayCard status={s} mtm={mtm.data} allAccounts={shown === 'all' && trading.length > 1} />

      <section aria-labelledby="open-heading" className="flex flex-col gap-3">
        <h2 id="open-heading" className="m-0 mt-1 flex items-baseline justify-between text-[15px] font-semibold">
          <span>Open positions{s ? ` · ${s.open.length}` : ''}</span>
          {s?.marginUsedUsd != null && s.walletUsd != null && (
            <span className="text-[12px] font-normal text-muted-foreground tabular-nums">
              margin {Math.round((s.marginUsedUsd / Math.max(s.walletUsd, 1e-9)) * 100)}% of wallet
            </span>
          )}
        </h2>
        {!s ? (
          <Card aria-busy="true"><p className="m-0 text-[14px] text-muted-foreground">Reading positions…</p></Card>
        ) : open.length === 0 ? (
          <Card><p className="m-0 text-[14px] text-muted-foreground">No open positions.</p></Card>
        ) : (
          open.map((t) => (
            <PositionCard key={`${t.account?.id ?? ''}-${t.tradeId}`} trade={t} alarms={s.alarms} perpMark={perpMark} now={now} showAccount={shown === 'all'} />
          ))
        )}
      </section>

      <footer className="pb-2 text-center text-[12px] text-muted-foreground">
        {status.updatedAt !== null && <>Updated {ago(status.updatedAt, now)} · </>}
        {me.scope === 'view'
          ? 'This phone reads only. To trade, use the full desk.'
          : <a className="text-[var(--accent)]" href="/">Open the full desk</a>}
        <Note tone="dim">Refreshes every few seconds while the screen is on; nothing is fetched while it is off.</Note>
      </footer>
    </Shell>
  );
}

/** The page frame: a sticky header clear of the notch, one column, a 16px gutter, nothing wider than a phone needs. */
function Shell({ header, children }: { header?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-[var(--bg)]">
      {header && (
        <header className="sticky top-0 z-10 border-b border-border bg-[var(--bg)]/95 px-4 pb-2.5 pt-[calc(10px+env(safe-area-inset-top))] backdrop-blur">
          <div className="mx-auto max-w-[560px]">{header}</div>
        </header>
      )}
      <main className="mx-auto flex max-w-[560px] flex-col gap-3 px-4 pb-[calc(20px+env(safe-area-inset-bottom))] pt-3 text-[14px]">
        {children}
      </main>
    </div>
  );
}

function IconButton({ label, onClick, spin = false, children }: { label: string; onClick: () => void; spin?: boolean; children: ReactNode }) {
  return (
    <button
      type="button" aria-label={label} title={label} onClick={onClick}
      className={cn(
        'grid h-11 w-11 place-items-center rounded-md border-0 bg-transparent text-muted-foreground active:bg-muted',
        spin && '[&>svg]:animate-spin',
      )}
    >
      {children}
    </button>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button" aria-pressed={on} onClick={onClick}
      className={cn(
        'h-10 shrink-0 rounded-full border px-4 text-[14px] font-medium',
        on ? 'border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-border bg-transparent text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
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
