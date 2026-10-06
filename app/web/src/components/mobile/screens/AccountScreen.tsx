import type { BrokerAccount } from '@/api/accounts';
import { ago, pct, signedInr, inr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePhone } from '@/components/mobile/phone-context';
import { Bar, Empty, Panel, Rupees, Stat, Stats } from '@/components/mobile/parts';

/**
 * Account (6 Oct 2026): each broker account's money -- wallet, available, margin, open P&L, today -- and whether
 * everything the desk depends on is answering: the account's key, Delta's API, the market data, the scheduler.
 * Never a key or a secret: the server sends only the key's last four, and this screen does not show even that.
 */
export function AccountScreen() {
  const p = usePhone();
  const s = p.status;
  const g = p.glance;
  const parts = s?.combined?.accounts ?? null;
  const shownId = p.shown === 'all' ? p.trading[0]?.id : p.shown;
  const info = p.accounts.find((x) => x.id === shownId) ?? null;
  const d = g?.readings.delta;

  const keyState = (i: BrokerAccount | null) => (!i ? null : !i.readable ? ['down', 'Key unreadable'] : !i.active ? ['dim', 'Switched off'] : i.trading === false ? ['warn', 'Not trading'] : i.lastTest && !i.lastTest.ok ? ['warn', 'Last test failed'] : ['up', 'Connected']) as [Dot, string] | null;

  return (
    <>
      {!s ? <Panel><Empty>Reading the account…</Empty></Panel> : parts && parts.length > 1 ? (
        parts.map((a) => (
          <Money key={a.id} name={a.name} walletUsd={a.totalUsd} availableUsd={a.availableUsd}
            marginUsd={a.totalUsd !== null && a.availableUsd !== null ? Math.max(0, a.totalUsd - a.availableUsd) : null}
            openUsd={a.openPnlUsd} todayUsd={a.netTodayUsd} positions={a.positions} state={keyState(p.accounts.find((x) => x.id === a.id) ?? null)} />
        ))
      ) : (
        <Money name={info?.name ?? 'This account'} walletUsd={s.walletUsd ?? null} availableUsd={s.balanceUsd} marginUsd={s.marginUsedUsd ?? null}
          openUsd={s.unrealisedPnlUsd ?? null} todayUsd={s.today?.netUsd ?? null} positions={s.open.length} chargesUsd={s.today?.chargesUsd ?? null} state={keyState(info)} />
      )}

      <Panel title="Status">
        <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0">
          {(parts && parts.length > 1 ? p.trading : info ? [info] : []).map((a) => {
            const st = keyState(a);
            return st ? <Status key={a.id} label={parts && parts.length > 1 ? a.name : 'Account'} dot={st[0]} value={st[1]} hint={a.lastTest ? `tested ${ago(a.lastTest.at, p.now)}` : undefined} /> : null;
          })}
          <Status label="Delta API" dot={!g ? 'dim' : (d!.failed > 0 || d!.rateLimited > 0) ? 'warn' : 'up'} value={!g ? '…' : d!.rateLimited > 0 ? 'Rate-limited' : d!.failed > 0 ? `${d!.failed} failed` : 'Healthy'} hint={d ? `${d.usedPct}% of quota` : undefined} />
          <Status label="Market data" dot={!g ? 'dim' : g.boardAgeMs === null || g.boardAgeMs >= 60_000 ? 'down' : g.boardAgeMs >= 15_000 ? 'warn' : 'up'} value={!g ? '…' : g.boardAgeMs === null ? 'None yet' : g.boardAgeMs < 15_000 ? 'Live' : `${Math.round(g.boardAgeMs / 1000)} s old`} />
          <Status label="Scheduler" dot={!g ? 'dim' : g.readings.schedulerOn ? 'up' : 'dim'} value={!g ? '…' : g.readings.schedulerOn ? 'ON' : 'OFF'} />
          <Status label="Mode" dot={s?.mode === 'live' ? 'up' : 'dim'} value={s ? (s.mode === 'live' ? 'LIVE' : 'Paper') : '…'} />
        </ul>
      </Panel>
    </>
  );
}

type Dot = 'up' | 'down' | 'warn' | 'dim';

function Status({ label, dot, value, hint }: { label: string; dot: Dot; value: string; hint?: string }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <span className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className={cn('h-2.5 w-2.5 shrink-0 rounded-full', dot === 'up' && 'bg-[var(--up)]', dot === 'down' && 'bg-[var(--down)]', dot === 'warn' && 'bg-[var(--warn)]', dot === 'dim' && 'bg-[var(--dim)]')} />
        <span className="truncate text-[14px]">{label}</span>
      </span>
      <span className="text-right">
        <span className={cn('block text-[14px] font-semibold', dot === 'up' && 'text-[var(--up)]', dot === 'down' && 'text-[var(--down)]', dot === 'warn' && 'text-[var(--warn)]', dot === 'dim' && 'text-muted-foreground')}>{value}</span>
        {hint && <span className="block text-[11.5px] text-muted-foreground">{hint}</span>}
      </span>
    </li>
  );
}

function Money(a: {
  name: string; walletUsd: number | null; availableUsd: number | null; marginUsd: number | null;
  openUsd: number | null; todayUsd: number | null; positions: number; chargesUsd?: number | null; state: [Dot, string] | null;
}) {
  const share = a.marginUsd !== null && a.walletUsd ? a.marginUsd / a.walletUsd : null;
  return (
    <Panel title={a.name} right={a.state ? <span className={cn('text-[12px] font-semibold', a.state[0] === 'up' ? 'text-[var(--up)]' : a.state[0] === 'down' ? 'text-[var(--down)]' : 'text-[var(--warn)]')}>● {a.state[1]}</span> : undefined}>
      <span className="block text-[13px] text-muted-foreground">Total balance</span>
      {a.walletUsd !== null ? <Rupees usd={a.walletUsd} size="xl" /> : <span className="block text-[15px] text-muted-foreground">Not reported on paper</span>}
      <div className="mt-3">
        <Stats>
          <Stat label="Available">{a.availableUsd !== null ? inr(usdToInr(a.availableUsd)) : '—'}</Stat>
          <Stat label="Margin used">{a.marginUsd !== null ? `${inr(usdToInr(a.marginUsd))}${share !== null ? ` · ${pct(share, 0)}` : ''}` : '—'}</Stat>
          <Stat label={`Open P&L · ${a.positions}`} tone={a.openUsd ? (a.openUsd > 0 ? 'up' : 'down') : undefined}>{a.openUsd !== null ? signedInr(usdToInr(a.openUsd)) : '—'}</Stat>
          <Stat label="Today's P&L" tone={a.todayUsd ? (a.todayUsd > 0 ? 'up' : 'down') : undefined}>{a.todayUsd !== null ? signedInr(usdToInr(a.todayUsd)) : '—'}</Stat>
          {a.chargesUsd != null && <Stat label="Today's charges" tone={a.chargesUsd ? 'down' : undefined}>{signedInr(usdToInr(-a.chargesUsd))}</Stat>}
        </Stats>
      </div>
      {share !== null && (
        <div className="mt-3">
          <div className="mb-1 text-[12px] text-muted-foreground">Margin used {pct(share, 0)} of the wallet</div>
          <Bar value={share} tone={share >= 0.9 ? 'down' : share >= 0.7 ? 'warn' : 'up'} label="Margin used" />
        </div>
      )}
    </Panel>
  );
}
