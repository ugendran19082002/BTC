import { AlertTriangle, ChevronRight } from 'lucide-react';
import { json } from '@/api/client';
import { getOrders, getStats } from '@/api/phone';
import type { MtmReport } from '@/types/report';
import { usePoll } from '@/hooks/usePoll';
import { clock, contractLabel, pct, size } from '@/lib/format';
import { lossBudget, positionRisk } from '@/lib/position-risk';
import { phoneAlerts } from '@/lib/phone-alerts';
import { todayIst } from '@/lib/report';
import { cn } from '@/lib/utils';
import { usePhone } from '@/components/mobile/phone-context';
import { AreaChart, Bar, Empty, ListButton, Panel, Rupees, SidePill } from '@/components/mobile/parts';
import { orderStatusWord } from '@/components/mobile/screens/OrdersScreen';

/**
 * Home (6 Oct 2026): everything in one screen a person needs to know the desk is fine -- today's money, the
 * desk's health, the open positions, the margin, the last order -- each tapping through to its own screen.
 */
export function HomeScreen() {
  const p = usePhone();
  const s = p.status;
  const today = todayIst(p.now);
  const stats = usePoll(() => getStats(today, today, p.accountParam), 60_000, { deps: [today, p.accountParam] });
  const orders = usePoll(() => getOrders(today, today, p.accountParam), 30_000, { deps: [today, p.accountParam] });
  const mtm = usePoll(
    () => json<MtmReport>(p.accountParam === null ? '/api/report/mtm' : `/api/report/mtm?account=${p.accountParam}`),
    60_000, { deps: [p.accountParam] },
  );
  const alerts = phoneAlerts(s, p.glance, p.glance?.btc.perpMark ?? null);
  const net = s ? (s.today?.netUsd ?? (s.realisedTodayUsd ?? 0) + (s.unrealisedPnlUsd ?? 0)) : null;
  const budget = s ? lossBudget(s) : null;
  const latest = orders.data?.trades.slice().sort((a, b) => b.openedAt - a.openedAt)[0] ?? null;
  const o = stats.data?.overall;
  const g = p.glance;
  const reds = alerts.filter((a) => a.level === 'red').length;
  const marginShare = s?.marginUsedUsd != null && s.walletUsd ? s.marginUsedUsd / s.walletUsd : null;
  const samples = mtm.data?.samples ?? [];

  return (
    <>
      <button
        type="button" onClick={() => p.go({ tab: 'more', sub: 'settings' })} aria-label="Desk status: open"
        className="grid grid-cols-4 gap-1.5 border-0 bg-transparent p-0 text-left font-[inherit]"
      >
        <Tile label="Trading" value={s ? (s.mode === 'live' ? 'LIVE' : 'PAPER') : '…'} tone={s?.mode === 'live' ? 'up' : 'dim'} />
        <Tile label="Scheduler" value={g ? (g.readings.schedulerOn ? 'ON' : 'OFF') : '…'} tone={g?.readings.schedulerOn ? 'up' : 'dim'} />
        <Tile label="Price feed" value={g ? (g.boardAgeMs === null ? '—' : g.boardAgeMs < 2_000 ? 'live' : `${Math.round(g.boardAgeMs / 1000)}s`) : '…'} tone={!g || g.boardAgeMs === null || g.boardAgeMs >= 15_000 ? 'warn' : 'up'} />
        <Tile label="API usage" value={g ? `${Math.round(g.readings.delta.usedPct)}%` : '…'} tone={g && g.readings.delta.usedPct >= 80 ? 'warn' : undefined} />
      </button>
      {g && g.health !== 'ok' && (
        <button type="button" onClick={() => p.go({ tab: 'more', sub: 'settings' })}
          className={cn('flex items-center gap-2 rounded-lg border-0 px-3 py-2.5 text-left font-[inherit] text-[13px]', g.health === 'down' ? 'bg-[var(--down-bg)] text-[#ffb3ae]' : 'bg-[var(--warn-bg)] text-[var(--warn)]')}>
          <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{g.issues[0]?.text ?? 'The desk needs a look.'}</span>
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0" />
        </button>
      )}
      {alerts.length > 0 && (
        <button
          type="button" onClick={() => p.go({ tab: 'more', sub: 'alerts' })}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg border px-3 py-3 text-left font-[inherit]',
            reds ? 'border-[var(--down)] bg-[var(--down-bg)] text-[#ffb3ae]' : 'border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn)]',
          )}
        >
          <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-[14px]">
            <b>{alerts.length} alert{alerts.length === 1 ? '' : 's'}</b>
            <span className="block truncate text-[13px] opacity-90">{alerts[0]!.title}{alerts[0]!.detail ? ` · ${alerts[0]!.detail}` : ''}</span>
          </span>
        </button>
      )}

      <Panel>
        <button type="button" onClick={() => p.go({ tab: 'pnl' })} aria-label="Today's P&L: open the P&L" className="flex w-full items-start justify-between gap-3 border-0 bg-transparent p-0 text-left font-[inherit] text-foreground">
          <span className="min-w-0">
            <span className="block text-[13px] text-muted-foreground">Today's P&amp;L</span>
            {s ? <Rupees usd={net} signed size="xl" /> : <span className="text-[28px] text-muted-foreground">…</span>}
          </span>
          <span className="grid shrink-0 grid-cols-2 gap-x-4 text-right">
            <span className="text-[11.5px] text-muted-foreground">Trades</span>
            <span className="text-[11.5px] text-muted-foreground">Win rate</span>
            <span className="text-[16px] font-semibold tabular-nums">{o ? o.trades : '…'}</span>
            <span className="text-[16px] font-semibold tabular-nums">{o?.winRate != null ? pct(o.winRate, 0) : '—'}</span>
          </span>
        </button>
        {samples.length >= 2 ? (
          <div className="mt-2">
            <AreaChart values={samples.map((x) => x.netUsd)} label="Today's P&L, minute by minute" height={88} />
            <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
              <span>{clock(samples[0]!.at)}</span><span>{clock(samples[samples.length - 1]!.at)}</span>
            </div>
          </div>
        ) : null}
        {budget && (
          <div className="mt-2.5">
            <div className="mb-1 flex justify-between text-[12px] text-muted-foreground"><span>Daily loss limit</span><span>{pct(1 - budget.usedPct, 0)} left</span></div>
            <Bar value={budget.usedPct} tone={budget.usedPct >= 0.8 ? 'down' : budget.usedPct >= 0.5 ? 'warn' : 'up'} label="Daily loss limit used" />
          </div>
        )}
      </Panel>

      <Panel title={`Open positions${s ? ` · ${s.open.length}` : ''}`} right={s && s.open.length > 0 ? <button type="button" onClick={() => p.go({ tab: 'positions' })} className="border-0 bg-transparent p-0 font-[inherit] text-[12.5px] text-[var(--accent)]">Risk →</button> : undefined}>
        {!s ? <Empty>Reading positions…</Empty> : s.open.length === 0 ? <Empty>No open positions.</Empty> : (
          <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0">
            {s.open.map((t) => {
              const r = positionRisk(t, { alarms: s.alarms, perpMark: p.glance?.btc.perpMark ?? null });
              return (
                <li key={`${t.account?.id ?? ''}-${t.tradeId}`}>
                  <ListButton onClick={() => p.openTrade(t.tradeId)} label={`${contractLabel(t.symbol)} ${r.long ? 'buy' : 'sell'}: open the trade`}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[15px] font-semibold">{contractLabel(t.symbol)}</span>
                        <SidePill long={r.long} />
                        {r.problems.length > 0 && <AlertTriangle aria-label="has a problem" className="h-4 w-4 text-[var(--down)]" />}
                      </span>
                      <Rupees usd={t.live?.netIfClosedUsd ?? t.live?.unrealisedPnl ?? null} signed size="sm" />
                    </span>
                    <span className="block text-[12px] text-muted-foreground">
                      {r.stop?.pct != null && Number.isFinite(r.stop.points) ? `SL ${pct(r.stop.pct, 0)} away` : r.perp?.stop ? 'SL on the perp' : 'no stop'}
                      {r.target?.pct != null && Number.isFinite(r.target.points) ? ` · TGT ${pct(r.target.pct, 0)} to go` : ''}
                      {t.account && p.shown === 'all' ? ` · ${t.account.name}` : ''}
                    </span>
                  </ListButton>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={() => p.go({ tab: 'more', sub: 'account' })} className="rounded-lg border border-border bg-background px-3.5 py-3 text-left font-[inherit] text-foreground">
          <span className="block text-[12px] text-muted-foreground">Margin used</span>
          <span className="block text-[18px] font-semibold tabular-nums">{marginShare !== null ? pct(marginShare, 0) : '—'}</span>
          {marginShare !== null && <span className="mt-1.5 block"><Bar value={marginShare} tone={marginShare >= 0.9 ? 'down' : marginShare >= 0.7 ? 'warn' : 'up'} label="Margin used" /></span>}
        </button>
        <button type="button" onClick={() => p.go({ tab: 'more', sub: 'account' })} className="rounded-lg border border-border bg-background px-3.5 py-3 text-left font-[inherit] text-foreground">
          <span className="block text-[12px] text-muted-foreground">Available</span>
          {s?.balanceUsd != null ? <Rupees usd={s.balanceUsd} size="md" /> : <span className="block text-[18px] font-semibold">—</span>}
        </button>
      </div>

      <Panel title="Latest order" right={<button type="button" onClick={() => p.go({ tab: 'orders' })} className="border-0 bg-transparent p-0 font-[inherit] text-[12.5px] text-[var(--accent)]">All →</button>}>
        {!latest ? <Empty>{orders.data ? 'No order today.' : 'Reading orders…'}</Empty> : (
          <ListButton onClick={() => p.openTrade(latest.tradeId)} label="Open the latest order">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-[14px] font-semibold">
                <span className={latest.plan?.action === 'buy' ? 'text-[#3d8bfd]' : 'text-[var(--down)]'}>{latest.plan?.action === 'buy' ? 'BUY' : 'SELL'}</span> {contractLabel(latest.symbol)} × {size(latest.requestedSize)}
              </span>
              {orderStatusWord(latest)}
            </span>
            <span className="block truncate text-[12px] text-muted-foreground">{clock(latest.openedAt)} · {latest.outcome}</span>
          </ListButton>
        )}
      </Panel>
    </>
  );
}

/** One of the four readings across the top of Home. */
function Tile({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'warn' | 'dim' }) {
  return (
    <span className="min-w-0 rounded-lg border border-border bg-background px-2 py-2">
      <span className="block truncate text-[11px] text-muted-foreground">{label}</span>
      <span className={cn('block truncate text-[14px] font-semibold tabular-nums', tone === 'up' && 'text-[var(--up)]', tone === 'warn' && 'text-[var(--warn)]', tone === 'dim' && 'text-muted-foreground')}>{value}</span>
    </span>
  );
}
